"""
Fovet SDK — Sentinelle
Copyright (C) 2026 Antoine Porte. All rights reserved.
LGPL v3 for non-commercial use.
Commercial licensing: contact@fovet.eu

-------------------------------------------------------------------------
fatigue_hrv.py — HRV-based fatigue detection pipeline (Phase H2.2)

Feature extraction (7 time-domain HRV features on sliding BVP window):
  mean_rr, sdnn, rmssd, pnn50, mean_hr, cv_rr, range_rr

Model: scikit-learn RandomForestClassifier.
  No TensorFlow required — sklearn is a base dependency.

Target metric: AUC ROC ≥ 0.85 (binary: fatigue=1 vs baseline=0).

The pipeline targets the WESAD dataset (wrist BVP at 64 Hz), but works
with any BVP/PPG signal that follows the standard Fovet CSV format:
  timestamp_ms, sensor_type="hr", value_1=bvp, label

Export (in output_dir/):
  fatigue_hrv_model.pkl          — serialized RandomForest (joblib)
  fatigue_hrv_config.json        — metadata (features, scaler, threshold)
  fatigue_hrv_thresholds.h       — C header for Sentinelle MCU (H2.3)

Usage (synthetic data, no WESAD download required):
  from forge.pipelines.fatigue_hrv import FatigueHRVPipeline, synthesize_fatigue_data
  data = synthesize_fatigue_data(n_baseline_s=600, n_stress_s=300)
  pipeline = FatigueHRVPipeline(window_s=120, step_s=60)
  pipeline.fit(data)
  report = pipeline.evaluate(data)        # AUC ≥ 0.85
  pipeline.export(Path("models/fatigue_hrv"))

Usage with real WESAD data:
  from forge.datasets import load_parsed
  df = load_parsed(Path("datasets/human"), "wesad")
  hr_df = df[df["sensor_type"] == "hr"]  # BVP at 64 Hz
  pipeline.fit(hr_df, label_col="label")
  pipeline.export(Path("models/fatigue_hrv"))
-------------------------------------------------------------------------
"""

from __future__ import annotations

import json
from dataclasses import dataclass, asdict
from pathlib import Path

import numpy as np
import pandas as pd

# Feature names — fixed order, must match _extract_hrv_features()
FEATURE_NAMES: list[str] = [
    "mean_rr",   # mean RR interval (ms)
    "sdnn",      # std dev of RR intervals (ms) — overall HRV
    "rmssd",     # root mean square of successive differences (ms) — parasympathetic
    "pnn50",     # proportion of |ΔRR| > 50 ms — parasympathetic index
    "mean_hr",   # mean heart rate (bpm) = 60000 / mean_rr
    "cv_rr",     # coefficient of variation = sdnn / mean_rr
    "range_rr",  # max_rr - min_rr (ms) — total variability range
]

N_FEATURES = len(FEATURE_NAMES)  # 7

# Default pipeline parameters
DEFAULT_WINDOW_S    = 120   # 2-minute HRV window (reliable HRV requires ≥ 2 min)
DEFAULT_STEP_S      = 60    # 1-minute stride (50% overlap)
DEFAULT_SAMPLE_RATE = 64    # Hz — WESAD wrist BVP / MAX30102 in 64 Hz mode
DEFAULT_THRESHOLD   = 0.5   # binary decision threshold for RF probability

# Physiological reference values for synthetic data generation
_BASELINE_HR_BPM  = 62.0   # relaxed resting heart rate (bpm)
_BASELINE_RMSSD   = 40.0   # ms — high HRV indicates recovery/rest
_STRESS_HR_BPM    = 82.0   # elevated heart rate under stress/fatigue (bpm)
_STRESS_RMSSD     = 12.0   # ms — low HRV indicates sympathetic dominance


# ---------------------------------------------------------------------------
# BVP signal generation (synthetic)
# ---------------------------------------------------------------------------

