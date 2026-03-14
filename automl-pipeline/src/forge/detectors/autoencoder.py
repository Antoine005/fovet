"""
AutoEncoder anomaly detector -- Keras/TF backend.

Architecture: Dense encoder-decoder (fully-connected, no recurrence).
Each sample (n_features,) is independently encoded to latent_dim then
reconstructed.  Anomaly score = per-sample MSE.

Export:
  - autoencoder.tflite      -- float32 or INT8-quantised TFLite model
  - autoencoder_config.json -- threshold + shape metadata (JSON)
  - fovet_autoencoder_model.h (optional) -- C byte-array for TFLite Micro

Usage:
    from forge.detectors.autoencoder import AutoEncoderDetector
    d = AutoEncoderDetector(cfg)
    d.fit(train_ds)
    result = d.predict(test_ds)
    d.export(Path("models"), stem="vibration")
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from forge.config import AutoEncoderDetectorConfig, Quantization
from forge.data.base import Dataset
from forge.detectors.base import Detector, DetectionResult

# Maximum number of calibration samples stored for INT8 quantisation
_MAX_CALIBRATION_SAMPLES = 256


class AutoEncoderDetector(Detector):
    """Anomaly detector based on a Dense autoencoder (Keras).

    Score = MSE between the input and its reconstruction.
    Decision threshold = ``threshold_percentile``-th percentile of training scores.
    """

    def __init__(self, config: AutoEncoderDetectorConfig) -> None:
        self.config = config
        self._model = None            # keras.Model, set after fit()
        self._columns: list[str] = []
        self._n_features: int = 0
        self._threshold: float | None = None
        self._calibration_data: np.ndarray | None = None  # for INT8 quantisation

    # ------------------------------------------------------------------
    # Detector interface
    # ------------------------------------------------------------------

    def fit(self, dataset: Dataset) -> None:
        """Build and train the autoencoder on *clean* data."""
        import tensorflow as tf  # noqa: PLC0415  (lazy import)
        from tensorflow import keras  # noqa: PLC0415

        X = dataset.samples.astype(np.float32)
        n_features = X.shape[1]
        self._n_features = n_features
        self._columns = list(dataset.columns)

        # Save a representative subset for optional INT8 calibration
        idx = np.random.default_rng(42).choice(
            len(X), size=min(_MAX_CALIBRATION_SAMPLES, len(X)), replace=False
        )
        self._calibration_data = X[idx]

        # Build dense autoencoder
        inputs = keras.Input(shape=(n_features,), name="input")
        encoded = keras.layers.Dense(
            self.config.latent_dim, activation="relu", name="encoder"
        )(inputs)
        decoded = keras.layers.Dense(
            n_features, activation="linear", name="decoder"
        )(encoded)
        self._model = keras.Model(inputs, decoded, name="fovet_autoencoder")

        self._model.compile(optimizer="adam", loss="mse")
        self._model.fit(
            X,
            X,
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
        """Return MSE reconstruction error per sample (float32, higher = more anomalous)."""
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
            detector_name="autoencoder",
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
        """Export the trained autoencoder.

        Writes:
          - ``autoencoder.tflite``       -- TFLite model (float32 or INT8)
          - ``autoencoder_config.json``  -- metadata + decision threshold
          - ``fovet_autoencoder_model.h`` -- C byte-array (TFLite Micro)

        Args:
            output_dir: Destination directory (created if absent).
            stem: Pipeline name, embedded in the JSON metadata.
            quantization: ``float32`` (default) or ``int8``.

        Returns:
            List of written file paths.
        """
        self._check_fitted()
        output_dir.mkdir(parents=True, exist_ok=True)
        written: list[Path] = []

        tflite_bytes = self._convert_to_tflite(quantization)

        # --- autoencoder.tflite ------------------------------------------
        tflite_path = output_dir / "autoencoder.tflite"
        tflite_path.write_bytes(tflite_bytes)
        written.append(tflite_path)

        # --- autoencoder_config.json -------------------------------------
        meta = {
            "detector": "autoencoder",
            "pipeline": stem,
            "features": self._columns,
            "n_features": self._n_features,
            "latent_dim": self.config.latent_dim,
            "threshold_percentile": self.config.threshold_percentile,
            "decision_threshold": self._threshold,
            "quantization": quantization.value,
            "note": (
                "anomaly_score = MSE(x, reconstruct(x)).  "
                "Score > decision_threshold -> anomaly.  "
                "Load autoencoder.tflite with TFLite Micro on the target MCU."
            ),
        }
        json_path = output_dir / "autoencoder_config.json"
        json_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")
        written.append(json_path)

        # --- fovet_autoencoder_model.h -----------------------------------
        header_path = output_dir / "fovet_autoencoder_model.h"
        header_path.write_text(
            self._generate_c_header(tflite_bytes), encoding="utf-8"
        )
        written.append(header_path)

        return written

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _compute_scores(self, X: np.ndarray) -> np.ndarray:
        """MSE per sample between input and autoencoder reconstruction."""
        reconstructed = self._model.predict(X, verbose=0)
        return np.mean((X - reconstructed) ** 2, axis=1).astype(np.float32)

    def _convert_to_tflite(self, quantization: Quantization) -> bytes:
        """Convert the Keras model to TFLite bytes (float32 or INT8)."""
        import tensorflow as tf  # noqa: PLC0415

        converter = tf.lite.TFLiteConverter.from_keras_model(self._model)

        if quantization == Quantization.int8:
            converter.optimizations = [tf.lite.Optimize.DEFAULT]
            calib = self._calibration_data  # captured at fit time

            def representative_dataset():
                for sample in calib:
                    yield [sample.reshape(1, -1)]

            converter.representative_dataset = representative_dataset
            converter.target_spec.supported_ops = [tf.lite.OpsSet.TFLITE_BUILTINS_INT8]
            converter.inference_input_type = tf.int8
            converter.inference_output_type = tf.int8

        return converter.convert()

    def _generate_c_header(self, tflite_bytes: bytes) -> str:
        """Generate a C header embedding the TFLite model as a byte array."""
        guard = "FOVET_AUTOENCODER_MODEL_H"
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
            f" * Features : {columns_comment}\n"
            f" * Latent dim: {self.config.latent_dim}\n"
            f" * Threshold : {self._threshold:.6f}f  (MSE > threshold = anomaly)\n"
            " */\n\n"
            f"#ifndef {guard}\n"
            f"#define {guard}\n\n"
            "#include <stdint.h>\n\n"
            "// TFLite Micro model -- load with tflite::MicroInterpreter\n"
            f"const uint8_t g_autoencoder_model_data[] = {{\n  {hex_bytes}\n}};\n"
            f"const unsigned int g_autoencoder_model_data_len = {len(tflite_bytes)}U;\n\n"
            f"// Decision threshold: anomaly if reconstruction MSE > threshold\n"
            f"const float g_autoencoder_threshold = {self._threshold:.6f}f;\n\n"
            f"#endif  // {guard}\n"
        )

    def _check_fitted(self) -> None:
        if self._model is None:
            raise RuntimeError("AutoEncoderDetector must be fitted before use.")
