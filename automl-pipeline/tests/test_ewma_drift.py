"""Tests for EWMADriftDetector — Forge F1."""

from __future__ import annotations

from pathlib import Path

import json
import numpy as np
import pytest

from forge.config import EWMADriftDetectorConfig, DetectorType, PipelineConfig
from forge.data.base import Dataset
from forge.detectors.base import DetectionResult
from forge.detectors.ewma_drift import EWMADriftDetector
from forge.detectors.registry import build_detectors


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _cfg(**kwargs) -> EWMADriftDetectorConfig:
    defaults = {"type": DetectorType.ewma_drift}
    defaults.update(kwargs)
    return EWMADriftDetectorConfig.model_validate(defaults)


def _normal_dataset(n: int = 1000, n_features: int = 1, seed: int = 0) -> Dataset:
    rng = np.random.default_rng(seed)
    samples = rng.normal(0.0, 1.0, size=(n, n_features)).astype(np.float32)
    columns = [f"f{i}" for i in range(n_features)]
    return Dataset(samples=samples, columns=columns)


def _drift_dataset() -> Dataset:
    """500 normal samples then a 500-sample step shift (+10 units)."""
    rng = np.random.default_rng(42)
    normal = rng.normal(0.0, 0.1, size=(500, 1))
    drifted = rng.normal(10.0, 0.1, size=(500, 1))
    samples = np.vstack([normal, drifted]).astype(np.float32)
    return Dataset(samples=samples, columns=["value"])


# ---------------------------------------------------------------------------
# Config validation
# ---------------------------------------------------------------------------

def test_config_default_values():
    cfg = _cfg()
    assert cfg.alpha_fast == 0.1
    assert cfg.alpha_slow == 0.01
    assert cfg.threshold is None
    assert cfg.threshold_percentile == 99.0


def test_config_alpha_slow_must_be_less_than_alpha_fast():
    with pytest.raises(Exception):  # Pydantic ValidationError
        _cfg(alpha_fast=0.01, alpha_slow=0.1)


def test_config_equal_alphas_invalid():
    with pytest.raises(Exception):
        _cfg(alpha_fast=0.1, alpha_slow=0.1)


def test_config_explicit_threshold_accepted():
    cfg = _cfg(threshold=5.0)
    assert cfg.threshold == 5.0


# ---------------------------------------------------------------------------
# fit
# ---------------------------------------------------------------------------

def test_fit_sets_post_fit_states():
    ds = _normal_dataset(n=500)
    d = EWMADriftDetector(_cfg())
    d.fit(ds)
    assert len(d._post_fit_states) == 1
    assert d._post_fit_states[0].count == 500


def test_fit_multi_feature_states():
    ds = _normal_dataset(n=500, n_features=3)
    d = EWMADriftDetector(_cfg())
    d.fit(ds)
    assert len(d._post_fit_states) == 3


def test_fit_calibrates_threshold():
    ds = _normal_dataset(n=1000)
    d = EWMADriftDetector(_cfg())
    d.fit(ds)
    assert d._threshold is not None
    assert d._threshold > 0


def test_fit_explicit_threshold_not_overridden():
    ds = _normal_dataset(n=1000)
    d = EWMADriftDetector(_cfg(threshold=42.0))
    d.fit(ds)
    assert d._threshold == 42.0


# ---------------------------------------------------------------------------
# score
# ---------------------------------------------------------------------------

def test_score_before_fit_raises():
    d = EWMADriftDetector(_cfg())
    ds = _normal_dataset()
    with pytest.raises(RuntimeError, match="fitted"):
        d.score(ds)


def test_score_shape_matches_n_samples():
    ds = _normal_dataset(n=300)
    d = EWMADriftDetector(_cfg())
    d.fit(ds)
    scores = d.score(ds)
    assert scores.shape == (300,)


def test_score_dtype_is_float32():
    ds = _normal_dataset(n=200)
    d = EWMADriftDetector(_cfg())
    d.fit(ds)
    scores = d.score(ds)
    assert scores.dtype == np.float32


def test_score_drift_region_higher_than_normal():
    """Scores in the drifted region must exceed scores in the normal region."""
    d = EWMADriftDetector(_cfg())
    ds = _drift_dataset()
    d.fit(Dataset(samples=ds.samples[:500], columns=ds.columns))  # fit on clean
    scores = d.score(Dataset(samples=ds.samples[500:], columns=ds.columns))
    normal_scores = d.score(Dataset(samples=ds.samples[:50], columns=ds.columns))
    # Drift region mean score >> normal region mean score
    assert float(scores.mean()) > float(normal_scores.mean()) * 5