def _make_bvp_segment(
    n_samples: int,
    hr_bpm: float,
    rmssd_ms: float,
    sample_rate_hz: int,
    rng: np.random.Generator,
) -> np.ndarray:
    """Generate a synthetic BVP-like signal with Gaussian pulses at jittered beat positions.

    Args:
        n_samples:      Total length in samples.
        hr_bpm:         Mean heart rate (bpm).
        rmssd_ms:       HRV level as RMSSD target (ms).  Higher = more variability.
        sample_rate_hz: Sampling rate (Hz).
        rng:            NumPy random generator for reproducibility.

    Returns:
        float32 array of shape (n_samples,).
    """
    mean_rr_samp = (60.0 / hr_bpm) * sample_rate_hz

    # RMSSD ≈ std(|ΔRR|) → std(RR) ≈ RMSSD / sqrt(2)
    rr_std_samp = (rmssd_ms / 1000.0) * sample_rate_hz / np.sqrt(2.0)

    # Pre-generate all beat positions
    max_beats = int(n_samples / max(mean_rr_samp, 1)) + 20
    rr_intervals = np.clip(
        rng.normal(mean_rr_samp, rr_std_samp, max_beats),
        mean_rr_samp * 0.5,
        mean_rr_samp * 1.5,
    )
    # First beat starts at a random offset within the first RR period
    peak_positions = (
        np.cumsum(rr_intervals) + rng.uniform(0.0, mean_rr_samp * 0.5)
    ).astype(int)
    peak_positions = peak_positions[peak_positions < n_samples]

    # Gaussian pulse per beat: sigma = 3 samples, support ±12 samples
    pulse_sigma  = 3.0
    half_support = 12
    bvp = np.zeros(n_samples, dtype=np.float64)
    idx = np.arange(n_samples, dtype=np.float64)

    for peak in peak_positions:
        start = max(0, peak - half_support)
        end   = min(n_samples, peak + half_support)
        bvp[start:end] += np.exp(-0.5 * ((idx[start:end] - peak) / pulse_sigma) ** 2)

    # Additive measurement noise
    bvp += rng.normal(0.0, 0.05, n_samples)
    return bvp.astype(np.float32)


# ---------------------------------------------------------------------------
# BVP → RR intervals
# ---------------------------------------------------------------------------

def _bvp_to_rr(bvp: np.ndarray, sample_rate: int) -> np.ndarray:
    """Detect heartbeat peaks in a BVP signal and return RR intervals in ms.

    Uses scipy.signal.find_peaks with an adaptive height threshold and
    a minimum distance corresponding to 170 bpm max heart rate.

    Args:
        bvp:         1-D BVP signal array (any dtype, converted internally).
        sample_rate: Sampling rate of the BVP signal (Hz).

    Returns:
        1-D float64 array of RR intervals in milliseconds.
        Returns an empty array if fewer than 2 peaks are detected.
    """
    from scipy.signal import find_peaks  # scipy ships with scikit-learn

    bvp_f = bvp.astype(np.float64)

    # Adaptive threshold: mean + 0.3 × std avoids spurious peaks in noisy segments
    threshold = float(np.mean(bvp_f) + 0.3 * np.std(bvp_f))

    # Minimum distance = 0.35 s = max ~170 bpm
    min_dist = max(1, int(0.35 * sample_rate))

    peaks, _ = find_peaks(bvp_f, distance=min_dist, height=threshold)

    if len(peaks) < 2:
        return np.array([], dtype=np.float64)

    return np.diff(peaks).astype(np.float64) * (1000.0 / sample_rate)  # → ms


# ---------------------------------------------------------------------------
# HRV feature extraction
# ---------------------------------------------------------------------------

def _extract_hrv_features(rr_ms: np.ndarray) -> np.ndarray:
    """Compute the 7 time-domain HRV features from an RR interval array.

    Args:
        rr_ms: 1-D array of RR intervals in milliseconds.
                Returns zero vector if fewer than 2 intervals.

    Returns:
        float32 array of shape (N_FEATURES,) = (7,).
    """
    if len(rr_ms) < 2:
        return np.zeros(N_FEATURES, dtype=np.float32)

    mean_rr = float(np.mean(rr_ms))
    sdnn    = float(np.std(rr_ms, ddof=1))

    diffs  = np.diff(rr_ms)
    rmssd  = float(np.sqrt(np.mean(diffs ** 2))) if len(diffs) > 0 else 0.0
    pnn50  = float(np.sum(np.abs(diffs) > 50.0) / max(len(diffs), 1))

    mean_hr = 60000.0 / mean_rr if mean_rr > 0.0 else 0.0
    cv_rr   = sdnn / mean_rr     if mean_rr > 0.0 else 0.0
    range_rr = float(np.max(rr_ms) - np.min(rr_ms))

    return np.array(
        [mean_rr, sdnn, rmssd, pnn50, mean_hr, cv_rr, range_rr],
        dtype=np.float32,
    )


