"""
LSTM AutoEncoder anomaly detector -- Keras/TF backend.

Architecture: LSTM encoder-decoder (sequence-to-sequence reconstruction).
Each window of ``sequence_length`` timesteps is encoded to a latent vector
then reconstructed.  Anomaly score = per-window MSE averaged over timesteps
and features, assigned to the **last** sample of each window.

Export:
  - lstm_autoencoder.tflite      -- float32 or INT8-quantised TFLite model
  - lstm_autoencoder_config.json -- threshold + shape metadata (JSON)
  - fovet_lstm_autoencoder_model.h -- C byte-array for TFLite Micro

Usage:
    from forge.detectors.lstm_autoencoder import LSTMAutoEncoderDetector
    d = LSTMAutoEncoderDetector(cfg)
    d.fit(train_ds)
    result = d.predict(test_ds)
    d.export(Path("models"), stem="vibration")
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from forge.config import LSTMAutoEncoderDetectorConfig, Quantization
from forge.data.base import Dataset
from forge.detectors.base import Detector, DetectionResult

# Maximum number of calibration windows stored for INT8 quantisation
_MAX_CALIBRATION_SAMPLES = 256


def _make_sequences(X: np.ndarray, seq_len: int) -> np.ndarray:
    """Sliding-window sequences from a 2-D array.

    Args:
        X:       Shape ``(n_samples, n_features)``, float32.
        seq_len: Number of timesteps per window.

    Returns:
        Shape ``(n_windows, seq_len, n_features)`` where
        ``n_windows = n_samples - seq_len + 1``.

    Raises:
        ValueError: If ``n_samples < seq_len``.
    """
    n = len(X)
    if n < seq_len:
        raise ValueError(
            f"Dataset has only {n} samples but sequence_length={seq_len}. "
            "Provide at least sequence_length samples."
        )
    n_windows = n - seq_len + 1
    # Stack without a Python loop using stride tricks for large arrays
    indices = np.arange(seq_len)[None, :] + np.arange(n_windows)[:, None]
    return X[indices]  # (n_windows, seq_len, n_features)


class LSTMAutoEncoderDetector(Detector):
    """Anomaly detector based on an LSTM autoencoder (Keras).

    Uses sliding windows of ``sequence_length`` timesteps.
    Score = MSE between input window and its reconstruction.
    Decision threshold = ``threshold_percentile``-th percentile of training scores.

    Score assignment:
        - Window *j* covers samples ``[j, j+seq_len-1]``; its MSE score is
          assigned to sample ``j + seq_len - 1`` (the window's last sample).
        - The first ``sequence_length - 1`` samples have no complete window and
          receive score ``0.0`` (treated as non-anomalous).
    """

    def __init__(self, config: LSTMAutoEncoderDetectorConfig) -> None:
        self.config = config
        self._model = None              # keras.Model, set after fit()
        self._columns: list[str] = []
        self._n_features: int = 0
        self._threshold: float | None = None
        self._calibration_data: np.ndarray | None = None  # for INT8 quantisation

    # ------------------------------------------------------------------
    # Detector interface
    # ------------------------------------------------------------------

    def fit(self, dataset: Dataset) -> None:
        """Build and train the LSTM autoencoder on *clean* data."""
        import tensorflow as tf  # noqa: PLC0415  (lazy import)
        from tensorflow import keras  # noqa: PLC0415

        X = dataset.samples.astype(np.float32)
        seq_len = self.config.sequence_length
        n_features = X.shape[1]
        self._n_features = n_features
        self._columns = list(dataset.columns)

        X_seq = _make_sequences(X, seq_len)  # (n_windows, seq_len, n_features)

        # Save a representative subset for optional INT8 calibration
        rng = np.random.default_rng(42)
        idx = rng.choice(len(X_seq), size=min(_MAX_CALIBRATION_SAMPLES, len(X_seq)), replace=False)
        self._calibration_data = X_seq[idx]

        # Build LSTM encoder-decoder.
        # unroll=True is required for TFLite export: it statically unrolls the
        # recurrent loop, avoiding TensorListReserve ops that are incompatible
        # with TFLite's standard conversion and INT8 quantisation pipeline.
        inputs = keras.Input(shape=(seq_len, n_features), name="input")
        # Encoder: compress sequence to latent vector
        encoded = keras.layers.LSTM(
            self.config.latent_dim, return_sequences=False, name="encoder", unroll=True
        )(inputs)
        # Repeat latent vector seq_len times for decoder input
        repeated = keras.layers.RepeatVector(seq_len, name="repeat")(encoded)
        # Decoder: reconstruct sequence from repeated latent
        decoded = keras.layers.LSTM(
            self.config.latent_dim, return_sequences=True, name="decoder_lstm", unroll=True
        )(repeated)
        outputs = keras.layers.TimeDistributed(
            keras.layers.Dense(n_features, activation="linear"), name="decoder"
        )(decoded)

        self._model = keras.Model(inputs, outputs, name="fovet_lstm_autoencoder")
        self._model.compile(optimizer="adam", loss="mse")
        self._model.fit(
            X_seq,
            X_seq,
            epochs=self.config.epochs,
            batch_size=self.config.batch_size,
            verbose=0,
            shuffle=True,
        )

        # Derive decision threshold from training-set reconstruction errors
        train_scores = self._compute_scores(X)
        self._threshold = float(
            np.percentile(train_scores, self.config.threshold_percentile)
        )

    def score(self, dataset: Dataset) -> np.ndarray:
        """Return per-sample MSE reconstruction error (float32, higher = more anomalous).

        The first ``sequence_length - 1`` samples receive score ``0.0``.
        """
        self._check_fitted()
        return self._compute_scores(dataset.samples.astype(np.float32))

    def predict(self, dataset: Dataset) -> DetectionResult:
        """Return binary anomaly labels and per-sample scores."""
        self._check_fitted()
        scores = self.score(dataset)
        labels = (scores > self._threshold).astype(np.int8)
        return DetectionResult(
            scores=scores,
            labels=labels,
            threshold=self._threshold,
            detector_name="lstm_autoencoder",
        )

    # ------------------------------------------------------------------
    # Export
    # ------------------------------------------------------------------

    def export(
        self,
        output_dir: Path,
        stem: str,
        quantization: Quantization = Quantization.float32,
        **_kwargs,
    ) -> list[Path]:
        """Export the trained LSTM autoencoder.

        Writes:
          - ``lstm_autoencoder.tflite``       -- TFLite model (float32 or INT8)
          - ``lstm_autoencoder_config.json``  -- metadata + decision threshold
          - ``fovet_lstm_autoencoder_model.h`` -- C byte-array (TFLite Micro)

        Args:
            output_dir:    Destination directory (created if absent).
            stem:          Pipeline name, embedded in the JSON metadata.
            quantization:  ``float32`` (default) or ``int8``.

        Returns:
            List of written file paths.
        """
        self._check_fitted()
        output_dir.mkdir(parents=True, exist_ok=True)
        written: list[Path] = []

        tflite_bytes = self._convert_to_tflite(quantization)

        # --- lstm_autoencoder.tflite -------------------------------------
        tflite_path = output_dir / "lstm_autoencoder.tflite"
        tflite_path.write_bytes(tflite_bytes)
        written.append(tflite_path)

        # --- lstm_autoencoder_config.json ---------------------------------
        meta = {
            "detector": "lstm_autoencoder",
            "pipeline": stem,
            "features": self._columns,
            "n_features": self._n_features,
            "sequence_length": self.config.sequence_length,
            "latent_dim": self.config.latent_dim,
            "threshold_percentile": self.config.threshold_percentile,
            "decision_threshold": self._threshold,
            "quantization": quantization.value,
            "score_assignment": (
                "MSE score assigned to last sample of each window. "
                f"First {self.config.sequence_length - 1} samples score 0.0."
            ),
            "note": (
                "anomaly_score = MSE(window, reconstruct(window)).  "
                "Score > decision_threshold -> anomaly.  "
                "Load lstm_autoencoder.tflite with TFLite Micro on the target MCU."
            ),
        }
        json_path = output_dir / "lstm_autoencoder_config.json"
        json_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")
        written.append(json_path)

        # --- fovet_lstm_autoencoder_model.h ------------------------------
        header_path = output_dir / "fovet_lstm_autoencoder_model.h"
        header_path.write_text(
            self._generate_c_header(tflite_bytes), encoding="utf-8"
        )
        written.append(header_path)

        return written

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _compute_scores(self, X: np.ndarray) -> np.ndarray:
        """Per-sample MSE score, padded with 0 for the first seq_len-1 samples."""
        seq_len = self.config.sequence_length
        X_seq = _make_sequences(X, seq_len)   # (n_windows, seq_len, n_features)
        reconstructed = self._model.predict(X_seq, verbose=0)
        # MSE per window: mean over timesteps (axis=1) and features (axis=2)
        seq_scores = np.mean((X_seq - reconstructed) ** 2, axis=(1, 2)).astype(np.float32)
        # Assign window score to its last sample; pad the head with 0.0
        n = len(X)
        full_scores = np.zeros(n, dtype=np.float32)
        full_scores[seq_len - 1:] = seq_scores
        return full_scores

    def _convert_to_tflite(self, quantization: Quantization) -> bytes:
        """Convert the Keras model to TFLite bytes (float32 or INT8).

        Because the LSTM layers are built with ``unroll=True``, the recurrent
        loop is statically unrolled and TensorListReserve is never emitted.
        Standard TFLITE_BUILTINS conversion works without SELECT_TF_OPS.
        """
        import tensorflow as tf  # noqa: PLC0415

        converter = tf.lite.TFLiteConverter.from_keras_model(self._model)

        if quantization == Quantization.int8:
            converter.optimizations = [tf.lite.Optimize.DEFAULT]
            calib = self._calibration_data  # (N, seq_len, n_features)

            def representative_dataset():
                for window in calib:
                    yield [window[np.newaxis].astype(np.float32)]

            converter.representative_dataset = representative_dataset
            converter.target_spec.supported_ops = [tf.lite.OpsSet.TFLITE_BUILTINS_INT8]
            converter.inference_input_type = tf.int8
            converter.inference_output_type = tf.int8

        return converter.convert()

    def _generate_c_header(self, tflite_bytes: bytes) -> str:
        """Generate a C header embedding the TFLite model as a byte array."""
        guard = "FOVET_LSTM_AUTOENCODER_MODEL_H"
        hex_bytes = ", ".join(f"0x{b:02x}" for b in tflite_bytes)
        columns_comment = ", ".join(self._columns)
        return (
            "/*\n"
            " * Fovet SDK -- Sentinelle\n"
            " * Copyright (C) 2026 Antoine Porte. All rights reserved.\n"
            " * LGPL v3 for non-commercial use.\n"
            " * Commercial licensing: contact@fovet.eu\n"
            " *\n"
            " * Auto-generated by Fovet Forge -- do not edit manually.\n"
            f" * Features       : {columns_comment}\n"
            f" * Sequence length: {self.config.sequence_length}\n"
            f" * Latent dim     : {self.config.latent_dim}\n"
            f" * Threshold      : {self._threshold:.6f}f  (MSE > threshold = anomaly)\n"
            " */\n\n"
            f"#ifndef {guard}\n"
            f"#define {guard}\n\n"
            "#include <stdint.h>\n\n"
            "// TFLite Micro model -- load with tflite::MicroInterpreter\n"
            f"const uint8_t g_lstm_autoencoder_model_data[] = {{\n  {hex_bytes}\n}};\n"
            f"const unsigned int g_lstm_autoencoder_model_data_len = {len(tflite_bytes)}U;\n\n"
            f"// Inference parameters\n"
            f"const float g_lstm_autoencoder_threshold = {self._threshold:.6f}f;\n"
            f"const int   g_lstm_autoencoder_seq_len   = {self.config.sequence_length};\n"
            f"const int   g_lstm_autoencoder_n_features = {self._n_features};\n\n"
            f"#endif  // {guard}\n"
        )

    def _check_fitted(self) -> None:
        if self._model is None:
            raise RuntimeError("LSTMAutoEncoderDetector must be fitted before use.")
