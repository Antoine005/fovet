"""
Fovet SDK — Sentinelle
Copyright (C) 2026 Antoine Porte. All rights reserved.
LGPL v3 for non-commercial use.
Commercial licensing: contact@fovet.eu

-------------------------------------------------------------------------
thermal_stress.py — DHT22-based thermal stress detection pipeline (H3.2)

Detects heat stress and cold stress from ambient temperature + humidity
measured by a DHT22 sensor at 0.5 Hz.

Key metric: WBGT (Wet Bulb Globe Temperature) — ISO 7243 indoor index.
Computed via the Stull (2011) wet-bulb approximation.

  WBGT_indoor = 0.7 × NWB + 0.3 × T_dry
  NWB (Stull 2011) ≈ T × atan(0.151977 × √(H+8.313659))
                      + atan(T+H) − atan(H−1.676331)
                      + 0.00391838 × H^1.5 × atan(0.023101×H)
                      − 4.686035

Fixed thresholds (ISO 7243, moderate work):
  WBGT ≥ 25 °C  → heat stress warning
  WBGT ≥ 28 °C  → heat stress danger
  T    ≤ 10 °C  → cold stress alert

Model: scikit-learn RandomForestClassifier (binary: safe=0, stress=1).
Target metric: AUC ROC ≥ 0.90.

Export (in output_dir/):
  thermal_stress_model.pkl       — serialized RandomForest (joblib)
  thermal_stress_config.json     — metadata (features, scaler, thresholds)
  thermal_thresholds.h           — C header for Sentinelle MCU (H3.3)

Usage (synthetic data, no hardware required):
  from forge.pipelines.thermal_stress import ThermalStressPipeline, synthesize_thermal_data
  data = synthesize_thermal_data()
  pipeline = ThermalStressPipeline()
  pipeline.fit(data)
  report = pipeline.evaluate(data)   # AUC ≥ 0.90
  pipeline.export(Path("models/thermal_stress"))

DataFrame format (Fovet standard):
  timestamp_ms | sensor_type="temp" | value_1=celsius | value_2=humidity_pct | label
-------------------------------------------------------------------------
"""

from __future__ import annotations

import json
from dataclasses import dataclass, asdict
from pathlib import Path

import numpy as np
import pandas as pd

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

FEATURE_NAMES: list[str] = [
    "mean_celsius",   # mean temperature over window
    "max_celsius",    # peak temperature (heat)
    "min_celsius",    # minimum temperature (cold)
    "std_celsius",    # temperature variability
    "mean_humidity",  # mean relative humidity
    "mean_wbgt",      # mean WBGT index
    "max_wbgt",       # peak WBGT (worst heat exposure)
    "trend_celsius",  # linear slope °C/min (warming/cooling trend)
]

N_FEATURES = len(FEATURE_NAMES)  # 8

# Default pipeline parameters
DEFAULT_WINDOW_S    = 240    # 4-minute window (120 samples @ 0.5 Hz)
DEFAULT_STEP_S      = 120    # 2-minute stride (50 % overlap)
DEFAULT_SAMPLE_RATE = 0.5    # Hz — DHT22 max measurement rate
DEFAULT_THRESHOLD   = 0.5    # binary decision threshold

# Fixed WBGT thresholds — ISO 7243 moderate physical work
WBGT_WARN_C   = 25.0   # °C — heat stress warning
WBGT_DANGER_C = 28.0   # °C — heat stress danger
COLD_ALERT_C  = 10.0   # °C — cold stress alert (T below this)

# Physiological reference values for synthetic data
_NORMAL_TEMP_C        = 22.0
_NORMAL_TEMP_STD      =  1.0
_NORMAL_HUMIDITY      = 50.0
_NORMAL_HUMIDITY_STD  =  5.0

_WARM_TEMP_C          = 35.0
_WARM_TEMP_STD        =  1.0
_WARM_HUMIDITY        = 72.0
_WARM_HUMIDITY_STD    =  5.0

_COLD_TEMP_C          =  4.0
_COLD_TEMP_STD        =  1.0
_COLD_HUMIDITY        = 80.0
_COLD_HUMIDITY_STD    =  5.0


# ---------------------------------------------------------------------------
# WBGT computation
# ---------------------------------------------------------------------------