# ---------------------------------------------------------------------------
# Feature extraction — sliding window over BVP DataFrame
# ---------------------------------------------------------------------------

def extract_features(
    df: pd.DataFrame,
    *,
    window_s:       int          = DEFAULT_WINDOW_S,
    step_s:         int          = DEFAULT_STEP_S,
    sample_rate_hz: int          = DEFAULT_SAMPLE_RATE,
    bvp_col:        str          = "value_1",
    label_col:      str | None   = "label",
) -> tuple[np.ndarray, np.ndarray | None]:
    """Slide a window over a Fovet HR DataFrame and extract HRV features.

    Only rows with sensor_type == "hr" are used (if the column is present).
    Within each window, the BVP signal is converted to RR intervals and
    the 7 HRV features are computed.

    Args:
        df:             Fovet-format DataFrame (sensor_type, value_1 = BVP).
        window_s:       Window length in seconds.
        step_s:         Stride between consecutive windows (seconds).
        sample_rate_hz: BVP sampling rate (Hz).
        bvp_col:        Column name for the BVP signal.
        label_col:      Column with binary labels (1=fatigue, 0=baseline).
                        If None or absent, returned labels array is None.

    Returns:
        Tuple of:
          - X: float32 array, shape (n_windows, N_FEATURES)
          - y: int32 array,   shape (n_windows,), or None if no labels.

    Raises:
        ValueError: If bvp_col is missing or signal is shorter than window_s.
    """
    # Use only HR rows when sensor_type column is present
    if "sensor_type" in df.columns:
        hr_df = df[df["sensor_type"] == "hr"].reset_index(drop=True)
    else:
        hr_df = df.reset_index(drop=True)

    if bvp_col not in hr_df.columns:
        raise ValueError(f"Column '{bvp_col}' not found in DataFrame")

    bvp        = hr_df[bvp_col].to_numpy(dtype=np.float64)
    has_labels = label_col is not None and label_col in hr_df.columns
    labels_raw = hr_df[label_col].to_numpy(dtype=np.int32) if has_labels else None

    window_samp = window_s * sample_rate_hz
    step_samp   = step_s   * sample_rate_hz
    n           = len(bvp)

    if n < window_samp:
        raise ValueError(
            f"BVP signal has only {n} samples but window requires {window_samp} "
            f"({window_s} s × {sample_rate_hz} Hz). "
            "Need at least window_s × sample_rate_hz samples."
        )

    X_list: list[np.ndarray] = []
    y_list: list[int]        = []

    start = 0
    while start + window_samp <= n:
        end   = start + window_samp
        rr_ms = _bvp_to_rr(bvp[start:end], sample_rate_hz)
        X_list.append(_extract_hrv_features(rr_ms))

        if has_labels and labels_raw is not None:
            y_list.append(int(np.max(labels_raw[start:end])))

        start += step_samp

    X = np.stack(X_list).astype(np.float32)
    y = np.array(y_list, dtype=np.int32) if has_labels else None
    return X, y


# ---------------------------------------------------------------------------
# Synthetic data generator (no WESAD download required)
# ---------------------------------------------------------------------------

