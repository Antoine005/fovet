"""
Fovet SDK — Sentinelle
Copyright (C) 2026 Antoine Porte. All rights reserved.
LGPL v3 for non-commercial use.
Commercial licensing: contact@fovet.eu

-------------------------------------------------------------------------
fall_detection.py — Supervised fall-detection pipeline (Phase H1.2)

Feature extraction (10 features on sliding window over IMU magnitude):
  magnitude_mean, magnitude_std, magnitude_min, magnitude_max,
  magnitude_rms, magnitude_kurtosis, magnitude_skewness,
  zero_crossing_rate, peak_to_peak, signal_energy

Model: lightweight dense binary classifier (Keras).
  Input  → Dense(16, relu) → Dense(8, relu) → Dense(1, sigmoid)
  Target RAM footprint: < 32 KB after INT8 quantization.

Export (in output_dir/):
  fall_detection.tflite          — INT8-quantized TFLite model
  fall_detection_model.h         — C header (TFLite Micro byte array)
  fall_detection_model.cc        — C++ source (byte array definition)
  fall_detection_config.json     — metadata (threshold, n_features, …)
  fall_detection_report.json     — evaluation report (precision, recall, …)

Usage (synthetic data, no real dataset required):
  from forge.pipelines.fall_detection import FallDetectionPipeline, synthesize_fall_data
  data = synthesize_fall_data(n_normal=2000, n_fall=400)
  pipeline = FallDetectionPipeline()
  pipeline.fit(data)
  report = pipeline.evaluate(data)
  pipeline.export(Path("models/fall_detection"))

Usage with real UP-Fall / KFall data:
  from forge.datasets import load_parsed, DATASETS
  df = load_parsed(Path("datasets/human"), "up_fall")
  pipeline = FallDetectionPipeline()
  pipeline.fit(df, label_col="label")
  pipeline.export(Path("models/fall_detection"))
-------------------------------------------------------------------------
"""

from __future__ import annotations

import json
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Sequence

import numpy as np
import pandas as pd
from scipy import stats as scipy_stats  # kurtosis, skewness

# Feature names — fixed order, must match _extract_window()
FEATURE_NAMES: list[str] = [
    "magnitude_mean",
    "magnitude_std",
    "magnitude_min",
    "magnitude_max",
    "magnitude_rms",
    "magnitude_kurtosis",
    "magnitude_skewness",
    "zero_crossing_rate",
    "peak_to_peak",
    "signal_energy",
]

N_FEATURES = len(FEATURE_NAMES)  # 10

# Default window / model parameters
DEFAULT_WINDOW_SAMPLES = 50    # ~50 ms at 1 kHz, or ~2 s at 25 Hz
DEFAULT_STEP_SAMPLES   = 25    # 50% overlap
DEFAULT_THRESHOLD      = 0.5   # binary decision threshold
_MAX_CALIB_SAMPLES     = 256   # max samples for INT8 calibration

# ---------------------------------------------------------------------------
# Feature extraction
# ---------------------------------------------------------------------------

def _compute_magnitude(
    ax: np.ndarray,
    ay: np.ndarray,
    az: np.ndarray,
) -> np.ndarray:
    """Compute 3-axis acceleration magnitude: sqrt(ax² + ay² + az²)."""
    return np.sqrt(ax ** 2 + ay ** 2 + az ** 2)


def _extract_window(mag: np.ndarray) -> np.ndarray:
    """Extract the 10 features from a single magnitude window.

    Args:
        mag: 1-D array of acceleration magnitudes (g) for one window.

    Returns:
        Feature vector of length N_FEATURES (10).
    """
    n = len(mag)
    if n == 0:
        return np.zeros(N_FEATURES, dtype=np.float32)

    mean_val = float(np.mean(mag))
    std_val  = float(np.std(mag))
    min_val  = float(np.min(mag))
    max_val  = float(np.max(mag))
    rms      = float(np.sqrt(np.mean(mag ** 2)))
    kurt     = float(scipy_stats.kurtosis(mag))      # Fisher (excess kurtosis)
    skew     = float(scipy_stats.skew(mag))

    # Zero-crossing rate on mean-centred signal
    centred  = mag - mean_val
    zcr      = float(np.sum(np.diff(np.sign(centred)) != 0)) / max(n - 1, 1)

    peak2peak = max_val - min_val
    energy    = float(np.sum(mag ** 2)) / n

    return np.array(
        [mean_val, std_val, min_val, max_val, rms, kurt, skew, zcr, peak2peak, energy],
        dtype=np.float32,
    )