def compute_wbgt(
    celsius:      np.ndarray | float,
    humidity_pct: np.ndarray | float,
) -> np.ndarray | float:
    """Compute indoor WBGT using the Stull (2011) wet-bulb approximation.

    Valid for T ∈ [0, 40] °C and RH ∈ [5, 99] %.
    Accuracy: ±1 °C WBGT vs. aspirated psychrometer.

    Args:
        celsius:      Dry-bulb temperature (°C). Scalar or array.
        humidity_pct: Relative humidity (%). Scalar or array.

    Returns:
        WBGT in °C, same shape as inputs.
    """
    t = np.asarray(celsius,      dtype=np.float64)
    h = np.asarray(humidity_pct, dtype=np.float64)

    # Stull (2011) natural wet-bulb temperature approximation
    nwb = (
        t * np.arctan(0.151977 * np.sqrt(h + 8.313659))
        + np.arctan(t + h)
        - np.arctan(h - 1.676331)
        + 0.00391838 * h ** 1.5 * np.arctan(0.023101 * h)
        - 4.686035
    )

    # Indoor WBGT (no solar load): 70 % NWB + 30 % dry bulb
    return 0.7 * nwb + 0.3 * t


# ---------------------------------------------------------------------------
# Feature extraction
# ---------------------------------------------------------------------------

def _extract_thermal_features(
    celsius_arr:      np.ndarray,
    humidity_arr:     np.ndarray,
    sample_rate_hz:   float,
) -> np.ndarray:
    """Compute the 8 thermal features from one window.

    Args:
        celsius_arr:    1-D temperature array (°C) for the window.
        humidity_arr:   1-D humidity array (%) for the window.
        sample_rate_hz: Sampling rate (Hz) — used for the trend slope.

    Returns:
        float32 array of shape (N_FEATURES,) = (8,).
    """
    n = len(celsius_arr)

    mean_c = float(np.mean(celsius_arr))
    max_c  = float(np.max(celsius_arr))
    min_c  = float(np.min(celsius_arr))
    std_c  = float(np.std(celsius_arr, ddof=1)) if n > 1 else 0.0
    mean_h = float(np.mean(humidity_arr))

    wbgt      = compute_wbgt(celsius_arr, humidity_arr)
    mean_wbgt = float(np.mean(wbgt))
    max_wbgt  = float(np.max(wbgt))

    # Linear trend in °C/min
    if n > 1:
        t_min = np.arange(n, dtype=np.float64) / (sample_rate_hz * 60.0)
        trend = float(np.polyfit(t_min, celsius_arr, 1)[0])
    else:
        trend = 0.0

    return np.array(
        [mean_c, max_c, min_c, std_c, mean_h, mean_wbgt, max_wbgt, trend],
        dtype=np.float32,
    )


def extract_features(
    df: pd.DataFrame,
    *,
    window_s:       float        = DEFAULT_WINDOW_S,
    step_s:         float        = DEFAULT_STEP_S,
    sample_rate_hz: float        = DEFAULT_SAMPLE_RATE,
    celsius_col:    str          = "value_1",
    humidity_col:   str          = "value_2",
    label_col:      str | None   = "label",
) -> tuple[np.ndarray, np.ndarray | None]:
    """Slide a window over a Fovet TEMP DataFrame and extract thermal features.

    Only rows with sensor_type == "temp" are used (if the column is present).

    Args:
        df:             Fovet-format DataFrame (sensor_type, value_1=celsius,
                        value_2=humidity_pct).
        window_s:       Window length in seconds.
        step_s:         Stride between consecutive windows (seconds).
        sample_rate_hz: DHT22 sampling rate (Hz) — default 0.5 Hz.
        celsius_col:    Column name for temperature values.
        humidity_col:   Column name for humidity values.
        label_col:      Binary label column (1=stress, 0=normal).
                        If None or absent, returned labels array is None.

    Returns:
        Tuple of:
          - X: float32 array, shape (n_windows, N_FEATURES)
          - y: int32 array,   shape (n_windows,), or None if no labels.

    Raises:
        ValueError: If celsius_col is missing or signal is shorter than window_s.
    """
    if "sensor_type" in df.columns:
        temp_df = df[df["sensor_type"] == "temp"].reset_index(drop=True)
    else:
        temp_df = df.reset_index(drop=True)

    if celsius_col not in temp_df.columns:
        raise ValueError(f"Column '{celsius_col}' not found in DataFrame")

    celsius  = temp_df[celsius_col].to_numpy(dtype=np.float64)
    humidity = (
        temp_df[humidity_col].to_numpy(dtype=np.float64)
        if humidity_col in temp_df.columns
        else np.full(len(celsius), 50.0)
    )

    has_labels = label_col is not None and label_col in temp_df.columns
    labels_raw = temp_df[label_col].to_numpy(dtype=np.int32) if has_labels else None

    window_samp = int(window_s * sample_rate_hz)
    step_samp   = int(step_s   * sample_rate_hz)
    n           = len(celsius)

    if n < window_samp:
        raise ValueError(
            f"TEMP signal has only {n} samples but window requires {window_samp} "
            f"({window_s} s × {sample_rate_hz} Hz)."
        )

    X_list: list[np.ndarray] = []
    y_list: list[int]        = []

    start = 0
    while start + window_samp <= n:
        end = start + window_samp
        X_list.append(
            _extract_thermal_features(celsius[start:end], humidity[start:end], sample_rate_hz)
        )
        if has_labels and labels_raw is not None:
            y_list.append(int(np.max(labels_raw[start:end])))
        start += step_samp

    X = np.stack(X_list).astype(np.float32)
    y = np.array(y_list, dtype=np.int32) if has_labels else None
    return X, y


