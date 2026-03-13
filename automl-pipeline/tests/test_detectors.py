"""Tests for anomaly detectors -- Forge-3a: ZScoreDetector."""

from pathlib import Path

import numpy as np
import pytest

from forge.config import ZScoreDetectorConfig, DetectorType, DataSource
from forge.data.base import Dataset
from forge.data.synthetic import generate
from forge.config import SyntheticDataConfig
from forge.detectors.base import DetectionResult
from forge.detectors.zscore import ZScoreDetector
from forge.detectors.registry import build_detectors


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _zscore_cfg(**kwargs) -> ZScoreDetectorConfig:
    defaults = {"type": DetectorType.zscore, "threshold_sigma": 3.0}
    defaults.update(kwargs)
    return ZScoreDetectorConfig.model_validate(defaults)


def _normal_dataset(n: int = 500, n_features: int = 1, seed: int = 0) -> Dataset:
    """Pure normal signal, no injected anomalies."""
    rng = np.random.default_rng(seed)
    samples = rng.normal(0.0, 1.0, size=(n, n_features)).astype(np.float32)
    columns = [f"f{i}" for i in range(n_features)]
    return Dataset(samples=samples, columns=columns)


def _spike_dataset() -> Dataset:
    """100 normal samples + 1 obvious spike."""
    samples = np.zeros((101, 1), dtype=np.float32)
    samples[50, 0] = 100.0  # clear spike
    return Dataset(samples=samples, columns=["value"])


# ---------------------------------------------------------------------------
# fit / score
# ---------------------------------------------------------------------------

def test_fit_sets_statistics():
    ds = _normal_dataset(n=1000)
    d = ZScoreDetector(_zscore_cfg())
    d.fit(ds)
    assert d.mean.shape == (1,)
    assert d.stddev.shape == (1,)
    assert abs(float(d.mean[0])) < 0.15        # near 0
    assert abs(float(d.stddev[0]) - 1.0) < 0.1  # near 1


def test_fit_multi_feature():
    ds = _normal_dataset(n=500, n_features=3)
    d = ZScoreDetector(_zscore_cfg())
    d.fit(ds)
    assert d.mean.shape == (3,)
    assert d.stddev.shape == (3,)


def test_score_normal_samples_are_low():
    ds = _normal_dataset(n=1000, seed=1)
    d = ZScoreDetector(_zscore_cfg())
    d.fit(ds)
    scores = d.score(ds)
    # Vast majority of normal samples should score below threshold
    assert float((scores < 3.0).mean()) > 0.99


def test_score_spike_is_high():
    ds = _spike_dataset()
    d = ZScoreDetector(_zscore_cfg())
    d.fit(ds)
    scores = d.score(ds)
    assert scores[50] > scores[:50].max()


def test_score_before_fit_raises():
    d = ZScoreDetector(_zscore_cfg())
    ds = _normal_dataset()
    with pytest.raises(RuntimeError, match="fitted"):
        d.score(ds)


def test_score_shape_matches_n_samples():
    ds = _normal_dataset(n=200)
    d = ZScoreDetector(_zscore_cfg())
    d.fit(ds)
    scores = d.score(ds)
    assert scores.shape == (200,)


def test_score_dtype_is_float32():
    ds = _normal_dataset()
    d = ZScoreDetector(_zscore_cfg())
    d.fit(ds)
    scores = d.score(ds)
    assert scores.dtype == np.float32


# ---------------------------------------------------------------------------
# predict
# ---------------------------------------------------------------------------

def test_predict_returns_detection_result():
    ds = _normal_dataset()
    d = ZScoreDetector(_zscore_cfg())
    d.fit(ds)
    result = d.predict(ds)
    assert isinstance(result, DetectionResult)
    assert result.detector_name == "zscore"
    assert result.threshold == 3.0


def test_predict_detects_spike():
    ds = _spike_dataset()
    d = ZScoreDetector(_zscore_cfg())
    d.fit(ds)
    result = d.predict(ds)
    assert result.labels[50] == 1        # spike detected
    assert result.labels[0] == 0         # normal not flagged


def test_predict_low_false_positive_rate():
    ds = _normal_dataset(n=2000, seed=42)
    d = ZScoreDetector(_zscore_cfg(threshold_sigma=3.0))
    d.fit(ds)
    result = d.predict(ds)
    fpr = result.n_anomalies / ds.n_samples
    assert fpr < 0.01  # <1% false positives for 3-sigma threshold


def test_predict_higher_sigma_fewer_alerts():
    ds = _normal_dataset(n=1000)
    d3 = ZScoreDetector(_zscore_cfg(threshold_sigma=3.0))
    d5 = ZScoreDetector(_zscore_cfg(threshold_sigma=5.0))
    d3.fit(ds)
    d5.fit(ds)
    assert d3.predict(ds).n_anomalies >= d5.predict(ds).n_anomalies


# ---------------------------------------------------------------------------
# Welford correctness -- matches numpy reference
# ---------------------------------------------------------------------------

