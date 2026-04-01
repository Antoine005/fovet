"""
Tests for forge.pipelines.thermal_stress

Groups:
  - compute_wbgt              : Stull (2011) formula validation
  - _extract_thermal_features : 8-feature vector computation
  - extract_features          : sliding window on DataFrame
  - synthesize_thermal_data   : synthetic DHT22 generator
  - ThermalStressReport       : report dataclass + meets_spec()
  - ThermalStressPipeline     : fit / predict / evaluate / export
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from forge.pipelines.thermal_stress import (
    N_FEATURES,
    FEATURE_NAMES,
    DEFAULT_WINDOW_S,
    DEFAULT_STEP_S,
    DEFAULT_SAMPLE_RATE,
    WBGT_WARN_C,
    WBGT_DANGER_C,
    COLD_ALERT_C,
    compute_wbgt,
    _extract_thermal_features,
    _compute_report,
    extract_features,
    synthesize_thermal_data,
    ThermalStressReport,
)

# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

RNG = np.random.default_rng(0)


def _make_thermal_df(
    n_normal_s: int = 600,
    n_warm_s:   int = 300,
    n_cold_s:   int = 300,
) -> pd.DataFrame:
    """Small synthetic DataFrame for feature extraction / pipeline tests."""
    return synthesize_thermal_data(
        n_normal_s=n_normal_s,
        n_warm_s=n_warm_s,
        n_cold_s=n_cold_s,
        rng=np.random.default_rng(3),
    )


# ---------------------------------------------------------------------------
# compute_wbgt
# ---------------------------------------------------------------------------

class TestComputeWbgt:
    def test_scalar_float(self):
        result = compute_wbgt(22.0, 50.0)
        assert isinstance(float(result), float)

    def test_array_shape_preserved(self):
        t = np.array([20.0, 25.0, 30.0])
        h = np.array([40.0, 60.0, 80.0])
        result = compute_wbgt(t, h)
        assert result.shape == (3,)

    def test_wbgt_increases_with_temperature(self):
        """Higher temperature → higher WBGT at same humidity."""
        w_low  = compute_wbgt(20.0, 50.0)
        w_high = compute_wbgt(35.0, 50.0)
        assert float(w_high) > float(w_low)

    def test_wbgt_increases_with_humidity(self):
        """Higher humidity → higher WBGT at same temperature."""
        w_dry  = compute_wbgt(30.0, 30.0)
        w_wet  = compute_wbgt(30.0, 80.0)
        assert float(w_wet) > float(w_dry)

    def test_wbgt_warn_threshold_at_35c_72pct(self):
        """Synthetic warm scenario (35 °C, 72 %) → WBGT should exceed WBGT_WARN_C=25."""
        wbgt = compute_wbgt(35.0, 72.0)
        assert float(wbgt) >= WBGT_WARN_C

    def test_wbgt_cold_scenario_below_warn(self):
        """Cold scenario (4 °C, 80 %) → WBGT should be well below WBGT_WARN_C=25."""
        wbgt = compute_wbgt(4.0, 80.0)
        assert float(wbgt) < WBGT_WARN_C

    def test_normal_scenario_below_warn(self):
        """Normal scenario (22 °C, 50 %) → WBGT should be below WBGT_WARN_C=25."""
        wbgt = compute_wbgt(22.0, 50.0)
        assert float(wbgt) < WBGT_WARN_C

    def test_wbgt_bounded_below_dry_bulb(self):
        """WBGT ≤ dry bulb temperature (NWB ≤ T always)."""
        t = np.linspace(0.0, 40.0, 20)
        h = np.full(20, 50.0)
        wbgt = compute_wbgt(t, h)
        assert np.all(wbgt <= t + 1.0)  # +1 tolerance for floating-point

    def test_constant_input_returns_scalar_or_array(self):
        result_scalar = compute_wbgt(25.0, 60.0)
        assert np.isfinite(float(result_scalar))


# ---------------------------------------------------------------------------
# _extract_thermal_features
# ---------------------------------------------------------------------------

class TestExtractThermalFeatures:
    def _make_window(
        self, celsius: float = 22.0, humidity: float = 50.0, n: int = 120
    ) -> tuple[np.ndarray, np.ndarray]:
        t = np.full(n, celsius, dtype=np.float64)
        h = np.full(n, humidity, dtype=np.float64)
        return t, h

    def test_output_shape(self):
        t, h = self._make_window()
        feat = _extract_thermal_features(t, h, DEFAULT_SAMPLE_RATE)
        assert feat.shape == (N_FEATURES,)

    def test_output_dtype(self):
        t, h = self._make_window()
        feat = _extract_thermal_features(t, h, DEFAULT_SAMPLE_RATE)
        assert feat.dtype == np.float32

    def test_feature_names_count(self):
        assert N_FEATURES == len(FEATURE_NAMES)

    def test_mean_celsius(self):
        t, h = self._make_window(celsius=30.0)
        feat = _extract_thermal_features(t, h, DEFAULT_SAMPLE_RATE)
        idx = FEATURE_NAMES.index("mean_celsius")
        assert feat[idx] == pytest.approx(30.0, abs=1e-3)

    def test_max_celsius_ge_mean(self):
        t = np.array([20.0, 25.0, 30.0, 22.0], dtype=np.float64)
        h = np.full(4, 50.0, dtype=np.float64)
        feat = _extract_thermal_features(t, h, DEFAULT_SAMPLE_RATE)
        mean_idx = FEATURE_NAMES.index("mean_celsius")
        max_idx  = FEATURE_NAMES.index("max_celsius")
        assert feat[max_idx] >= feat[mean_idx]

    def test_min_celsius_le_mean(self):
        t = np.array([20.0, 25.0, 30.0, 22.0], dtype=np.float64)
        h = np.full(4, 50.0, dtype=np.float64)
        feat = _extract_thermal_features(t, h, DEFAULT_SAMPLE_RATE)
        mean_idx = FEATURE_NAMES.index("mean_celsius")
        min_idx  = FEATURE_NAMES.index("min_celsius")
        assert feat[min_idx] <= feat[mean_idx]

    def test_std_celsius_zero_for_constant(self):
        t, h = self._make_window(celsius=22.0)
        feat = _extract_thermal_features(t, h, DEFAULT_SAMPLE_RATE)
        idx = FEATURE_NAMES.index("std_celsius")
        assert feat[idx] == pytest.approx(0.0, abs=1e-4)

    def test_std_celsius_positive_for_varying(self):
        t = np.array([20.0, 25.0, 30.0, 22.0], dtype=np.float64)
        h = np.full(4, 50.0, dtype=np.float64)
        feat = _extract_thermal_features(t, h, DEFAULT_SAMPLE_RATE)
        idx = FEATURE_NAMES.index("std_celsius")
        assert feat[idx] > 0.0

    def test_mean_humidity(self):
        t, h = self._make_window(humidity=72.0)
        feat = _extract_thermal_features(t, h, DEFAULT_SAMPLE_RATE)
        idx = FEATURE_NAMES.index("mean_humidity")
        assert feat[idx] == pytest.approx(72.0, abs=1e-3)

    def test_mean_wbgt_positive(self):
        t, h = self._make_window(celsius=22.0, humidity=50.0)
        feat = _extract_thermal_features(t, h, DEFAULT_SAMPLE_RATE)
        idx = FEATURE_NAMES.index("mean_wbgt")
        assert feat[idx] > 0.0

    def test_max_wbgt_ge_mean_wbgt(self):
        t, h = self._make_window(celsius=22.0, humidity=50.0)
        feat = _extract_thermal_features(t, h, DEFAULT_SAMPLE_RATE)
        mean_idx = FEATURE_NAMES.index("mean_wbgt")
        max_idx  = FEATURE_NAMES.index("max_wbgt")
        assert feat[max_idx] >= feat[mean_idx]

    def test_trend_celsius_zero_for_constant(self):
        t, h = self._make_window(celsius=22.0)
        feat = _extract_thermal_features(t, h, DEFAULT_SAMPLE_RATE)
        idx = FEATURE_NAMES.index("trend_celsius")
        assert feat[idx] == pytest.approx(0.0, abs=1e-3)

    def test_trend_celsius_positive_for_rising(self):
        n = 60
        t = np.linspace(20.0, 30.0, n)   # rising by +10 °C
        h = np.full(n, 50.0, dtype=np.float64)
        feat = _extract_thermal_features(t, h, DEFAULT_SAMPLE_RATE)
        idx = FEATURE_NAMES.index("trend_celsius")
        assert feat[idx] > 0.0

    def test_trend_celsius_negative_for_cooling(self):
        n = 60
        t = np.linspace(30.0, 20.0, n)   # falling by -10 °C
        h = np.full(n, 50.0, dtype=np.float64)
        feat = _extract_thermal_features(t, h, DEFAULT_SAMPLE_RATE)
        idx = FEATURE_NAMES.index("trend_celsius")
        assert feat[idx] < 0.0

    def test_single_sample_no_crash(self):
        t = np.array([22.0])
        h = np.array([50.0])
        feat = _extract_thermal_features(t, h, DEFAULT_SAMPLE_RATE)
        assert feat.shape == (N_FEATURES,)


# ---------------------------------------------------------------------------
# extract_features
# ---------------------------------------------------------------------------

class TestExtractFeatures:
    def test_output_shape(self):
        df = _make_thermal_df()
        X, y = extract_features(df)
        assert X.ndim == 2
        assert X.shape[1] == N_FEATURES

    def test_label_shape_matches_X(self):
        df = _make_thermal_df()
        X, y = extract_features(df)
        assert y is not None
        assert y.shape == (X.shape[0],)

    def test_label_dtype(self):
        df = _make_thermal_df()
        _, y = extract_features(df)
        assert y is not None
        assert y.dtype == np.int32

    def test_feature_dtype_float32(self):
        df = _make_thermal_df()
        X, _ = extract_features(df)
        assert X.dtype == np.float32

    def test_label_values_binary(self):
        df = _make_thermal_df()
        _, y = extract_features(df)
        assert y is not None
        assert set(np.unique(y)).issubset({0, 1})

    def test_no_label_col_returns_none(self):
        df = _make_thermal_df().drop(columns=["label"])
        X, y = extract_features(df, label_col=None)
        assert y is None

    def test_signal_too_short_raises(self):
        # Only 30s of signal, but default window is 240s
        df = synthesize_thermal_data(n_normal_s=20, n_warm_s=5, n_cold_s=5,
                                     rng=np.random.default_rng(99))
        with pytest.raises(ValueError, match="only"):
            extract_features(df)

    def test_missing_celsius_col_raises(self):
        df = _make_thermal_df().drop(columns=["value_1"])
        with pytest.raises(ValueError, match="value_1"):
            extract_features(df)

    def test_filters_temp_sensor_type(self):
        """Add spurious IMU rows — extract_features must ignore them."""
        df_temp = _make_thermal_df()
        df_imu  = df_temp.copy()
        df_imu["sensor_type"] = "imu"
        df_mixed = pd.concat([df_temp, df_imu], ignore_index=True)

        X_temp,  _ = extract_features(df_temp)
        X_mixed, _ = extract_features(df_mixed)
        assert X_temp.shape == X_mixed.shape

    def test_no_humidity_col_uses_default_50(self):
        """Missing humidity column → default 50 % used without crash."""
        df = _make_thermal_df().drop(columns=["value_2"])
        X, y = extract_features(df, humidity_col="value_2")
        assert X.shape[1] == N_FEATURES

    def test_window_count_custom(self):
        """600s signal, 240s window, 120s step:
        windows = floor((600 - 240) / 120) + 1 = 4 windows."""
        df = synthesize_thermal_data(n_normal_s=600, n_warm_s=0, n_cold_s=0,
                                     rng=np.random.default_rng(7))
        X, _ = extract_features(
            df, window_s=240, step_s=120, sample_rate_hz=DEFAULT_SAMPLE_RATE,
            label_col=None,
        )
        expected = (600 - 240) // 120 + 1
        assert X.shape[0] == expected


# ---------------------------------------------------------------------------
# synthesize_thermal_data
# ---------------------------------------------------------------------------

class TestSynthesizeThermalData:
    def test_returns_dataframe(self):
        df = synthesize_thermal_data(n_normal_s=60, n_warm_s=30, n_cold_s=30)
        assert isinstance(df, pd.DataFrame)

    def test_total_rows(self):
        df = synthesize_thermal_data(n_normal_s=60, n_warm_s=30, n_cold_s=30,
                                     sample_rate_hz=DEFAULT_SAMPLE_RATE)
        # (60+30+30) × 0.5 = 60 rows
        assert len(df) == int((60 + 30 + 30) * DEFAULT_SAMPLE_RATE)

    def test_has_required_columns(self):
        df = synthesize_thermal_data(n_normal_s=60, n_warm_s=30, n_cold_s=30)
        for col in ["timestamp_ms", "sensor_type", "value_1", "value_2", "label"]:
            assert col in df.columns

    def test_sensor_type_is_temp(self):
        df = synthesize_thermal_data(n_normal_s=60, n_warm_s=30, n_cold_s=30)
        assert (df["sensor_type"] == "temp").all()

    def test_label_values_binary(self):
        df = synthesize_thermal_data(n_normal_s=60, n_warm_s=30, n_cold_s=30)
        assert set(df["label"].unique()).issubset({0, 1})

    def test_stress_samples_labelled_1(self):
        df = synthesize_thermal_data(n_normal_s=60, n_warm_s=30, n_cold_s=30,
                                     sample_rate_hz=DEFAULT_SAMPLE_RATE)
        n_stress = int((30 + 30) * DEFAULT_SAMPLE_RATE)
        assert df["label"].sum() == n_stress

    def test_normal_samples_labelled_0(self):
        df = synthesize_thermal_data(n_normal_s=60, n_warm_s=30, n_cold_s=30,
                                     sample_rate_hz=DEFAULT_SAMPLE_RATE)
        n_normal = int(60 * DEFAULT_SAMPLE_RATE)
        assert (df["label"] == 0).sum() == n_normal

    def test_reproducible_with_rng(self):
        df1 = synthesize_thermal_data(n_normal_s=30, n_warm_s=15, n_cold_s=15,
                                      rng=np.random.default_rng(5))
        df2 = synthesize_thermal_data(n_normal_s=30, n_warm_s=15, n_cold_s=15,
                                      rng=np.random.default_rng(5))
        pd.testing.assert_frame_equal(df1, df2)

    def test_warm_segment_celsius_mean_around_35(self):
        """Warm phase mean temperature should be near 35 °C."""
        df = synthesize_thermal_data(n_normal_s=0, n_warm_s=600, n_cold_s=0,
                                     rng=np.random.default_rng(1))
        assert abs(df["value_1"].mean() - 35.0) < 1.0

    def test_cold_segment_celsius_mean_around_4(self):
        """Cold phase mean temperature should be near 4 °C."""
        df = synthesize_thermal_data(n_normal_s=0, n_warm_s=0, n_cold_s=600,
                                     rng=np.random.default_rng(2))
        assert abs(df["value_1"].mean() - 4.0) < 1.0

    def test_humidity_clamped_0_100(self):
        df = synthesize_thermal_data(n_normal_s=120, n_warm_s=60, n_cold_s=60,
                                     rng=np.random.default_rng(0))
        assert df["value_2"].min() >= 0.0
        assert df["value_2"].max() <= 100.0

    def test_timestamp_monotonic(self):
        df = synthesize_thermal_data(n_normal_s=60, n_warm_s=30, n_cold_s=30)
        assert df["timestamp_ms"].is_monotonic_increasing


# ---------------------------------------------------------------------------
# ThermalStressReport / _compute_report
# ---------------------------------------------------------------------------

class TestThermalStressReport:
    def _perfect_report(self) -> ThermalStressReport:
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

    def test_meets_spec_false_below_090(self):
        y_true  = np.array([0, 0, 1, 1], dtype=np.int32)
        y_proba = np.array([0.6, 0.6, 0.4, 0.4], dtype=np.float64)  # AUC = 0.0
        r = _compute_report(y_true, y_proba, 0.5, N_FEATURES)
        assert r.meets_spec() is False

    def test_meets_spec_exactly_090(self):
        r = ThermalStressReport(
            auc=0.90, precision=0.9, recall=0.9, f1=0.9,
            confusion_matrix=[[45, 5], [5, 45]],
            n_samples=100, n_stress_samples=50, n_normal_samples=50,
            threshold=0.5, n_features=N_FEATURES,
        )
        assert r.meets_spec() is True

    def test_meets_spec_just_below_090(self):
        r = ThermalStressReport(
            auc=0.899, precision=0.9, recall=0.9, f1=0.9,
            confusion_matrix=[[45, 5], [5, 45]],
            n_samples=100, n_stress_samples=50, n_normal_samples=50,
            threshold=0.5, n_features=N_FEATURES,
        )
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

    def test_str_contains_spec_marker(self):
        s = str(self._perfect_report())
        assert "YES" in s or "NO" in s

    def test_n_samples_matches_input(self):
        y_true  = np.array([0, 1, 0, 1, 0], dtype=np.int32)
        y_proba = np.array([0.1, 0.9, 0.2, 0.8, 0.15], dtype=np.float64)
        r = _compute_report(y_true, y_proba, 0.5, N_FEATURES)
        assert r.n_samples == 5
        assert r.n_stress_samples == 2
        assert r.n_normal_samples == 3


# ---------------------------------------------------------------------------
# ThermalStressPipeline
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def fitted_pipeline():
    """Train once on synthetic data for the whole module."""
    from forge.pipelines.thermal_stress import ThermalStressPipeline
    train = synthesize_thermal_data(
        n_normal_s=1200, n_warm_s=600, n_cold_s=600,
        rng=np.random.default_rng(1),
    )
    pipeline = ThermalStressPipeline(
        window_s=240, step_s=120, n_estimators=50, random_state=42,
    )
    pipeline.fit(train)
    return pipeline


@pytest.fixture(scope="module")
def eval_data():
    """Hold-out test data (different rng seed)."""
    return synthesize_thermal_data(
        n_normal_s=600, n_warm_s=300, n_cold_s=300,
        rng=np.random.default_rng(2),
    )


@pytest.fixture(scope="module")
def exported_dir(fitted_pipeline, tmp_path_factory):
    out = tmp_path_factory.mktemp("thermal_export")
    fitted_pipeline.export(out)
    return out


class TestThermalStressPipeline:
    def test_fit_sets_fitted_flag(self):
        from forge.pipelines.thermal_stress import ThermalStressPipeline
        data = synthesize_thermal_data(
            n_normal_s=600, n_warm_s=300, n_cold_s=300, rng=np.random.default_rng(9),
        )
        p = ThermalStressPipeline(window_s=240, step_s=120, n_estimators=5, random_state=0)
        p.fit(data)
        assert p._fitted is True

    def test_fit_returns_self(self):
        from forge.pipelines.thermal_stress import ThermalStressPipeline
        data = synthesize_thermal_data(
            n_normal_s=600, n_warm_s=300, n_cold_s=300, rng=np.random.default_rng(10),
        )
        p = ThermalStressPipeline(window_s=240, step_s=120, n_estimators=5)
        assert p.fit(data) is p

    def test_fit_no_label_raises(self):
        from forge.pipelines.thermal_stress import ThermalStressPipeline
        data = synthesize_thermal_data(
            n_normal_s=600, n_warm_s=300, n_cold_s=300, rng=np.random.default_rng(11),
        ).drop(columns=["label"])
        p = ThermalStressPipeline(window_s=240, step_s=120, n_estimators=5)
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
        from forge.pipelines.thermal_stress import ThermalStressPipeline
        p = ThermalStressPipeline(window_s=240, step_s=120)
        data = synthesize_thermal_data(n_normal_s=600, n_warm_s=300, n_cold_s=300)
        with pytest.raises(RuntimeError, match="not fitted"):
            p.predict(data)

    def test_evaluate_returns_report(self, fitted_pipeline, eval_data):
        r = fitted_pipeline.evaluate(eval_data)
        assert isinstance(r, ThermalStressReport)

    def test_evaluate_auc_between_0_and_1(self, fitted_pipeline, eval_data):
        r = fitted_pipeline.evaluate(eval_data)
        assert 0.0 <= r.auc <= 1.0

    def test_evaluate_meets_auc_spec(self, fitted_pipeline, eval_data):
        """AUC ≥ 0.90 on clearly separable synthetic data (H3.2 spec)."""
        r = fitted_pipeline.evaluate(eval_data)
        assert r.meets_spec(), f"AUC = {r.auc:.4f} < 0.90"

    def test_evaluate_no_label_raises(self, fitted_pipeline):
        data = synthesize_thermal_data(
            n_normal_s=600, n_warm_s=300, n_cold_s=300, rng=np.random.default_rng(12),
        ).drop(columns=["label"])
        with pytest.raises(ValueError):
            fitted_pipeline.evaluate(data)

    def test_scaler_fitted(self, fitted_pipeline):
        assert fitted_pipeline._scaler_mean is not None
        assert fitted_pipeline._scaler_std  is not None
        assert len(fitted_pipeline._scaler_mean) == N_FEATURES

    def test_feature_importances_set(self, fitted_pipeline):
        assert fitted_pipeline._feature_importances is not None
        assert len(fitted_pipeline._feature_importances) == N_FEATURES

    def test_wbgt_feature_in_top4(self, fitted_pipeline):
        """mean_wbgt or max_wbgt should rank in the top-4 most important features."""
        importances = fitted_pipeline._feature_importances
        assert importances is not None
        wbgt_indices = {
            FEATURE_NAMES.index("mean_wbgt"),
            FEATURE_NAMES.index("max_wbgt"),
        }
        top4 = set(np.argsort(importances)[-4:].tolist())
        assert len(wbgt_indices & top4) >= 1, (
            f"Neither mean_wbgt nor max_wbgt in top-4: importances={importances}"
        )

    # --- export ---

    def test_export_creates_model_pkl(self, exported_dir):
        assert (exported_dir / "thermal_stress_model.pkl").exists()

    def test_export_creates_config_json(self, exported_dir):
        assert (exported_dir / "thermal_stress_config.json").exists()

    def test_export_creates_thresholds_header(self, exported_dir):
        assert (exported_dir / "thermal_thresholds.h").exists()

    def test_config_json_valid(self, exported_dir):
        cfg = json.loads((exported_dir / "thermal_stress_config.json").read_text())
        assert cfg["n_features"] == N_FEATURES
        assert cfg["detector"]   == "thermal_stress"

    def test_config_json_has_scaler(self, exported_dir):
        cfg = json.loads((exported_dir / "thermal_stress_config.json").read_text())
        assert "scaler_mean" in cfg
        assert len(cfg["scaler_mean"]) == N_FEATURES

    def test_config_has_wbgt_thresholds(self, exported_dir):
        cfg = json.loads((exported_dir / "thermal_stress_config.json").read_text())
        assert cfg["wbgt_warn_c"]   == WBGT_WARN_C
        assert cfg["wbgt_danger_c"] == WBGT_DANGER_C
        assert cfg["cold_alert_c"]  == COLD_ALERT_C

    def test_config_feature_importances_length(self, exported_dir):
        cfg = json.loads((exported_dir / "thermal_stress_config.json").read_text())
        assert len(cfg["feature_importances"]) == N_FEATURES

    def test_header_include_guard(self, exported_dir):
        content = (exported_dir / "thermal_thresholds.h").read_text()
        assert "FOVET_THERMAL_THRESHOLDS_H" in content

    def test_header_wbgt_warn_define(self, exported_dir):
        content = (exported_dir / "thermal_thresholds.h").read_text()
        assert "FOVET_TEMP_WBGT_WARN_C" in content

    def test_header_wbgt_danger_define(self, exported_dir):
        content = (exported_dir / "thermal_thresholds.h").read_text()
        assert "FOVET_TEMP_WBGT_DANGER_C" in content

    def test_header_cold_alert_define(self, exported_dir):
        content = (exported_dir / "thermal_thresholds.h").read_text()
        assert "FOVET_TEMP_COLD_ALERT_C" in content

    def test_header_n_features_define(self, exported_dir):
        content = (exported_dir / "thermal_thresholds.h").read_text()
        assert f"FOVET_TEMP_N_FEATURES" in content

    def test_header_normal_celsius_mean_define(self, exported_dir):
        content = (exported_dir / "thermal_thresholds.h").read_text()
        assert "FOVET_TEMP_NORMAL_CELSIUS_MEAN" in content

    def test_model_pkl_loadable(self, exported_dir):
        import joblib
        model = joblib.load(exported_dir / "thermal_stress_model.pkl")
        assert hasattr(model, "predict_proba")

    def test_export_before_fit_raises(self, tmp_path):
        from forge.pipelines.thermal_stress import ThermalStressPipeline
        p = ThermalStressPipeline(window_s=240, step_s=120)
        with pytest.raises(RuntimeError, match="not fitted"):
            p.export(tmp_path / "out")