# ---------------------------------------------------------------------------
# Synthetic data generator
# ---------------------------------------------------------------------------

def synthesize_thermal_data(
    n_normal_s: int = 1200,
    n_warm_s:   int =  600,
    n_cold_s:   int =  600,
    *,
    sample_rate_hz: float                      = DEFAULT_SAMPLE_RATE,
    rng:            np.random.Generator | None = None,
) -> pd.DataFrame:
    """Generate a synthetic DHT22 dataset with normal, heat-stress and cold-stress phases.

    Normal:      T ~ N(22, 1) °C, RH ~ N(50, 5) %  → label=0
    Warm stress: T ~ N(35, 1) °C, RH ~ N(72, 5) %  → label=1  (WBGT ≈ 31 °C)
    Cold stress: T ~ N(4,  1) °C, RH ~ N(80, 5) %  → label=1  (T < 10 °C)

    Args:
        n_normal_s:     Duration of the normal phase (seconds).
        n_warm_s:       Duration of the heat-stress phase (seconds).
        n_cold_s:       Duration of the cold-stress phase (seconds).
        sample_rate_hz: DHT22 sampling rate (Hz).
        rng:            NumPy random Generator for reproducibility.

    Returns:
        DataFrame with columns:
          timestamp_ms, sensor_type, value_1 (celsius), value_2 (humidity), label.
    """
    if rng is None:
        rng = np.random.default_rng(42)

    def _segment(n: int, t_mean: float, t_std: float,
                 h_mean: float, h_std: float) -> tuple[np.ndarray, np.ndarray]:
        t = rng.normal(t_mean, t_std, n).astype(np.float32)
        h = np.clip(rng.normal(h_mean, h_std, n), 0.0, 100.0).astype(np.float32)
        return t, h

    n_normal = int(n_normal_s * sample_rate_hz)
    n_warm   = int(n_warm_s   * sample_rate_hz)
    n_cold   = int(n_cold_s   * sample_rate_hz)

    t_n, h_n = _segment(n_normal, _NORMAL_TEMP_C, _NORMAL_TEMP_STD, _NORMAL_HUMIDITY, _NORMAL_HUMIDITY_STD)
    t_w, h_w = _segment(n_warm,   _WARM_TEMP_C,   _WARM_TEMP_STD,   _WARM_HUMIDITY,   _WARM_HUMIDITY_STD)
    t_c, h_c = _segment(n_cold,   _COLD_TEMP_C,   _COLD_TEMP_STD,   _COLD_HUMIDITY,   _COLD_HUMIDITY_STD)

    celsius  = np.concatenate([t_n, t_w, t_c])
    humidity = np.concatenate([h_n, h_w, h_c])
    labels   = np.concatenate([
        np.zeros(n_normal, dtype=np.int32),
        np.ones(n_warm,    dtype=np.int32),
        np.ones(n_cold,    dtype=np.int32),
    ])

    dt_ms = int(1000.0 / sample_rate_hz)
    ts    = np.arange(len(celsius), dtype=np.int64) * dt_ms

    return pd.DataFrame({
        "timestamp_ms": ts,
        "sensor_type":  "temp",
        "value_1":      celsius,
        "value_2":      humidity,
        "label":        labels,
    })