def extract_features(
    df: pd.DataFrame,
    *,
    window_samples: int = DEFAULT_WINDOW_SAMPLES,
    step_samples: int   = DEFAULT_STEP_SAMPLES,
    ax_col: str  = "value_1",
    ay_col: str  = "value_2",
    az_col: str  = "value_3",
    label_col: str | None = "label",
) -> tuple[np.ndarray, np.ndarray | None]:
    """Slide a window over a Fovet IMU DataFrame and extract features.

    Args:
        df:             Fovet-format DataFrame with columns value_1/2/3 (acc XYZ).
        window_samples: Number of samples per window.
        step_samples:   Stride between windows.
        ax_col, ay_col, az_col: Column names for X/Y/Z acceleration.
        label_col:      Column with binary labels (1=fall, 0=normal).
                        If None or column absent, labels array is None.

    Returns:
        Tuple of:
          - X: float32 array, shape (n_windows, N_FEATURES)
          - y: int32 array, shape (n_windows,), or None if no label column.

    Raises:
        ValueError: If window_samples < 2 or required columns are missing.
    """
    if window_samples < 2:
        raise ValueError(f"window_samples must be >= 2, got {window_samples}")

    for col in (ax_col, ay_col, az_col):
        if col not in df.columns:
            raise ValueError(f"Column '{col}' not found in DataFrame")

    ax  = df[ax_col].to_numpy(dtype=np.float64)
    ay  = df[ay_col].to_numpy(dtype=np.float64)
    az  = df[az_col].to_numpy(dtype=np.float64)
    mag = _compute_magnitude(ax, ay, az)

    has_labels = label_col is not None and label_col in df.columns
    labels_raw = df[label_col].to_numpy(dtype=np.int32) if has_labels else None

    n = len(mag)
    if n < window_samples:
        raise ValueError(
            f"DataFrame has only {n} rows, but window_samples={window_samples}. "
            "Need at least window_samples rows."
        )

    X_list: list[np.ndarray] = []
    y_list: list[int] = []

    start = 0
    while start + window_samples <= n:
        end = start + window_samples
        X_list.append(_extract_window(mag[start:end]))

        if has_labels and labels_raw is not None:
            window_label = int(np.max(labels_raw[start:end]))
            y_list.append(window_label)

        start += step_samples

    X = np.stack(X_list).astype(np.float32)
    y = np.array(y_list, dtype=np.int32) if has_labels else None
    return X, y


# ---------------------------------------------------------------------------
# Synthetic data generator (no real dataset required)
# ---------------------------------------------------------------------------