def test_welford_mean_matches_numpy():
    rng = np.random.default_rng(99)
    data = rng.normal(5.0, 2.0, size=(1000, 2)).astype(np.float32)
    ds = Dataset(samples=data, columns=["a", "b"])
    d = ZScoreDetector(_zscore_cfg())
    d.fit(ds)
    np.testing.assert_allclose(d.mean, data.mean(axis=0), atol=1e-4)


def test_welford_std_matches_numpy():
    rng = np.random.default_rng(77)
    data = rng.normal(0.0, 3.0, size=(1000, 1)).astype(np.float32)
    ds = Dataset(samples=data, columns=["v"])
    d = ZScoreDetector(_zscore_cfg())
    d.fit(ds)
    np.testing.assert_allclose(d.stddev, data.std(ddof=1, axis=0), atol=1e-3)


# ---------------------------------------------------------------------------
# Export -- fovet_zscore_config.h
# ---------------------------------------------------------------------------

def test_export_creates_header_file(tmp_path: Path):
    ds = _normal_dataset(n=500)
    d = ZScoreDetector(_zscore_cfg())
    d.fit(ds)
    written = d.export(tmp_path, stem="test-pipeline")
    assert len(written) == 1
    assert written[0].name == "fovet_zscore_config.h"
    assert written[0].exists()


def test_export_header_contains_sdk_struct(tmp_path: Path):
    ds = _normal_dataset(n=500)
    d = ZScoreDetector(_zscore_cfg())
    d.fit(ds)
    d.export(tmp_path, stem="test")
    content = (tmp_path / "fovet_zscore_config.h").read_text()
    assert "FovetZScore" in content
    assert "fovet/zscore.h" in content
    assert "threshold_sigma" in content
    assert "FOVET_ZSCORE_CONFIG_H" in content


def test_export_header_contains_calibrated_values(tmp_path: Path):
    rng = np.random.default_rng(0)
    data = rng.normal(2.5, 0.5, size=(1000, 1)).astype(np.float32)
    ds = Dataset(samples=data, columns=["sensor"])
    d = ZScoreDetector(_zscore_cfg(threshold_sigma=3.5))
    d.fit(ds)
    d.export(tmp_path, stem="test")
    content = (tmp_path / "fovet_zscore_config.h").read_text()
    # Mean should be near 2.5
    assert "2.5" in content or "2.4" in content
    assert "3.500000f" in content  # threshold


def test_export_multi_feature_has_one_struct_per_feature(tmp_path: Path):
    ds = _normal_dataset(n=500, n_features=3)
    d = ZScoreDetector(_zscore_cfg())
    d.fit(ds)
    d.export(tmp_path, stem="test")
    content = (tmp_path / "fovet_zscore_config.h").read_text()
    # Three FovetZScore contexts
    assert content.count("static FovetZScore") == 3


def test_export_before_fit_raises(tmp_path: Path):
    d = ZScoreDetector(_zscore_cfg())
    with pytest.raises(RuntimeError, match="fitted"):
        d.export(tmp_path, stem="test")


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------

def test_registry_builds_zscore():
    from forge.config import PipelineConfig
    cfg = PipelineConfig.model_validate({
        "name": "test",
        "data": {"source": "synthetic", "columns": ["v"]},
        "detectors": [{"type": "zscore", "threshold_sigma": 4.0}],
    })
    detectors = build_detectors(cfg.detectors)
    assert len(detectors) == 1
    assert isinstance(detectors[0], ZScoreDetector)
    assert detectors[0].config.threshold_sigma == 4.0


def test_registry_builds_isolation_forest():
    from forge.config import PipelineConfig
    from forge.detectors.isolation_forest import IsolationForestDetector
    cfg = PipelineConfig.model_validate({
        "name": "test",
        "data": {"source": "synthetic", "columns": ["v"]},
        "detectors": [{"type": "isolation_forest", "contamination": 0.05}],
    })
    detectors = build_detectors(cfg.detectors)
    assert len(detectors) == 1
    assert isinstance(detectors[0], IsolationForestDetector)


# ---------------------------------------------------------------------------
# End-to-end on synthetic dataset
# ---------------------------------------------------------------------------

def test_e2e_synthetic_recall_above_threshold():
    """Z-Score trained on clean data should detect most +5-sigma anomalies."""
    base_cfg = {
        "source": "synthetic",
        "columns": ["value"],
        "noise_std": 0.1,
        "anomaly_magnitude": 5.0,
    }
    # Train on clean signal (no anomalies)
    train_ds = generate(SyntheticDataConfig.model_validate(
        {**base_cfg, "n_samples": 2000, "anomaly_rate": 0.0, "seed": 0}
    ))
    # Test on signal with injected anomalies
    test_ds = generate(SyntheticDataConfig.model_validate(
        {**base_cfg, "n_samples": 1000, "anomaly_rate": 0.05, "seed": 1}
    ))
    d = ZScoreDetector(_zscore_cfg(threshold_sigma=3.0))
    d.fit(train_ds)
    result = d.predict(test_ds)

    gt = test_ds.labels
    pred = result.labels
    tp = int(((pred == 1) & (gt == 1)).sum())
    recall = tp / int(gt.sum())
    assert recall > 0.8  # trained on clean data → should catch >80% of +5-sigma spikes