# ---------------------------------------------------------------------------
# Evaluation report
# ---------------------------------------------------------------------------

@dataclass
class ThermalStressReport:
    """Evaluation report for the thermal stress model."""

    auc:               float
    precision:         float
    recall:            float
    f1:                float
    confusion_matrix:  list[list[int]]   # [[TN, FP], [FN, TP]]
    n_samples:         int
    n_stress_samples:  int
    n_normal_samples:  int
    threshold:         float
    n_features:        int

    def meets_spec(self) -> bool:
        """Return True if AUC ROC ≥ 0.90 (H3.2 specification)."""
        return self.auc >= 0.90

    def as_dict(self) -> dict:
        return asdict(self)

    def __str__(self) -> str:
        cm = self.confusion_matrix
        lines = [
            "=== Thermal Stress Evaluation ===",
            f"  AUC ROC   : {self.auc:.4f}  (spec: ≥ 0.90)",
            f"  Precision : {self.precision:.1%}",
            f"  Recall    : {self.recall:.1%}",
            f"  F1-score  : {self.f1:.1%}",
            "",
            "  Confusion matrix (rows=actual, cols=predicted):",
            "                  Pred-Normal  Pred-Stress",
            f"  Act-Normal        {cm[0][0]:>7}     {cm[0][1]:>7}",
            f"  Act-Stress        {cm[1][0]:>7}     {cm[1][1]:>7}",
            "",
            f"  Samples   : {self.n_samples} "
            f"({self.n_stress_samples} stress, {self.n_normal_samples} normal)",
            f"  Meets spec: {'YES ✓' if self.meets_spec() else 'NO ✗'}",
        ]
        return "\n".join(lines)


def _compute_report(
    y_true:     np.ndarray,
    y_proba:    np.ndarray,
    threshold:  float,
    n_features: int,
) -> ThermalStressReport:
    from sklearn.metrics import roc_auc_score

    y_bin = (y_proba >= threshold).astype(np.int32)

    tp = int(np.sum((y_bin == 1) & (y_true == 1)))
    tn = int(np.sum((y_bin == 0) & (y_true == 0)))
    fp = int(np.sum((y_bin == 1) & (y_true == 0)))
    fn = int(np.sum((y_bin == 0) & (y_true == 1)))

    precision = tp / (tp + fp) if (tp + fp) > 0 else 0.0
    recall    = tp / (tp + fn) if (tp + fn) > 0 else 0.0
    f1 = (
        2 * precision * recall / (precision + recall)
        if (precision + recall) > 0 else 0.0
    )

    try:
        auc = float(roc_auc_score(y_true, y_proba))
    except ValueError:
        auc = 0.0

    return ThermalStressReport(
        auc               = auc,
        precision         = precision,
        recall            = recall,
        f1                = f1,
        confusion_matrix  = [[tn, fp], [fn, tp]],
        n_samples         = len(y_true),
        n_stress_samples  = int(np.sum(y_true == 1)),
        n_normal_samples  = int(np.sum(y_true == 0)),
        threshold         = threshold,
        n_features        = n_features,
    )


# ---------------------------------------------------------------------------
# ThermalStressPipeline
# ---------------------------------------------------------------------------