def synthesize_fall_data(
    n_normal: int = 2000,
    n_fall:   int = 400,
    *,
    sample_rate_hz: int  = 25,
    rng: np.random.Generator | None = None,
) -> pd.DataFrame:
    """Generate a synthetic Fovet-format IMU DataFrame with fall events.

    Normal activity: low-amplitude random walk + gravity component (az ≈ 1g).
    Fall event: pre-fall random motion → sharp impact spike → stillness.

    Args:
        n_normal:       Number of normal-activity samples.
        n_fall:         Number of fall-event samples.
        sample_rate_hz: Simulated sampling rate (for timestamp generation).
        rng:            NumPy random Generator (reproducibility).

    Returns:
        DataFrame with columns: timestamp_ms, sensor_type, value_1, value_2,
        value_3, label (0=normal, 1=fall).
    """
    if rng is None:
        rng = np.random.default_rng(42)

    dt_ms = int(1000 / sample_rate_hz)

    # ---- normal activity ------------------------------------------------
    ax_n = rng.normal(0.0, 0.05, n_normal).astype(np.float32)
    ay_n = rng.normal(0.0, 0.05, n_normal).astype(np.float32)
    az_n = rng.normal(1.0, 0.05, n_normal).astype(np.float32)  # ~1g gravity
    ts_n = np.arange(n_normal, dtype=np.int64) * dt_ms
    lab_n = np.zeros(n_normal, dtype=np.int32)

    # ---- fall event (3-phase: pre / impact / still) ---------------------
    phase_pre    = max(1, n_fall // 4)
    phase_impact = max(1, n_fall // 8)
    phase_still  = n_fall - phase_pre - phase_impact

    # Pre-fall: elevated motion
    ax_pre = rng.uniform(-0.3, 0.3, phase_pre).astype(np.float32)
    ay_pre = rng.uniform(-0.3, 0.3, phase_pre).astype(np.float32)
    az_pre = (rng.normal(0.8, 0.2, phase_pre)).astype(np.float32)

    # Impact: sharp spike (~5–8g total magnitude)
    impact_t = np.linspace(0, np.pi, phase_impact)
    ax_imp = (4.0 * np.sin(impact_t) + rng.normal(0, 0.1, phase_impact)).astype(np.float32)
    ay_imp = (3.0 * np.sin(impact_t) + rng.normal(0, 0.1, phase_impact)).astype(np.float32)
    az_imp = (2.0 * np.sin(impact_t) + rng.normal(0, 0.1, phase_impact)).astype(np.float32)

    # Post-fall: stillness
    ax_still = rng.normal(0.0, 0.02, phase_still).astype(np.float32)
    ay_still = rng.normal(0.0, 0.02, phase_still).astype(np.float32)
    az_still = rng.normal(0.2, 0.02, phase_still).astype(np.float32)

    ax_f = np.concatenate([ax_pre, ax_imp, ax_still])
    ay_f = np.concatenate([ay_pre, ay_imp, ay_still])
    az_f = np.concatenate([az_pre, az_imp, az_still])
    ts_f = np.arange(n_fall, dtype=np.int64) * dt_ms + ts_n[-1] + dt_ms
    lab_f = np.ones(n_fall, dtype=np.int32)

    ax  = np.concatenate([ax_n, ax_f])
    ay  = np.concatenate([ay_n, ay_f])
    az  = np.concatenate([az_n, az_f])
    ts  = np.concatenate([ts_n, ts_f])
    lab = np.concatenate([lab_n, lab_f])

    return pd.DataFrame({
        "timestamp_ms": ts,
        "sensor_type":  "imu",
        "value_1":      ax,
        "value_2":      ay,
        "value_3":      az,
        "label":        lab,
    })


# ---------------------------------------------------------------------------
# Evaluation report
# ---------------------------------------------------------------------------

@dataclass
class FallDetectionReport:
    """Evaluation report for the fall detection model."""

    accuracy:          float
    precision:         float
    recall:            float
    f1:                float
    confusion_matrix:  list[list[int]]  # [[TN, FP], [FN, TP]]
    n_samples:         int
    n_fall_samples:    int
    n_normal_samples:  int
    threshold:         float
    n_features:        int
    model_size_bytes:  int | None = None

    def meets_spec(self) -> bool:
        """Return True if precision ≥ 92% and recall ≥ 90%."""
        return self.precision >= 0.92 and self.recall >= 0.90

    def as_dict(self) -> dict:
        return asdict(self)

    def __str__(self) -> str:
        cm = self.confusion_matrix
        lines = [
            "=== Fall Detection Evaluation ===",
            f"  Accuracy  : {self.accuracy:.1%}",
            f"  Precision : {self.precision:.1%}  (spec: ≥ 92%)",
            f"  Recall    : {self.recall:.1%}",
            f"  F1-score  : {self.f1:.1%}",
            "",
            "  Confusion matrix (rows=actual, cols=predicted):",
            "              Pred-Normal  Pred-Fall",
            f"  Act-Normal     {cm[0][0]:>7}    {cm[0][1]:>7}",
            f"  Act-Fall       {cm[1][0]:>7}    {cm[1][1]:>7}",
            "",
            f"  Samples   : {self.n_samples} ({self.n_fall_samples} fall, {self.n_normal_samples} normal)",
        ]
        if self.model_size_bytes is not None:
            lines.append(f"  TFLite size: {self.model_size_bytes:,} bytes ({self.model_size_bytes / 1024:.1f} KB)")
        lines.append(f"  Meets spec : {'YES ✓' if self.meets_spec() else 'NO ✗'}")
        return "\n".join(lines)


def _compute_report(
    y_true: np.ndarray,
    y_pred: np.ndarray,
    threshold: float,
    n_features: int,
    model_size_bytes: int | None = None,
) -> FallDetectionReport:
    y_bin = (y_pred >= threshold).astype(np.int32)

    tp = int(np.sum((y_bin == 1) & (y_true == 1)))
    tn = int(np.sum((y_bin == 0) & (y_true == 0)))
    fp = int(np.sum((y_bin == 1) & (y_true == 0)))
    fn = int(np.sum((y_bin == 0) & (y_true == 1)))

    precision = tp / (tp + fp) if (tp + fp) > 0 else 0.0
    recall    = tp / (tp + fn) if (tp + fn) > 0 else 0.0
    f1        = (2 * precision * recall / (precision + recall)
                 if (precision + recall) > 0 else 0.0)
    accuracy  = (tp + tn) / len(y_true) if len(y_true) > 0 else 0.0

    return FallDetectionReport(
        accuracy          = accuracy,
        precision         = precision,
        recall            = recall,
        f1                = f1,
        confusion_matrix  = [[tn, fp], [fn, tp]],
        n_samples         = len(y_true),
        n_fall_samples    = int(np.sum(y_true == 1)),
        n_normal_samples  = int(np.sum(y_true == 0)),
        threshold         = threshold,
        n_features        = n_features,
        model_size_bytes  = model_size_bytes,
    )


# ---------------------------------------------------------------------------
# FallDetectionPipeline
# ---------------------------------------------------------------------------

class FallDetectionPipeline:
    """End-to-end fall detection pipeline: feature extraction → training → export.

    Architecture:
        Input(10) → Dense(16, relu) → Dense(8, relu) → Dense(1, sigmoid)

    Args:
        window_samples: Sliding window length (default 50 samples).
        step_samples:   Window stride (default 25 — 50% overlap).
        threshold:      Binary decision threshold (default 0.5).
        epochs:         Training epochs (default 30).
        batch_size:     Training batch size (default 32).
    """

    def __init__(
        self,
        window_samples: int   = DEFAULT_WINDOW_SAMPLES,
        step_samples:   int   = DEFAULT_STEP_SAMPLES,
        threshold:      float = DEFAULT_THRESHOLD,
        epochs:         int   = 30,
        batch_size:     int   = 32,
    ) -> None:
        self.window_samples = window_samples
        self.step_samples   = step_samples
        self.threshold      = threshold
        self.epochs         = epochs
        self.batch_size     = batch_size

        self._model                          = None      # keras.Model
        self._scaler_mean: np.ndarray | None = None
        self._scaler_std:  np.ndarray | None = None
        self._calibration_data: np.ndarray | None = None
        self._fitted: bool                   = False

    # ------------------------------------------------------------------
    # Feature normalisation (z-score, fit on training data)
    # ------------------------------------------------------------------

    def _scale_fit(self, X: np.ndarray) -> None:
        self._scaler_mean = X.mean(axis=0)
        self._scaler_std  = np.where(X.std(axis=0) < 1e-8, 1.0, X.std(axis=0))

    def _scale_transform(self, X: np.ndarray) -> np.ndarray:
        assert self._scaler_mean is not None and self._scaler_std is not None
        return ((X - self._scaler_mean) / self._scaler_std).astype(np.float32)

    # ------------------------------------------------------------------
    # fit
    # ------------------------------------------------------------------

    def fit(
        self,
        df: pd.DataFrame,
        *,
        label_col: str = "label",
        val_split: float = 0.2,
        verbose: int = 0,
    ) -> "FallDetectionPipeline":
        """Extract features, scale, and train the binary classifier.

        Args:
            df:        Fovet-format IMU DataFrame (value_1/2/3 = ax/ay/az).
            label_col: Column with binary labels (1=fall, 0=normal).
            val_split: Fraction of data used for validation.
            verbose:   Keras verbosity (0 = silent).

        Returns:
            self (for chaining).
        """
        import tensorflow as tf  # noqa: PLC0415
        from tensorflow import keras  # noqa: PLC0415

        X, y = extract_features(
            df,
            window_samples=self.window_samples,
            step_samples=self.step_samples,
            label_col=label_col,
        )
        if y is None:
            raise ValueError("label_col not found in DataFrame — supervised training requires labels")

        self._scale_fit(X)
        Xs = self._scale_transform(X)

        # Save calibration samples for INT8 quantization
        rng = np.random.default_rng(42)
        idx = rng.choice(len(Xs), size=min(_MAX_CALIB_SAMPLES, len(Xs)), replace=False)
        self._calibration_data = Xs[idx]

        # Build model
        inputs  = keras.Input(shape=(N_FEATURES,), name="input")
        hidden1 = keras.layers.Dense(16, activation="relu", name="dense1")(inputs)
        hidden2 = keras.layers.Dense(8,  activation="relu", name="dense2")(hidden1)
        output  = keras.layers.Dense(1,  activation="sigmoid", name="output")(hidden2)
        self._model = keras.Model(inputs, output, name="fovet_fall_detection")

        self._model.compile(
            optimizer="adam",
            loss="binary_crossentropy",
            metrics=["accuracy"],
        )

        y_f = y.astype(np.float32)
        self._model.fit(
            Xs, y_f,
            epochs=self.epochs,
            batch_size=self.batch_size,
            validation_split=val_split,
            verbose=verbose,
        )

        self._fitted = True
        return self

    # ------------------------------------------------------------------
    # predict
    # ------------------------------------------------------------------

    def predict_proba(self, df: pd.DataFrame) -> np.ndarray:
        """Return fall probability scores for each window (0–1).

        Args:
            df: Fovet-format IMU DataFrame.

        Returns:
            1-D float32 array of probabilities, one per window.

        Raises:
            RuntimeError: If fit() has not been called.
        """
        if not self._fitted or self._model is None:
            raise RuntimeError("Pipeline not fitted — call fit() first")

        X, _ = extract_features(
            df,
            window_samples=self.window_samples,
            step_samples=self.step_samples,
            label_col=None,
        )
        Xs = self._scale_transform(X)
        return self._model.predict(Xs, verbose=0).ravel()

    def predict(self, df: pd.DataFrame) -> np.ndarray:
        """Return binary predictions (1=fall, 0=normal) for each window."""
        proba = self.predict_proba(df)
        return (proba >= self.threshold).astype(np.int32)

    # ------------------------------------------------------------------
    # evaluate
    # ------------------------------------------------------------------

    def evaluate(
        self,
        df: pd.DataFrame,
        *,
        label_col: str = "label",
        model_size_bytes: int | None = None,
    ) -> FallDetectionReport:
        """Evaluate model on a labelled DataFrame.

        Args:
            df:               Fovet-format IMU DataFrame with labels.
            label_col:        Label column name.
            model_size_bytes: If provided, included in the report.

        Returns:
            FallDetectionReport.
        """
        X, y_true = extract_features(
            df,
            window_samples=self.window_samples,
            step_samples=self.step_samples,
            label_col=label_col,
        )
        if y_true is None:
            raise ValueError(f"Column '{label_col}' not found")

        proba = self.predict_proba(df)
        return _compute_report(y_true, proba, self.threshold, N_FEATURES, model_size_bytes)

    # ------------------------------------------------------------------
    # export
    # ------------------------------------------------------------------

    def export(self, output_dir: Path) -> dict[str, Path]:
        """Export the trained model to TFLite + C headers.

        Produces in output_dir/:
          - fall_detection.tflite         (INT8-quantized TFLite model)
          - fall_detection_model.h        (C header for TFLite Micro)
          - fall_detection_model.cc       (C++ source with byte array)
          - fall_detection_config.json    (metadata)

        Args:
            output_dir: Directory to write files into (created if absent).

        Returns:
            Dict mapping artifact name to Path.

        Raises:
            RuntimeError: If fit() has not been called.
        """
        if not self._fitted or self._model is None:
            raise RuntimeError("Pipeline not fitted — call fit() first")

        import tensorflow as tf  # noqa: PLC0415

        output_dir = Path(output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)

        # --- INT8 quantization -------------------------------------------
        converter = tf.lite.TFLiteConverter.from_keras_model(self._model)
        converter.optimizations = [tf.lite.Optimize.DEFAULT]

        calib = self._calibration_data

        def representative_dataset():
            for i in range(len(calib)):
                yield [calib[i : i + 1]]

        converter.representative_dataset = representative_dataset
        converter.target_spec.supported_ops = [tf.lite.OpsSet.TFLITE_BUILTINS_INT8]
        converter.inference_input_type  = tf.int8
        converter.inference_output_type = tf.int8

        tflite_model = converter.convert()

        # --- Write .tflite -----------------------------------------------
        tflite_path = output_dir / "fall_detection.tflite"
        tflite_path.write_bytes(tflite_model)

        # --- Write C header + source -------------------------------------
        model_bytes = list(tflite_model)
        model_len   = len(model_bytes)

        # .h
        guard = "FOVET_FALL_DETECTION_MODEL_H"
        h_lines = [
            "/* Auto-generated by Fovet Forge — do not edit */",
            f"#ifndef {guard}",
            f"#define {guard}",
            "",
            "#include <stdint.h>",
            "",
            f"#define FOVET_FALL_DETECTION_N_FEATURES  {N_FEATURES}",
            f"#define FOVET_FALL_DETECTION_THRESHOLD   {self.threshold:.6f}f",
            f"#define FOVET_FALL_DETECTION_WINDOW      {self.window_samples}",
            "",
            f"extern const uint8_t   g_fall_detection_model[{model_len}];",
            f"extern const int       g_fall_detection_model_len;",
            "",
            f"#endif  /* {guard} */",
        ]
        h_path = output_dir / "fall_detection_model.h"
        h_path.write_text("\n".join(h_lines) + "\n", encoding="utf-8")

        # .cc
        hex_vals = ", ".join(f"0x{b:02x}" for b in model_bytes)
        cc_lines = [
            "/* Auto-generated by Fovet Forge — do not edit */",
            '#include "fall_detection_model.h"',
            "",
            f"const uint8_t g_fall_detection_model[{model_len}] = {{",
        ]
        # Break into lines of 16 bytes
        for offset in range(0, model_len, 16):
            chunk = model_bytes[offset : offset + 16]
            cc_lines.append("  " + ", ".join(f"0x{b:02x}" for b in chunk) + ",")
        cc_lines += [
            "};",
            f"const int g_fall_detection_model_len = {model_len};",
        ]
        cc_path = output_dir / "fall_detection_model.cc"
        cc_path.write_text("\n".join(cc_lines) + "\n", encoding="utf-8")

        # --- Write config JSON -------------------------------------------
        assert self._scaler_mean is not None and self._scaler_std is not None
        config = {
            "detector":       "fall_detection",
            "n_features":     N_FEATURES,
            "feature_names":  FEATURE_NAMES,
            "threshold":      self.threshold,
            "window_samples": self.window_samples,
            "step_samples":   self.step_samples,
            "scaler_mean":    self._scaler_mean.tolist(),
            "scaler_std":     self._scaler_std.tolist(),
            "model_size_bytes": model_len,
        }
        cfg_path = output_dir / "fall_detection_config.json"
        cfg_path.write_text(json.dumps(config, indent=2), encoding="utf-8")

        return {
            "tflite": tflite_path,
            "header": h_path,
            "source": cc_path,
            "config": cfg_path,
        }