def synthesize_fatigue_data(
    n_baseline_s: int = 600,
    n_stress_s:   int = 300,
    *,
    sample_rate_hz: int                    = DEFAULT_SAMPLE_RATE,
    rng:            np.random.Generator | None = None,
) -> pd.DataFrame:
    """Generate a synthetic WESAD-like BVP dataset with baseline and stress phases.

    Baseline: low HR (~62 bpm), high HRV (RMSSD ~40 ms) — rested/relaxed.
    Stress:   high HR (~82 bpm), low HRV (RMSSD ~12 ms) — fatigued/stressed.

    Args:
        n_baseline_s:   Duration of the baseline phase (seconds).
        n_stress_s:     Duration of the stress phase (seconds).
        sample_rate_hz: Sampling rate of the generated BVP signal (Hz).
        rng:            NumPy random Generator for reproducibility.

    Returns:
        DataFrame with columns: timestamp_ms, sensor_type, value_1, value_2,
        value_3, label (0=baseline, 1=stress/fatigue).
    """
    if rng is None:
        rng = np.random.default_rng(42)

    n_baseline = n_baseline_s * sample_rate_hz
    n_stress   = n_stress_s   * sample_rate_hz

    bvp_baseline = _make_bvp_segment(n_baseline, _BASELINE_HR_BPM, _BASELINE_RMSSD, sample_rate_hz, rng)
    bvp_stress   = _make_bvp_segment(n_stress,   _STRESS_HR_BPM,   _STRESS_RMSSD,   sample_rate_hz, rng)

    dt_ms       = int(1000.0 / sample_rate_hz)
    ts_baseline = np.arange(n_baseline, dtype=np.int64) * dt_ms
    ts_stress   = np.arange(n_stress,   dtype=np.int64) * dt_ms + ts_baseline[-1] + dt_ms

    bvp    = np.concatenate([bvp_baseline, bvp_stress])
    ts     = np.concatenate([ts_baseline,  ts_stress])
    labels = np.concatenate([
        np.zeros(n_baseline, dtype=np.int32),
        np.ones(n_stress,    dtype=np.int32),
    ])

    return pd.DataFrame({
        "timestamp_ms": ts,
        "sensor_type":  "hr",
        "value_1":      bvp,
        "value_2":      np.zeros(len(bvp), dtype=np.float32),
        "value_3":      np.zeros(len(bvp), dtype=np.float32),
        "label":        labels,
    })


# ---------------------------------------------------------------------------
# Evaluation report
# ---------------------------------------------------------------------------

@dataclass
class FatigueHRVReport:
    """Evaluation report for the fatigue HRV model."""

    auc:               float
    precision:         float
    recall:            float
    f1:                float
    confusion_matrix:  list[list[int]]  # [[TN, FP], [FN, TP]]
    n_samples:         int
    n_fatigue_samples: int
    n_baseline_samples: int
    threshold:         float
    n_features:        int

    def meets_spec(self) -> bool:
        """Return True if AUC ROC ≥ 0.85 (H2.2 specification)."""
        return self.auc >= 0.85

    def as_dict(self) -> dict:
        return asdict(self)

    def __str__(self) -> str:
        cm = self.confusion_matrix
        lines = [
            "=== Fatigue HRV Evaluation ===",
            f"  AUC ROC   : {self.auc:.4f}  (spec: ≥ 0.85)",
            f"  Precision : {self.precision:.1%}",
            f"  Recall    : {self.recall:.1%}",
            f"  F1-score  : {self.f1:.1%}",
            "",
            "  Confusion matrix (rows=actual, cols=predicted):",
            "                  Pred-Normal  Pred-Fatigue",
            f"  Act-Normal        {cm[0][0]:>7}     {cm[0][1]:>7}",
            f"  Act-Fatigue       {cm[1][0]:>7}     {cm[1][1]:>7}",
            "",
            f"  Samples   : {self.n_samples} "
            f"({self.n_fatigue_samples} fatigue, {self.n_baseline_samples} baseline)",
            f"  Meets spec: {'YES ✓' if self.meets_spec() else 'NO ✗'}",
        ]
        return "\n".join(lines)