class ThermalStressPipeline:
    """End-to-end thermal stress detection: DHT22 → 8 features → Random Forest.

    Args:
        window_s:       Sliding window length in seconds (default 240 s).
        step_s:         Window stride in seconds (default 120 s).
        sample_rate_hz: DHT22 sampling rate in Hz (default 0.5 Hz).
        threshold:      Decision probability threshold (default 0.5).
        n_estimators:   Number of trees in the Random Forest (default 100).
        random_state:   Seed for reproducibility (default 42).
    """

    def __init__(
        self,
        window_s:       float = DEFAULT_WINDOW_S,
        step_s:         float = DEFAULT_STEP_S,
        sample_rate_hz: float = DEFAULT_SAMPLE_RATE,
        threshold:      float = DEFAULT_THRESHOLD,
        n_estimators:   int   = 100,
        random_state:   int   = 42,
    ) -> None:
        self.window_s       = window_s
        self.step_s         = step_s
        self.sample_rate_hz = sample_rate_hz
        self.threshold      = threshold
        self.n_estimators   = n_estimators
        self.random_state   = random_state

        self._model:                              object        = None
        self._scaler_mean:       np.ndarray | None             = None
        self._scaler_std:        np.ndarray | None             = None
        self._feature_importances: np.ndarray | None           = None
        self._fitted:            bool                          = False

    # ------------------------------------------------------------------
    # Normalisation
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
        df:        pd.DataFrame,
        *,
        label_col: str = "label",
        verbose:   int = 0,
    ) -> "ThermalStressPipeline":
        """Extract thermal features, scale, and train the Random Forest.

        Args:
            df:        Fovet-format DataFrame (sensor_type="temp", value_1=celsius,
                       value_2=humidity).
            label_col: Binary label column (1=stress, 0=normal).
            verbose:   Print a summary line if > 0.

        Returns:
            self (for chaining).
        """
        from sklearn.ensemble import RandomForestClassifier

        X, y = extract_features(
            df,
            window_s=self.window_s,
            step_s=self.step_s,
            sample_rate_hz=self.sample_rate_hz,
            label_col=label_col,
        )
        if y is None:
            raise ValueError(
                "label_col not found in DataFrame — supervised training requires labels"
            )

        self._scale_fit(X)
        Xs = self._scale_transform(X)

        self._model = RandomForestClassifier(
            n_estimators=self.n_estimators,
            random_state=self.random_state,
            n_jobs=-1,
        )
        self._model.fit(Xs, y)  # type: ignore[union-attr]
        self._feature_importances = self._model.feature_importances_  # type: ignore[union-attr]

        if verbose > 0:
            print(
                f"ThermalStressPipeline fitted: {len(X)} windows, "
                f"{N_FEATURES} features, {self.n_estimators} trees"
            )

        self._fitted = True
        return self

    # ------------------------------------------------------------------
    # predict
    # ------------------------------------------------------------------

    def predict_proba(self, df: pd.DataFrame) -> np.ndarray:
        """Return thermal stress probability scores for each window (0–1)."""
        if not self._fitted or self._model is None:
            raise RuntimeError("Pipeline not fitted — call fit() first")

        X, _ = extract_features(
            df,
            window_s=self.window_s,
            step_s=self.step_s,
            sample_rate_hz=self.sample_rate_hz,
            label_col=None,
        )
        Xs = self._scale_transform(X)
        return self._model.predict_proba(Xs)[:, 1]  # type: ignore[union-attr]

    def predict(self, df: pd.DataFrame) -> np.ndarray:
        """Return binary predictions (1=stress, 0=normal) for each window."""
        return (self.predict_proba(df) >= self.threshold).astype(np.int32)

    # ------------------------------------------------------------------
    # evaluate
    # ------------------------------------------------------------------

    def evaluate(
        self,
        df:        pd.DataFrame,
        *,
        label_col: str = "label",
    ) -> ThermalStressReport:
        """Evaluate model on a labelled DataFrame.

        Args:
            df:        Fovet-format DataFrame with celsius, humidity and labels.
            label_col: Label column name.

        Returns:
            ThermalStressReport with AUC, precision, recall, F1.
        """
        _, y_true = extract_features(
            df,
            window_s=self.window_s,
            step_s=self.step_s,
            sample_rate_hz=self.sample_rate_hz,
            label_col=label_col,
        )
        if y_true is None:
            raise ValueError(f"Column '{label_col}' not found")

        proba = self.predict_proba(df)
        return _compute_report(y_true, proba, self.threshold, N_FEATURES)

    # ------------------------------------------------------------------
    # export
    # ------------------------------------------------------------------

    def export(self, output_dir: Path) -> dict[str, Path]:
        """Export the trained model to joblib + config JSON + C header.

        Produces in output_dir/:
          - thermal_stress_model.pkl       (serialized RandomForest — joblib)
          - thermal_stress_config.json     (metadata: features, scaler, thresholds)
          - thermal_thresholds.h           (C header for Sentinelle MCU — H3.3)

        Args:
            output_dir: Directory to write files into (created if absent).

        Returns:
            Dict mapping artifact name to Path.

        Raises:
            RuntimeError: If fit() has not been called.
        """
        if not self._fitted or self._model is None:
            raise RuntimeError("Pipeline not fitted — call fit() first")

        import joblib

        output_dir = Path(output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)

        assert self._scaler_mean is not None and self._scaler_std is not None

        # --- Serialized model ---
        model_path = output_dir / "thermal_stress_model.pkl"
        joblib.dump(self._model, model_path)

        # --- Config JSON ---
        config: dict = {
            "detector":            "thermal_stress",
            "n_features":          N_FEATURES,
            "feature_names":       FEATURE_NAMES,
            "threshold":           self.threshold,
            "window_s":            self.window_s,
            "step_s":              self.step_s,
            "sample_rate_hz":      self.sample_rate_hz,
            "n_estimators":        self.n_estimators,
            "wbgt_warn_c":         WBGT_WARN_C,
            "wbgt_danger_c":       WBGT_DANGER_C,
            "cold_alert_c":        COLD_ALERT_C,
            "scaler_mean":         self._scaler_mean.tolist(),
            "scaler_std":          self._scaler_std.tolist(),
            "feature_importances": (
                self._feature_importances.tolist()
                if self._feature_importances is not None else []
            ),
        }
        cfg_path = output_dir / "thermal_stress_config.json"
        cfg_path.write_text(json.dumps(config, indent=2), encoding="utf-8")

        # --- C header for Sentinelle MCU (H3.3) ---
        mean_c_idx = FEATURE_NAMES.index("mean_celsius")
        std_c_idx  = FEATURE_NAMES.index("std_celsius")
        mean_h_idx = FEATURE_NAMES.index("mean_humidity")

        normal_c_mean = float(self._scaler_mean[mean_c_idx])
        normal_c_std  = float(self._scaler_std[std_c_idx])
        normal_h_mean = float(self._scaler_mean[mean_h_idx])

        h_lines = [
            "/* Auto-generated by Fovet Forge — do not edit */",
            "#ifndef FOVET_THERMAL_THRESHOLDS_H",
            "#define FOVET_THERMAL_THRESHOLDS_H",
            "",
            "/**",
            " * Thermal stress detection thresholds.",
            " * Generated by ThermalStressPipeline.export() (H3.2).",
            " *",
            f" * Features      : {', '.join(FEATURE_NAMES)}",
            f" * Window        : {self.window_s} s @ {self.sample_rate_hz} Hz",
            f" * Classifier    : RandomForest, {self.n_estimators} trees",
            " */",
            "",
            f"#define FOVET_TEMP_N_FEATURES          {N_FEATURES}",
            f"#define FOVET_TEMP_WINDOW_S             {int(self.window_s)}",
            f"#define FOVET_TEMP_STEP_S               {int(self.step_s)}",
            "",
            "/* WBGT thresholds (°C) — ISO 7243, moderate physical work     */",
            f"#define FOVET_TEMP_WBGT_WARN_C          {WBGT_WARN_C:.1f}f",
            f"#define FOVET_TEMP_WBGT_DANGER_C        {WBGT_DANGER_C:.1f}f",
            "",
            "/* Cold stress threshold (°C) — hypothermia risk               */",
            f"#define FOVET_TEMP_COLD_ALERT_C         {COLD_ALERT_C:.1f}f",
            "",
            "/* Normal condition statistics (from training scaler)           */",
            f"#define FOVET_TEMP_NORMAL_CELSIUS_MEAN  {normal_c_mean:.2f}f",
            f"#define FOVET_TEMP_NORMAL_CELSIUS_STD   {normal_c_std:.2f}f",
            f"#define FOVET_TEMP_NORMAL_HUMIDITY_MEAN {normal_h_mean:.2f}f",
            "",
            "#endif /* FOVET_THERMAL_THRESHOLDS_H */",
        ]
        header_path = output_dir / "thermal_thresholds.h"
        header_path.write_text("\n".join(h_lines) + "\n", encoding="utf-8")

        return {
            "model":  model_path,
            "config": cfg_path,
            "header": header_path,
        }
