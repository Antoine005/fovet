"""
Unit tests for forge.preprocessing — StandardScaler wrapper.
"""

from __future__ import annotations

import json

import numpy as np
import pytest

from forge.data.base import Dataset
from forge.preprocessing import Scaler


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_dataset(n: int = 200, n_features: int = 2, seed: int = 0) -> Dataset:
    rng = np.random.default_rng(seed)
    # Feature 0: mean=10, std=2  /  Feature 1: mean=0.01, std=0.001 (very different scales)
    samples = np.column_stack([
        rng.normal(10.0, 2.0, size=n),
        rng.normal(0.01, 0.001, size=n),
    ]).astype(np.float32)
    return Dataset(samples=samples, columns=["temperature", "vibration"])


def _make_univariate(n: int = 100, mean: float = 5.0, std: float = 2.0) -> Dataset:
    rng = np.random.default_rng(42)
    samples = rng.normal(mean, std, size=(n, 1)).astype(np.float32)
    return Dataset(samples=samples, columns=["value"])


# ---------------------------------------------------------------------------
# Scaler unit tests
# ---------------------------------------------------------------------------

def test_scaler_fit_sets_mean_and_scale():
    ds = _make_dataset()
    s = Scaler()
    s.fit(ds)

    assert s.mean_ is not None
    assert s.scale_ is not None
    assert s.mean_.shape == (2,)
    assert s.scale_.shape == (2,)


def test_scaler_fit_mean_close_to_true():
    ds = _make_univariate(n=5000, mean=5.0, std=2.0)
    s = Scaler()
    s.fit(ds)
    assert abs(float(s.mean_[0]) - 5.0) < 0.1


def test_scaler_fit_scale_close_to_true():
    ds = _make_univariate(n=5000, mean=5.0, std=2.0)
    s = Scaler()
    s.fit(ds)
    assert abs(float(s.scale_[0]) - 2.0) < 0.1


def test_scaler_transform_zero_mean():
    ds = _make_univariate(n=1000, mean=5.0, std=2.0)
    s = Scaler()
    norm = s.fit_transform(ds)

    mean_after = float(norm.samples.mean())
    assert abs(mean_after) < 0.05  # near zero


def test_scaler_transform_unit_variance():
    ds = _make_univariate(n=1000, mean=5.0, std=2.0)
    s = Scaler()
    norm = s.fit_transform(ds)

    std_after = float(norm.samples.std())
    assert abs(std_after - 1.0) < 0.05  # near 1.0


def test_scaler_transform_multifeature():
    ds = _make_dataset(n=500)
    s = Scaler()
    norm = s.fit_transform(ds)

    for i in range(2):
        mean_i = float(norm.samples[:, i].mean())
        std_i  = float(norm.samples[:, i].std())
        assert abs(mean_i) < 0.1, f"feature {i}: mean after normalize != ~0"
        assert abs(std_i - 1.0) < 0.1, f"feature {i}: std after normalize != ~1"


def test_scaler_transform_preserves_columns_and_labels():
    ds = _make_dataset()
    labels = np.zeros(ds.n_samples, dtype=np.int8)
    ds_labeled = Dataset(samples=ds.samples, columns=ds.columns, labels=labels)

    s = Scaler()
    norm = s.fit_transform(ds_labeled)

    assert norm.columns == ds.columns
    assert norm.labels is not None
    assert len(norm.labels) == ds.n_samples


def test_scaler_transform_preserves_shape():
    ds = _make_dataset(n=300, n_features=2)
    s = Scaler()
    norm = s.fit_transform(ds)
    assert norm.samples.shape == ds.samples.shape


def test_scaler_transform_before_fit_raises():
    ds = _make_dataset()
    s = Scaler()
    with pytest.raises(RuntimeError, match="fitted"):
        s.transform(ds)


def test_scaler_export_creates_json(tmp_path):
    ds = _make_dataset(n=200)
    s = Scaler()
    s.fit(ds)
    out = s.export(tmp_path, stem="test_pipeline")

    assert out.exists()
    assert out.name == "scaler_params.json"


def test_scaler_export_content(tmp_path):
    ds = _make_dataset(n=200)
    s = Scaler()
    s.fit(ds)
    out = s.export(tmp_path, stem="test_pipeline")

    data = json.loads(out.read_text())
    assert data["normalization"] == "StandardScaler"
    assert data["features"] == ["temperature", "vibration"]
    assert len(data["mean"]) == 2
    assert len(data["scale"]) == 2
    assert "formula" in data
    assert "note" in data


def test_scaler_export_values_match_fit(tmp_path):
    ds = _make_univariate(n=1000, mean=5.0, std=2.0)
    s = Scaler()
    s.fit(ds)
    out = s.export(tmp_path, stem="test")

    data = json.loads(out.read_text())
    assert abs(data["mean"][0] - 5.0) < 0.1
    assert abs(data["scale"][0] - 2.0) < 0.1


def test_scaler_export_before_fit_raises(tmp_path):
    s = Scaler()
    with pytest.raises(RuntimeError, match="fitted"):
        s.export(tmp_path, stem="test")


def test_scaler_constant_feature_scale_not_zero():
    """Constant feature should not produce scale=0 (would cause div/0)."""
    samples = np.ones((100, 1), dtype=np.float32) * 42.0
    ds = Dataset(samples=samples, columns=["const"])
    s = Scaler()
    s.fit(ds)
    assert float(s.scale_[0]) > 0


def test_scaler_fit_transform_consistent_with_separate_calls():
    ds = _make_dataset(n=300)
    s1 = Scaler()
    combined = s1.fit_transform(ds)

    s2 = Scaler()
    s2.fit(ds)
    separate = s2.transform(ds)

    np.testing.assert_allclose(combined.samples, separate.samples, rtol=1e-5)


# ---------------------------------------------------------------------------
# Pipeline integration: normalize=True propagates through run()
# ---------------------------------------------------------------------------

def test_pipeline_normalize_flag_accepted():
    """PipelineConfig accepts preprocessing.normalize=True."""
    from forge.config import PipelineConfig
    cfg = PipelineConfig.model_validate({
        "name": "test",
        "data": {"source": "synthetic", "columns": ["v"]},
        "detectors": [{"type": "zscore"}],
        "preprocessing": {"normalize": True},
    })
    assert cfg.preprocessing.normalize is True


def test_pipeline_normalize_default_is_false():
    from forge.config import PipelineConfig
    cfg = PipelineConfig.model_validate({
        "name": "test",
        "data": {"source": "synthetic", "columns": ["v"]},
        "detectors": [{"type": "zscore"}],
    })
    assert cfg.preprocessing.normalize is False
