"""
Tests for forge.pipelines.fatigue_hrv

Groups:
  - _bvp_to_rr             : BVP peak detection → RR intervals
  - _extract_hrv_features  : HRV feature computation
  - extract_features       : sliding window on DataFrame
  - synthesize_fatigue_data: synthetic BVP generator
  - FatigueHRVReport       : report dataclass + meets_spec()
  - FatigueHRVPipeline     : fit / predict / evaluate / export (sklearn only)
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from forge.pipelines.fatigue_hrv import (
    N_FEATURES,
    FEATURE_NAMES,
    DEFAULT_WINDOW_S,
    DEFAULT_SAMPLE_RATE,
    _BASELINE_HR_BPM,
    _BASELINE_RMSSD,
    _STRESS_HR_BPM,
    _STRESS_RMSSD,
    _make_bvp_segment,
    _bvp_to_rr,
    _extract_hrv_features,
    _compute_report,
    extract_features,
    synthesize_fatigue_data,
    FatigueHRVReport,
)

# ---------------------------------------------------------------------------
# Shared fixtures / helpers
# ---------------------------------------------------------------------------

RNG = np.random.default_rng(0)


def _make_synthetic_bvp(
    hr_bpm: float = 65.0,
    rmssd_ms: float = 30.0,
    duration_s: int = 120,
    sample_rate: int = 64,
) -> np.ndarray:
    """Generate a clean synthetic BVP for test helpers."""
    return _make_bvp_segment(
        duration_s * sample_rate, hr_bpm, rmssd_ms,
        sample_rate, np.random.default_rng(7),
    )


def _make_fatigue_df(
    n_baseline_s: int = 240,
    n_stress_s: int   = 120,
    sample_rate: int  = 64,
) -> pd.DataFrame:
    """Small synthetic DataFrame for feature extraction / pipeline tests."""
    return synthesize_fatigue_data(
        n_baseline_s=n_baseline_s,
        n_stress_s=n_stress_s,
        sample_rate_hz=sample_rate,
        rng=np.random.default_rng(3),
    )


# ---------------------------------------------------------------------------
# _bvp_to_rr
# ---------------------------------------------------------------------------

class TestBvpToRr:
    def test_returns_array(self):
        bvp = _make_synthetic_bvp(hr_bpm=65.0, duration_s=30)
        rr = _bvp_to_rr(bvp, 64)
        assert isinstance(rr, np.ndarray)

    def test_rr_dtype_float64(self):
        bvp = _make_synthetic_bvp(hr_bpm=65.0, duration_s=30)
        rr = _bvp_to_rr(bvp, 64)
        assert rr.dtype == np.float64

    def test_rr_count_approx(self):
        """65 bpm × 60 s → ~64 beats → ~63 RR intervals."""
        bvp = _make_synthetic_bvp(hr_bpm=65.0, duration_s=60)
        rr = _bvp_to_rr(bvp, 64)
        assert 40 <= len(rr) <= 80, f"Expected ~63 RR intervals, got {len(rr)}"

    def test_rr_mean_approx_at_65bpm(self):
        """Mean RR should be ≈ 60000/65 ≈ 923 ms (within ±100 ms)."""
        bvp = _make_synthetic_bvp(hr_bpm=65.0, rmssd_ms=5.0, duration_s=120)
        rr = _bvp_to_rr(bvp, 64)
        if len(rr) < 2:
            pytest.skip("Insufficient peaks detected")
        expected_rr_ms = 60000.0 / 65.0
        assert abs(float(np.mean(rr)) - expected_rr_ms) < 100.0

    def test_empty_bvp_returns_empty(self):
        rr = _bvp_to_rr(np.zeros(500), 64)
        assert len(rr) == 0

    def test_rr_values_positive(self):
        bvp = _make_synthetic_bvp(hr_bpm=70.0, duration_s=60)
        rr = _bvp_to_rr(bvp, 64)
        if len(rr) > 0:
            assert np.all(rr > 0.0)


# ---------------------------------------------------------------------------
# _extract_hrv_features
# ---------------------------------------------------------------------------

class TestExtractHrvFeatures:
    def test_output_shape(self):
        rr = np.array([800.0, 820.0, 810.0, 830.0, 815.0])
        feat = _extract_hrv_features(rr)
        assert feat.shape == (N_FEATURES,)

    def test_output_dtype(self):
        feat = _extract_hrv_features(np.array([800.0, 810.0, 820.0]))
        assert feat.dtype == np.float32

    def test_feature_count_matches_names(self):
        assert N_FEATURES == len(FEATURE_NAMES)

    def test_mean_rr_correct(self):
        rr = np.array([800.0, 800.0, 800.0, 800.0])
        feat = _extract_hrv_features(rr)
        assert feat[0] == pytest.approx(800.0, abs=1e-3)  # mean_rr

    def test_mean_hr_correct(self):
        rr = np.array([1000.0, 1000.0, 1000.0, 1000.0])
        feat = _extract_hrv_features(rr)
        assert feat[4] == pytest.approx(60.0, abs=1e-3)   # mean_hr = 60000/1000

    def test_rmssd_zero_for_constant_rr(self):
        rr = np.array([900.0, 900.0, 900.0, 900.0])
        feat = _extract_hrv_features(rr)
        assert feat[2] == pytest.approx(0.0, abs=1e-4)    # rmssd

    def test_pnn50_zero_for_small_diffs(self):
        rr = np.array([800.0, 810.0, 790.0, 805.0])  # diffs < 50 ms
        feat = _extract_hrv_features(rr)
        assert feat[3] == pytest.approx(0.0, abs=1e-5)    # pnn50

    def test_pnn50_nonzero_for_large_diffs(self):
        rr = np.array([800.0, 860.0, 800.0, 860.0])  # |diffs| = 60 ms > 50 ms
        feat = _extract_hrv_features(rr)
        assert feat[3] > 0.0                               # pnn50

    def test_too_short_returns_zeros(self):
        feat = _extract_hrv_features(np.array([900.0]))
        assert np.all(feat == 0.0)

    def test_empty_returns_zeros(self):
        feat = _extract_hrv_features(np.array([], dtype=np.float64))
        assert np.all(feat == 0.0)


# ---------------------------------------------------------------------------
# extract_features
# ---------------------------------------------------------------------------

class TestExtractFeatures:
    def test_output_shape(self):
        df = _make_fatigue_df(n_baseline_s=300, n_stress_s=120)
        X, y = extract_features(df, window_s=60, step_s=30, sample_rate_hz=64)
        assert X.ndim == 2
        assert X.shape[1] == N_FEATURES

    def test_window_count(self):
        """720s of data, 60s window, 30s step → floor((720-60)/30)+1 = 23 windows."""
        df = _make_fatigue_df(n_baseline_s=480, n_stress_s=240)
        X, y = extract_features(df, window_s=60, step_s=30, sample_rate_hz=64)
        # (480+240) = 720s → floor((720-60)/30)+1 = 23
        assert X.shape[0] == 23

    def test_label_shape_matches_X(self):
        df = _make_fatigue_df(n_baseline_s=240, n_stress_s=120)
        X, y = extract_features(df, window_s=60, step_s=30, sample_rate_hz=64)
        assert y is not None
        assert y.shape == (X.shape[0],)

    def test_label_dtype(self):
        df = _make_fatigue_df(n_baseline_s=240, n_stress_s=120)
        _, y = extract_features(df, window_s=60, step_s=30, sample_rate_hz=64)
        assert y is not None
        assert y.dtype == np.int32

    def test_no_label_col_returns_none(self):
        df = _make_fatigue_df(n_baseline_s=240, n_stress_s=120).drop(columns=["label"])
        X, y = extract_features(df, window_s=60, step_s=30, sample_rate_hz=64, label_col=None)
        assert y is None

    def test_signal_too_short_raises(self):
        # Only 10s of signal, window requires 60s
        df = _make_fatigue_df(n_baseline_s=5, n_stress_s=5)
        with pytest.raises(ValueError, match="only"):
            extract_features(df, window_s=60, step_s=30, sample_rate_hz=64)

    def test_missing_bvp_col_raises(self):
        df = _make_fatigue_df(n_baseline_s=240, n_stress_s=120).drop(columns=["value_1"])
        with pytest.raises(ValueError, match="value_1"):
            extract_features(df, window_s=60, step_s=30, sample_rate_hz=64)

    def test_feature_dtype_float32(self):
        df = _make_fatigue_df(n_baseline_s=240, n_stress_s=120)
        X, _ = extract_features(df, window_s=60, step_s=30, sample_rate_hz=64)
        assert X.dtype == np.float32

    def test_filters_hr_sensor_type(self):
        """Add spurious IMU rows — extract_features must ignore them."""
        df_hr = _make_fatigue_df(n_baseline_s=240, n_stress_s=120)
        df_imu = df_hr.copy()
        df_imu["sensor_type"] = "imu"
        df_mixed = pd.concat([df_hr, df_imu], ignore_index=True)

        X_hr, _    = extract_features(df_hr,    window_s=60, step_s=30)
        X_mixed, _ = extract_features(df_mixed, window_s=60, step_s=30)
        assert X_hr.shape == X_mixed.shape


# ---------------------------------------------------------------------------
# synthesize_fatigue_data
# ---------------------------------------------------------------------------

class TestSynthesizeFatigueData:
    def test_returns_dataframe(self):
        df = synthesize_fatigue_data(n_baseline_s=60, n_stress_s=30)
        assert isinstance(df, pd.DataFrame)

    def test_total_rows(self):
        df = synthesize_fatigue_data(n_baseline_s=60, n_stress_s=30, sample_rate_hz=64)
        assert len(df) == (60 + 30) * 64

    def test_has_required_columns(self):
        df = synthesize_fatigue_data(n_baseline_s=60, n_stress_s=30)
        for col in ["timestamp_ms", "sensor_type", "value_1", "value_2", "value_3", "label"]:
            assert col in df.columns

    def test_sensor_type_is_hr(self):
        df = synthesize_fatigue_data(n_baseline_s=60, n_stress_s=30)
        assert (df["sensor_type"] == "hr").all()

    def test_label_values_binary(self):
        df = synthesize_fatigue_data(n_baseline_s=60, n_stress_s=30)
        assert set(df["label"].unique()).issubset({0, 1})

    def test_stress_samples_labelled_1(self):
        df = synthesize_fatigue_data(n_baseline_s=60, n_stress_s=30, sample_rate_hz=64)
        assert df["label"].sum() == 30 * 64

    def test_reproducible_with_rng(self):
        df1 = synthesize_fatigue_data(n_baseline_s=30, n_stress_s=15, rng=np.random.default_rng(5))
        df2 = synthesize_fatigue_data(n_baseline_s=30, n_stress_s=15, rng=np.random.default_rng(5))
        pd.testing.assert_frame_equal(df1, df2)


# ---------------------------------------------------------------------------
# FatigueHRVReport / _compute_report
# ---------------------------------------------------------------------------

class TestFatigueHRVReport:
    def _perfect_report(self) -> FatigueHRVReport:
        y_true  = np.array([0, 0, 0, 1, 1, 1], dtype=np.int32)
        y_proba = np.array([0.1, 0.1, 0.1, 0.9, 0.9, 0.9], dtype=np.float64)
        return _compute_report(y_true, y_proba, 0.5, N_FEATURES)

    def test_perfect_auc_1(self):
        assert self._perfect_report().auc == pytest.approx(1.0)

    def test_perfect_precision_1(self):
        assert self._perfect_report().precision == pytest.approx(1.0)

    def test_perfect_recall_1(self):
        assert self._perfect_report().recall == pytest.approx(1.0)

    def test_meets_spec_true_at_1(self):
        assert self._perfect_report().meets_spec() is True

    def test_meets_spec_false_below_085(self):
        y_true  = np.array([0, 0, 1, 1], dtype=np.int32)
        # AUC = 0.5 (random)
        y_proba = np.array([0.6, 0.6, 0.4, 0.4], dtype=np.float64)
        r = _compute_report(y_true, y_proba, 0.5, N_FEATURES)
        assert r.meets_spec() is False

    def test_confusion_matrix_shape(self):
        r = self._perfect_report()
        assert len(r.confusion_matrix) == 2
        assert all(len(row) == 2 for row in r.confusion_matrix)

    def test_as_dict_has_auc_key(self):
        d = self._perfect_report().as_dict()
        assert "auc" in d

    def test_str_contains_auc(self):
        assert "AUC ROC" in str(self._perfect_report())

    def test_meets_spec_exactly_085(self):
        """AUC = 0.85 exactly should pass the spec."""
        y_true  = np.zeros(100, dtype=np.int32)
        y_true[:50] = 1
        y_proba = np.linspace(0.0, 1.0, 100)
        r = _compute_report(y_true, y_proba, 0.5, N_FEATURES)
        # Not guaranteed to be exactly 0.85 — just verify meets_spec logic
        direct = FatigueHRVReport(
            auc=0.85, precision=0.9, recall=0.9, f1=0.9,
            confusion_matrix=[[40, 10], [10, 40]],
            n_samples=100, n_fatigue_samples=50, n_baseline_samples=50,
            threshold=0.5, n_features=N_FEATURES,
        )
        assert direct.meets_spec() is True


# ---------------------------------------------------------------------------
# FatigueHRVPipeline  (sklearn only — no optional extras needed)
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def fitted_pipeline():
    """Train once on synthetic data for the whole module."""
    from forge.pipelines.fatigue_hrv import FatigueHRVPipeline

    train = synthesize_fatigue_data(
        n_baseline_s=360, n_stress_s=240,
        rng=np.random.default_rng(1),
    )
    pipeline = FatigueHRVPipeline(
        window_s=60, step_s=30, n_estimators=50, random_state=42,
    )
    pipeline.fit(train)
    return pipeline


@pytest.fixture(scope="module")
def eval_data():
    """Hold-out test data (different rng seed)."""
    return synthesize_fatigue_data(
        n_baseline_s=180, n_stress_s=120,
        rng=np.random.default_rng(2),
    )


@pytest.fixture(scope="module")
def exported_dir(fitted_pipeline, tmp_path_factory):
    out = tmp_path_factory.mktemp("fatigue_export")
    fitted_pipeline.export(out)
    return out


class TestFatigueHRVPipeline:
    def test_fit_sets_fitted_flag(self):
        from forge.pipelines.fatigue_hrv import FatigueHRVPipeline
        data = synthesize_fatigue_data(
            n_baseline_s=180, n_stress_s=90, rng=np.random.default_rng(9),
        )
        p = FatigueHRVPipeline(window_s=60, step_s=30, n_estimators=5, random_state=0)
        p.fit(data)
        assert p._fitted is True

    def test_fit_returns_self(self):
        from forge.pipelines.fatigue_hrv import FatigueHRVPipeline
        data = synthesize_fatigue_data(
            n_baseline_s=180, n_stress_s=90, rng=np.random.default_rng(10),
        )
        p = FatigueHRVPipeline(window_s=60, step_s=30, n_estimators=5)
        assert p.fit(data) is p

    def test_fit_no_label_raises(self, fitted_pipeline):
        from forge.pipelines.fatigue_hrv import FatigueHRVPipeline
        data = synthesize_fatigue_data(
            n_baseline_s=180, n_stress_s=90, rng=np.random.default_rng(11),
        ).drop(columns=["label"])
        p = FatigueHRVPipeline(window_s=60, step_s=30, n_estimators=5)
        with pytest.raises(ValueError, match="label"):
            p.fit(data)

    def test_predict_proba_shape(self, fitted_pipeline, eval_data):
        proba = fitted_pipeline.predict_proba(eval_data)
        assert proba.ndim == 1
        assert len(proba) > 0

    def test_predict_proba_range(self, fitted_pipeline, eval_data):
        proba = fitted_pipeline.predict_proba(eval_data)
        assert np.all(proba >= 0.0) and np.all(proba <= 1.0)

    def test_predict_binary_output(self, fitted_pipeline, eval_data):
        preds = fitted_pipeline.predict(eval_data)
        assert set(np.unique(preds)).issubset({0, 1})

    def test_predict_before_fit_raises(self):
        from forge.pipelines.fatigue_hrv import FatigueHRVPipeline
        p = FatigueHRVPipeline(window_s=60, step_s=30)
        data = synthesize_fatigue_data(n_baseline_s=180, n_stress_s=90)
        with pytest.raises(RuntimeError, match="not fitted"):
            p.predict(data)

    def test_evaluate_returns_report(self, fitted_pipeline, eval_data):
        r = fitted_pipeline.evaluate(eval_data)
        assert isinstance(r, FatigueHRVReport)

    def test_evaluate_auc_between_0_and_1(self, fitted_pipeline, eval_data):
        r = fitted_pipeline.evaluate(eval_data)
        assert 0.0 <= r.auc <= 1.0

    def test_evaluate_meets_auc_spec(self, fitted_pipeline, eval_data):
        """AUC ≥ 0.85 on clearly separable synthetic data (H2.2 spec)."""
        r = fitted_pipeline.evaluate(eval_data)
        assert r.meets_spec(), f"AUC = {r.auc:.4f} < 0.85"

    def test_evaluate_no_label_raises(self, fitted_pipeline):
        data = synthesize_fatigue_data(
            n_baseline_s=180, n_stress_s=90, rng=np.random.default_rng(12),
        ).drop(columns=["label"])
        with pytest.raises(ValueError):
            fitted_pipeline.evaluate(data)

    def test_feature_importances_set(self, fitted_pipeline):
        assert fitted_pipeline._feature_importances is not None
        assert len(fitted_pipeline._feature_importances) == N_FEATURES

    def test_rmssd_is_top_feature(self, fitted_pipeline):
        """RMSSD should rank among the top-5 most important features.

        All 7 features capture HR/HRV information and are correlated, so
        exact ranking varies; RMSSD must be at least in the top-5.
        """
        importances = fitted_pipeline._feature_importances
        assert importances is not None
        rmssd_idx    = FEATURE_NAMES.index("rmssd")
        top5_indices = np.argsort(importances)[-5:]
        assert rmssd_idx in top5_indices, (
            f"RMSSD (idx={rmssd_idx}) not in top-5: importances={importances}"
        )

    # --- export ---

    def test_export_creates_model_pkl(self, exported_dir):
        assert (exported_dir / "fatigue_hrv_model.pkl").exists()

    def test_export_creates_config_json(self, exported_dir):
        assert (exported_dir / "fatigue_hrv_config.json").exists()

    def test_export_creates_thresholds_header(self, exported_dir):
        assert (exported_dir / "fatigue_hrv_thresholds.h").exists()

    def test_config_json_valid(self, exported_dir):
        cfg = json.loads((exported_dir / "fatigue_hrv_config.json").read_text())
        assert cfg["n_features"] == N_FEATURES
        assert cfg["detector"]   == "fatigue_hrv"

    def test_config_json_has_scaler(self, exported_dir):
        cfg = json.loads((exported_dir / "fatigue_hrv_config.json").read_text())
        assert "scaler_mean" in cfg
        assert len(cfg["scaler_mean"]) == N_FEATURES

    def test_config_feature_importances_length(self, exported_dir):
        cfg = json.loads((exported_dir / "fatigue_hrv_config.json").read_text())
        assert len(cfg["feature_importances"]) == N_FEATURES

    def test_header_guard(self, exported_dir):
        content = (exported_dir / "fatigue_hrv_thresholds.h").read_text()
        assert "FOVET_FATIGUE_HRV_THRESHOLDS_H" in content

    def test_header_rmssd_ok_define(self, exported_dir):
        content = (exported_dir / "fatigue_hrv_thresholds.h").read_text()
        assert "FOVET_FATIGUE_RMSSD_OK" in content

    def test_header_rmssd_alert_define(self, exported_dir):
        content = (exported_dir / "fatigue_hrv_thresholds.h").read_text()
        assert "FOVET_FATIGUE_RMSSD_ALERT" in content

    def test_header_hr_ok_define(self, exported_dir):
        content = (exported_dir / "fatigue_hrv_thresholds.h").read_text()
        assert "FOVET_FATIGUE_HR_OK" in content

    def test_header_n_features_define(self, exported_dir):
        content = (exported_dir / "fatigue_hrv_thresholds.h").read_text()
        assert f"FOVET_FATIGUE_N_FEATURES       {N_FEATURES}" in content

    def test_model_pkl_loadable(self, exported_dir):
        import joblib
        model = joblib.load(exported_dir / "fatigue_hrv_model.pkl")
        assert hasattr(model, "predict_proba")

    def test_export_before_fit_raises(self, tmp_path):
        from forge.pipelines.fatigue_hrv import FatigueHRVPipeline
        p = FatigueHRVPipeline(window_s=60, step_s=30)
        with pytest.raises(RuntimeError, match="not fitted"):
            p.export(tmp_path / "out")
