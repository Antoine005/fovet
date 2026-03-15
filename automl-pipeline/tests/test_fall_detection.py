"""
Tests for forge.pipelines.fall_detection

Groups:
  - Feature extraction (no TF required)
  - synthesize_fall_data
  - FallDetectionReport
  - FallDetectionPipeline  (requires tensorflow — skipped if absent)
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

try:
    from forge.pipelines.fall_detection import (
        N_FEATURES,
        FEATURE_NAMES,
        DEFAULT_WINDOW_SAMPLES,
        FallDetectionReport,
        _compute_magnitude,
        _extract_window,
        _compute_report,
        extract_features,
        synthesize_fall_data,
    )
except ModuleNotFoundError:
    pytest.skip(
        "forge.pipelines.fall_detection not available (monitoring/human branch only)",
        allow_module_level=True,
    )

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

TF_AVAILABLE = pytest.importorskip("tensorflow", reason="tensorflow not installed")

RNG = np.random.default_rng(0)

def _make_imu_df(n: int = 200, fall_start: int = 150) -> pd.DataFrame:
    """Synthetic IMU DataFrame with a simple fall at fall_start."""
    ax = RNG.normal(0.0, 0.05, n).astype(np.float32)
    ay = RNG.normal(0.0, 0.05, n).astype(np.float32)
    az = RNG.normal(1.0, 0.05, n).astype(np.float32)
    labels = np.zeros(n, dtype=np.int32)
    labels[fall_start:] = 1
    return pd.DataFrame({
        "timestamp_ms": np.arange(n) * 40,
        "sensor_type":  "imu",
        "value_1":      ax,
        "value_2":      ay,
        "value_3":      az,
        "label":        labels,
    })


# ---------------------------------------------------------------------------
# _compute_magnitude
# ---------------------------------------------------------------------------

class TestComputeMagnitude:
    def test_pure_gravity(self):
        az = np.ones(10, dtype=np.float64)
        mag = _compute_magnitude(np.zeros(10), np.zeros(10), az)
        np.testing.assert_allclose(mag, 1.0, atol=1e-6)

    def test_pythagorean_3_4_5(self):
        ax = np.full(5, 3.0)
        ay = np.full(5, 4.0)
        az = np.zeros(5)
        mag = _compute_magnitude(ax, ay, az)
        np.testing.assert_allclose(mag, 5.0, atol=1e-5)


# ---------------------------------------------------------------------------
# _extract_window
# ---------------------------------------------------------------------------

class TestExtractWindow:
    def test_output_shape(self):
        mag = np.ones(50, dtype=np.float64)
        feat = _extract_window(mag)
        assert feat.shape == (N_FEATURES,)

    def test_output_dtype(self):
        feat = _extract_window(np.ones(50))
        assert feat.dtype == np.float32

    def test_constant_signal_std_zero(self):
        feat = _extract_window(np.full(50, 1.0))
        # std = 0, kurtosis undefined for constant, but no exception
        assert feat[1] == pytest.approx(0.0, abs=1e-5)  # magnitude_std

    def test_mean_feature(self):
        mag = np.full(50, 2.5, dtype=np.float64)
        feat = _extract_window(mag)
        assert feat[0] == pytest.approx(2.5, abs=1e-4)  # magnitude_mean

    def test_min_max_features(self):
        mag = np.arange(50, dtype=np.float64)
        feat = _extract_window(mag)
        assert feat[2] == pytest.approx(0.0,  abs=1e-4)  # min
        assert feat[3] == pytest.approx(49.0, abs=1e-4)  # max

    def test_peak_to_peak(self):
        mag = np.arange(50, dtype=np.float64)
        feat = _extract_window(mag)
        assert feat[8] == pytest.approx(49.0, abs=1e-4)  # peak_to_peak = max - min

    def test_zero_crossing_rate_zero_for_constant(self):
        feat = _extract_window(np.full(50, 1.0))
        assert feat[7] == pytest.approx(0.0, abs=1e-5)  # ZCR

    def test_signal_energy_positive(self):
        feat = _extract_window(np.abs(np.random.randn(50)))
        assert feat[9] > 0.0  # signal_energy

    def test_empty_returns_zeros(self):
        feat = _extract_window(np.array([]))
        assert np.all(feat == 0.0)


# ---------------------------------------------------------------------------
# extract_features
# ---------------------------------------------------------------------------

class TestExtractFeatures:
    def test_output_shape(self):
        df = _make_imu_df(200)
        X, y = extract_features(df, window_samples=50, step_samples=25)
        assert X.ndim == 2
        assert X.shape[1] == N_FEATURES

    def test_window_count(self):
        df = _make_imu_df(200)
        X, y = extract_features(df, window_samples=50, step_samples=25)
        # windows = floor((200 - 50) / 25) + 1 = 7
        assert X.shape[0] == 7

    def test_label_shape_matches_X(self):
        df = _make_imu_df(200)
        X, y = extract_features(df, window_samples=50, step_samples=25)
        assert y is not None
        assert y.shape == (X.shape[0],)

    def test_label_dtype(self):
        df = _make_imu_df(200)
        _, y = extract_features(df, window_samples=50, step_samples=25)
        assert y is not None
        assert y.dtype == np.int32

    def test_no_label_col_returns_none(self):
        df = _make_imu_df(200).drop(columns=["label"])
        X, y = extract_features(df, window_samples=50, step_samples=25, label_col=None)
        assert y is None

    def test_window_too_small_raises(self):
        df = _make_imu_df(200)
        with pytest.raises(ValueError, match="window_samples"):
            extract_features(df, window_samples=1)

    def test_df_shorter_than_window_raises(self):
        df = _make_imu_df(30)
        with pytest.raises(ValueError, match="only 30 rows"):
            extract_features(df, window_samples=50)

    def test_missing_column_raises(self):
        df = _make_imu_df(200).drop(columns=["value_1"])
        with pytest.raises(ValueError, match="value_1"):
            extract_features(df)

    def test_feature_dtype_float32(self):
        df = _make_imu_df(200)
        X, _ = extract_features(df, window_samples=50, step_samples=25)
        assert X.dtype == np.float32


# ---------------------------------------------------------------------------
# synthesize_fall_data
# ---------------------------------------------------------------------------

class TestSynthesizeFallData:
    def test_returns_dataframe(self):
        df = synthesize_fall_data(n_normal=100, n_fall=40)
        assert isinstance(df, pd.DataFrame)

    def test_total_rows(self):
        df = synthesize_fall_data(n_normal=100, n_fall=40)
        assert len(df) == 140

    def test_has_required_columns(self):
        df = synthesize_fall_data(n_normal=100, n_fall=40)
        for col in ["timestamp_ms", "sensor_type", "value_1", "value_2", "value_3", "label"]:
            assert col in df.columns

    def test_label_values_binary(self):
        df = synthesize_fall_data(n_normal=100, n_fall=40)
        assert set(df["label"].unique()).issubset({0, 1})

    def test_fall_samples_labelled_1(self):
        df = synthesize_fall_data(n_normal=100, n_fall=40)
        assert df["label"].sum() == 40

    def test_sensor_type_is_imu(self):
        df = synthesize_fall_data(n_normal=50, n_fall=20)
        assert (df["sensor_type"] == "imu").all()

    def test_reproducible_with_rng(self):
        df1 = synthesize_fall_data(n_normal=50, n_fall=20, rng=np.random.default_rng(7))
        df2 = synthesize_fall_data(n_normal=50, n_fall=20, rng=np.random.default_rng(7))
        pd.testing.assert_frame_equal(df1, df2)


# ---------------------------------------------------------------------------
# FallDetectionReport / _compute_report
# ---------------------------------------------------------------------------

class TestFallDetectionReport:
    def _perfect_report(self):
        y_true = np.array([0, 0, 0, 1, 1, 1], dtype=np.int32)
        y_pred = np.array([0.1, 0.1, 0.1, 0.9, 0.9, 0.9], dtype=np.float32)
        return _compute_report(y_true, y_pred, 0.5, N_FEATURES)

    def test_perfect_precision_1(self):
        r = self._perfect_report()
        assert r.precision == pytest.approx(1.0)

    def test_perfect_recall_1(self):
        r = self._perfect_report()
        assert r.recall == pytest.approx(1.0)

    def test_perfect_f1_1(self):
        r = self._perfect_report()
        assert r.f1 == pytest.approx(1.0)

    def test_confusion_matrix_shape(self):
        r = self._perfect_report()
        assert len(r.confusion_matrix) == 2
        assert len(r.confusion_matrix[0]) == 2

    def test_meets_spec_true(self):
        r = self._perfect_report()
        assert r.meets_spec() is True

    def test_meets_spec_false_low_precision(self):
        y_true = np.array([0, 0, 0, 0, 1], dtype=np.int32)
        y_pred = np.array([0.9, 0.9, 0.9, 0.1, 0.9], dtype=np.float32)
        r = _compute_report(y_true, y_pred, 0.5, N_FEATURES)
        assert r.meets_spec() is False

    def test_as_dict_keys(self):
        r = self._perfect_report()
        d = r.as_dict()
        assert "precision" in d and "recall" in d and "f1" in d

    def test_str_contains_precision(self):
        r = self._perfect_report()
        assert "Precision" in str(r)


# ---------------------------------------------------------------------------
# FallDetectionPipeline  (TF required)
# ---------------------------------------------------------------------------

try:
    import tensorflow  # noqa: F401
    _TF_OK = True
except ImportError:
    _TF_OK = False

pytestmark_tf = pytest.mark.skipif(not _TF_OK, reason="tensorflow not installed")


@pytest.fixture(scope="module")
def fitted_pipeline():
    """Train once for the whole module — expensive."""
    import tensorflow as tf
    tf.random.set_seed(42)
    from forge.pipelines.fall_detection import FallDetectionPipeline
    # Balanced classes (500/500) to ensure the model learns to predict falls
    data = synthesize_fall_data(n_normal=500, n_fall=500, rng=np.random.default_rng(1))
    pipeline = FallDetectionPipeline(epochs=15, window_samples=50, step_samples=25)
    pipeline.fit(data, verbose=0)
    return pipeline


@pytest.fixture(scope="module")
def exported_dir(fitted_pipeline, tmp_path_factory):
    out = tmp_path_factory.mktemp("fall_export")
    fitted_pipeline.export(out)
    return out


@pytestmark_tf
class TestFallDetectionPipeline:
    def test_fit_sets_fitted_flag(self):
        from forge.pipelines.fall_detection import FallDetectionPipeline
        data = synthesize_fall_data(n_normal=200, n_fall=50)
        p = FallDetectionPipeline(epochs=2)
        p.fit(data, verbose=0)
        assert p._fitted is True

    def test_predict_proba_shape(self, fitted_pipeline):
        data = synthesize_fall_data(n_normal=100, n_fall=30)
        proba = fitted_pipeline.predict_proba(data)
        assert proba.ndim == 1
        assert len(proba) > 0

    def test_predict_proba_range(self, fitted_pipeline):
        data = synthesize_fall_data(n_normal=100, n_fall=30)
        proba = fitted_pipeline.predict_proba(data)
        assert np.all(proba >= 0.0) and np.all(proba <= 1.0)

    def test_predict_binary_output(self, fitted_pipeline):
        data = synthesize_fall_data(n_normal=100, n_fall=30)
        preds = fitted_pipeline.predict(data)
        assert set(np.unique(preds)).issubset({0, 1})

    def test_predict_before_fit_raises(self):
        from forge.pipelines.fall_detection import FallDetectionPipeline
        p = FallDetectionPipeline()
        data = synthesize_fall_data(n_normal=100, n_fall=30)
        with pytest.raises(RuntimeError, match="not fitted"):
            p.predict(data)

    def test_evaluate_returns_report(self, fitted_pipeline):
        data = synthesize_fall_data(n_normal=400, n_fall=100)
        r = fitted_pipeline.evaluate(data)
        assert isinstance(r, FallDetectionReport)

    def test_evaluate_precision_positive(self, fitted_pipeline):
        import numpy as np
        # Fixed seed + large enough fall count to guarantee ≥1 fall in test split
        data = synthesize_fall_data(n_normal=400, n_fall=200, rng=np.random.default_rng(42))
        r = fitted_pipeline.evaluate(data)
        assert r.precision > 0.0

    def test_export_creates_tflite(self, exported_dir):
        assert (exported_dir / "fall_detection.tflite").exists()

    def test_export_creates_header(self, exported_dir):
        assert (exported_dir / "fall_detection_model.h").exists()

    def test_export_creates_source(self, exported_dir):
        assert (exported_dir / "fall_detection_model.cc").exists()

    def test_export_creates_config_json(self, exported_dir):
        assert (exported_dir / "fall_detection_config.json").exists()

    def test_tflite_file_non_empty(self, exported_dir):
        size = (exported_dir / "fall_detection.tflite").stat().st_size
        assert size > 0

    def test_tflite_size_under_32kb(self, exported_dir):
        size = (exported_dir / "fall_detection.tflite").stat().st_size
        assert size < 32 * 1024, f"TFLite model too large: {size} bytes"

    def test_header_guard(self, exported_dir):
        content = (exported_dir / "fall_detection_model.h").read_text()
        assert "FOVET_FALL_DETECTION_MODEL_H" in content

    def test_header_n_features_define(self, exported_dir):
        content = (exported_dir / "fall_detection_model.h").read_text()
        assert f"FOVET_FALL_DETECTION_N_FEATURES  {N_FEATURES}" in content

    def test_header_threshold_define(self, exported_dir):
        content = (exported_dir / "fall_detection_model.h").read_text()
        assert "FOVET_FALL_DETECTION_THRESHOLD" in content

    def test_header_extern_array(self, exported_dir):
        content = (exported_dir / "fall_detection_model.h").read_text()
        assert "g_fall_detection_model" in content

    def test_source_byte_array(self, exported_dir):
        content = (exported_dir / "fall_detection_model.cc").read_text()
        assert "g_fall_detection_model" in content
        assert "0x" in content

    def test_config_json_valid(self, exported_dir):
        cfg = json.loads((exported_dir / "fall_detection_config.json").read_text())
        assert cfg["n_features"] == N_FEATURES
        assert cfg["detector"] == "fall_detection"

    def test_config_json_has_scaler(self, exported_dir):
        cfg = json.loads((exported_dir / "fall_detection_config.json").read_text())
        assert "scaler_mean" in cfg
        assert len(cfg["scaler_mean"]) == N_FEATURES

    def test_export_before_fit_raises(self, tmp_path):
        from forge.pipelines.fall_detection import FallDetectionPipeline
        p = FallDetectionPipeline()
        with pytest.raises(RuntimeError, match="not fitted"):
            p.export(tmp_path / "out")