def _compute_report(
    y_true:     np.ndarray,
    y_proba:    np.ndarray,
    threshold:  float,
    n_features: int,
) -> FatigueHRVReport:
    from sklearn.metrics import roc_auc_score

    y_bin = (y_proba >= threshold).astype(np.int32)

    tp = int(np.sum((y_bin == 1) & (y_true == 1)))
    tn = int(np.sum((y_bin == 0) & (y_true == 0)))
    fp = int(np.sum((y_bin == 1) & (y_true == 0)))
    fn = int(np.sum((y_bin == 0) & (y_true == 1)))

    precision = tp / (tp + fp) if (tp + fp) > 0 else 0.0
    recall    = tp / (tp + fn) if (tp + fn) > 0 else 0.0
    f1        = (
        2 * precision * recall / (precision + recall)
        if (precision + recall) > 0 else 0.0
    )

    try:
        auc = float(roc_auc_score(y_true, y_proba))
    except ValueError:
        auc = 0.0

    return FatigueHRVReport(
        auc                = auc,
        precision          = precision,
        recall             = recall,
        f1                 = f1,
        confusion_matrix   = [[tn, fp], [fn, tp]],
        n_samples          = len(y_true),
        n_fatigue_samples  = int(np.sum(y_true == 1)),
        n_baseline_samples = int(np.sum(y_true == 0)),
        threshold          = threshold,
        n_features         = n_features,
    )


# ---------------------------------------------------------------------------
# FatigueHRVPipeline
# ---------------------------------------------------------------------------