def test_score_normal_signal_low():
    """On an un-drifted continuation, most scores should be near zero."""
    rng = np.random.default_rng(1)
    samples = rng.normal(0.0, 0.1, size=(500, 1)).astype(np.float32)
    ds = Dataset(samples=samples, columns=["v"])
    d = EWMADriftDetector(_cfg())
    d.fit(ds)
    # Score on another clean chunk
    test_samples = rng.normal(0.0, 0.1, size=(200, 1)).astype(np.float32)
    test_ds = Dataset(samples=test_samples, columns=["v"])
    scores = d.score(test_ds)
    assert float(scores.max()) < 1.0  # no meaningful drift


# ---------------------------------------------------------------------------
# predict
# ---------------------------------------------------------------------------

def test_predict_returns_detection_result():
    ds = _normal_dataset(n=200)
    d = EWMADriftDetector(_cfg())
    d.fit(ds)
    result = d.predict(ds)
    assert isinstance(result, DetectionResult)
    assert result.detector_name == "ewma_drift"
    assert result.threshold > 0


def test_predict_flags_drift():
    """Drift region should have higher label rate than normal region."""
    ds = _drift_dataset()
    d = EWMADriftDetector(_cfg(threshold_percentile=95.0))
    d.fit(Dataset(samples=ds.samples[:500], columns=ds.columns))
    result = d.predict(Dataset(samples=ds.samples[400:], columns=ds.columns))
    # Last 100 samples are drifted → should trigger labels
    drift_labels = result.labels[100:]  # samples 500-999 of original
    assert drift_labels.sum() > 0


def test_predict_low_false_positive_on_clean():
    """False positive rate on a clean signal should be ≤ (100 - percentile)%."""
    ds = _normal_dataset(n=2000, seed=7)
    d = EWMADriftDetector(_cfg(threshold_percentile=99.0))
    d.fit(ds)
    result = d.predict(ds)
    fpr = result.n_anomalies / ds.n_samples
    assert fpr <= 0.05  # at most 5% on training data itself


# ---------------------------------------------------------------------------
# export
# ---------------------------------------------------------------------------

def test_export_creates_both_files(tmp_path: Path):
    ds = _normal_dataset(n=300)
    d = EWMADriftDetector(_cfg())
    d.fit(ds)
    paths = d.export(tmp_path, stem="test-pipeline")
    names = {p.name for p in paths}
    assert "fovet_drift_config.h" in names
    assert "drift_config.json" in names
    for p in paths:
        assert p.exists()


def test_export_before_fit_raises(tmp_path: Path):
    d = EWMADriftDetector(_cfg())
    with pytest.raises(RuntimeError, match="fitted"):
        d.export(tmp_path, stem="test")


def test_export_header_contains_sdk_struct(tmp_path: Path):
    ds = _normal_dataset(n=300)
    d = EWMADriftDetector(_cfg())
    d.fit(ds)
    d.export(tmp_path, stem="test")
    content = (tmp_path / "fovet_drift_config.h").read_text()
    assert "FovetDrift" in content
    assert "fovet/drift.h" in content
    assert "FOVET_DRIFT_CONFIG_H" in content
    assert "alpha_fast" in content
    assert "alpha_slow" in content


def test_export_header_multi_feature_one_struct_per_feature(tmp_path: Path):
    ds = _normal_dataset(n=300, n_features=3)
    d = EWMADriftDetector(_cfg())
    d.fit(ds)
    d.export(tmp_path, stem="test")
    content = (tmp_path / "fovet_drift_config.h").read_text()
    assert content.count("static FovetDrift") == 3


def test_export_json_contains_params(tmp_path: Path):
    ds = _normal_dataset(n=200)
    d = EWMADriftDetector(_cfg(alpha_fast=0.2, alpha_slow=0.02))
    d.fit(ds)
    d.export(tmp_path, stem="test")
    data = json.loads((tmp_path / "drift_config.json").read_text())
    assert data["detector"] == "ewma_drift"
    assert data["alpha_fast"] == pytest.approx(0.2)
    assert data["alpha_slow"] == pytest.approx(0.02)
    assert data["n_training_samples"] == 200
    assert len(data["post_fit_states"]) == 1


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------

def test_registry_builds_ewma_drift():
    cfg = PipelineConfig.model_validate({
        "name": "test",
        "data": {"source": "synthetic", "columns": ["v"]},
        "detectors": [{"type": "ewma_drift"}],
    })
    detectors = build_detectors(cfg.detectors)
    assert len(detectors) == 1
    assert isinstance(detectors[0], EWMADriftDetector)


def test_registry_ewma_drift_custom_params():
    cfg = PipelineConfig.model_validate({
        "name": "test",
        "data": {"source": "synthetic", "columns": ["v"]},
        "detectors": [{"type": "ewma_drift", "alpha_fast": 0.3, "alpha_slow": 0.03}],
    })
    detectors = build_detectors(cfg.detectors)
    assert detectors[0].config.alpha_fast == pytest.approx(0.3)
    assert detectors[0].config.alpha_slow == pytest.approx(0.03)