class FatigueHRVPipeline:
    """End-to-end HRV fatigue detection: BVP → HRV features → Random Forest.

    Args:
        window_s:       Sliding window length in seconds (default 120 s).
        step_s:         Window stride in seconds (default 60 s).
        sample_rate_hz: BVP sampling rate in Hz (default 64 Hz — WESAD / MAX30102).
        threshold:      Decision probability threshold (default 0.5).
        n_estimators:   Number of trees in the Random Forest (default 100).
        random_state:   Seed for reproducibility (default 42).
    """

    def __init__(
        self,
        window_s:       int   = DEFAULT_WINDOW_S,
        step_s:         int   = DEFAULT_STEP_S,
        sample_rate_hz: int   = DEFAULT_SAMPLE_RATE,
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

        self._model                              = None  # RandomForestClassifier
        self._scaler_mean: np.ndarray | None     = None
        self._scaler_std:  np.ndarray | None     = None
        self._feature_importances: np.ndarray | None = None
        self._fitted: bool                       = False

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
        verbose:   int = 0,
    ) -> "FatigueHRVPipeline":
        """Extract HRV features, scale, and train the Random Forest.

        Args:
            df:        Fovet-format DataFrame (sensor_type="hr", value_1=BVP).
            label_col: Binary label column (1=fatigue, 0=baseline).
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
        self._model.fit(Xs, y)
        self._feature_importances = self._model.feature_importances_

        if verbose > 0:
            print(
                f"FatigueHRVPipeline fitted: {len(X)} windows, {N_FEATURES} features, "
                f"{self.n_estimators} trees"
            )

        self._fitted = True
        return self

    # ------------------------------------------------------------------
    # predict
    # ------------------------------------------------------------------

    def predict_proba(self, df: pd.DataFrame) -> np.ndarray:
        """Return fatigue probability scores for each window (0–1).

        Args:
            df: Fovet-format DataFrame with BVP signal.

        Returns:
            1-D float64 array of probabilities, one per window.

        Raises:
            RuntimeError: If fit() has not been called.
        """
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
        return self._model.predict_proba(Xs)[:, 1]  # P(fatigue)

    def predict(self, df: pd.DataFrame) -> np.ndarray:
        """Return binary predictions (1=fatigue, 0=baseline) for each window."""
        return (self.predict_proba(df) >= self.threshold).astype(np.int32)

    # ------------------------------------------------------------------
    # evaluate
    # ------------------------------------------------------------------

    def evaluate(
        self,
        df: pd.DataFrame,
        *,
        label_col: str = "label",
    ) -> FatigueHRVReport:
        """Evaluate model on a labelled DataFrame.

        Args:
            df:        Fovet-format DataFrame with BVP and labels.
            label_col: Label column name.

        Returns:
            FatigueHRVReport with AUC, precision, recall, F1.
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
          - fatigue_hrv_model.pkl        (serialized RandomForest — joblib)
          - fatigue_hrv_config.json      (metadata: features, scaler, threshold)
          - fatigue_hrv_thresholds.h     (C header for Sentinelle MCU)

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

        # --- Serialized RandomForest model ---
        model_path = output_dir / "fatigue_hrv_model.pkl"
        joblib.dump(self._model, model_path)

        # --- Config JSON ---
        config: dict = {
            "detector":            "fatigue_hrv",
            "n_features":          N_FEATURES,
            "feature_names":       FEATURE_NAMES,
            "threshold":           self.threshold,
            "window_s":            self.window_s,
            "step_s":              self.step_s,
            "sample_rate_hz":      self.sample_rate_hz,
            "n_estimators":        self.n_estimators,
            "scaler_mean":         self._scaler_mean.tolist(),
            "scaler_std":          self._scaler_std.tolist(),
            "feature_importances": (
                self._feature_importances.tolist()
                if self._feature_importances is not None else []
            ),
        }
        cfg_path = output_dir / "fatigue_hrv_config.json"
        cfg_path.write_text(json.dumps(config, indent=2), encoding="utf-8")

        # --- C header for Sentinelle MCU (H2.3) ---
        # Derive RMSSD / HR thresholds from original-space feature statistics.
        # rmssd is FEATURE_NAMES index 2, mean_hr is index 4.
        rmssd_idx = FEATURE_NAMES.index("rmssd")
        hr_idx    = FEATURE_NAMES.index("mean_hr")

        rmssd_mean = float(self._scaler_mean[rmssd_idx])
        rmssd_std  = float(self._scaler_std[rmssd_idx])
        hr_mean    = float(self._scaler_mean[hr_idx])
        hr_std     = float(self._scaler_std[hr_idx])

        # Three-level classification for MCU:
        #   RMSSD > OK_THRESH  → no fatigue
        #   RMSSD < ALERT_THRESH → critical fatigue
        #   in between            → alert
        rmssd_ok    = rmssd_mean + rmssd_std
        rmssd_alert = max(1.0, rmssd_mean - rmssd_std)
        hr_ok       = max(1.0, hr_mean - hr_std)   # low HR = relaxed
        hr_alert    = hr_mean + hr_std              # high HR = fatigued

        h_lines = [
            "/* Auto-generated by Fovet Forge — do not edit */",
            "#ifndef FOVET_FATIGUE_HRV_THRESHOLDS_H",
            "#define FOVET_FATIGUE_HRV_THRESHOLDS_H",
            "",
            "/**",
            " * HRV-based fatigue classification thresholds.",
            " * Generated by FatigueHRVPipeline.export().",
            " *",
            f" * Features : {', '.join(FEATURE_NAMES)}",
            f" * Window   : {self.window_s} s @ {self.sample_rate_hz} Hz",
            " */",
            "",
            f"#define FOVET_FATIGUE_N_FEATURES       {N_FEATURES}",
            f"#define FOVET_FATIGUE_SAMPLE_RATE_HZ   {self.sample_rate_hz}",
            f"#define FOVET_FATIGUE_WINDOW_S          {self.window_s}",
            f"#define FOVET_FATIGUE_STEP_S            {self.step_s}",
            "",
            "/* RMSSD thresholds (ms) — primary fatigue indicator           */",
            "/* RMSSD > FOVET_FATIGUE_RMSSD_OK    : no fatigue             */",
            "/* RMSSD < FOVET_FATIGUE_RMSSD_ALERT : critical fatigue       */",
            "/* in between                         : alert state            */",
            f"#define FOVET_FATIGUE_RMSSD_OK          {rmssd_ok:.1f}f",
            f"#define FOVET_FATIGUE_RMSSD_ALERT       {rmssd_alert:.1f}f",
            "",
            "/* Mean HR thresholds (bpm) — secondary indicator             */",
            "/* HR < FOVET_FATIGUE_HR_OK           : relaxed               */",
            "/* HR > FOVET_FATIGUE_HR_ALERT        : elevated, possible fatigue */",
            f"#define FOVET_FATIGUE_HR_OK             {hr_ok:.1f}f",
            f"#define FOVET_FATIGUE_HR_ALERT          {hr_alert:.1f}f",
            "",
            "#endif /* FOVET_FATIGUE_HRV_THRESHOLDS_H */",
        ]
        h_path = output_dir / "fatigue_hrv_thresholds.h"
        h_path.write_text("\n".join(h_lines) + "\n", encoding="utf-8")

        return {
            "model":  model_path,
            "config": cfg_path,
            "header": h_path,
        }
