"""Tests for IsolationForestDetector -- Forge-3b."""

import json
from pathlib import Path

import numpy as np
import pytest

from forge.config import IsolationForestDetectorConfig, DetectorType
from forge.data.base import Dataset
from forge.data.synthetic import generate
from forge.config import SyntheticDataConfig
from forge.detectors.base import DetectionResult
from forge.detectors.isolation_forest import IsolationForestDetector


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _if_cfg(**kwargs) -> IsolationForestDetectorConfig:
    defaults = {
        "type": DetectorType.isolation_forest,
        "contamination": 0.05,
        "n_estimators": 50,  # fewer trees for faster tests
        "random_state": 42,
    }
    defaults.update(kwargs)
    return IsolationForestDetectorConfig.model_validate(defaults)


def _normal_dataset(n: int = 500, n_features: int = 1, seed: int = 0) -> Dataset:
    rng = np.random.default_rng(seed)
    samples = rng.normal(0.0, 1.0, size=(n, n_features)).astype(np.float32)
    columns = [f"f{i}" for i in range(n_features)]
    return Dataset(samples=samples, columns=columns)


def _spike_dataset() -> Dataset:
    """100 normal samples + 1 clear outlier."""
    samples = np.zeros((101, 1), dtype=np.float32)
    samples[50, 0] = 100.0
    return Dataset(samples=samples, columns=["value"])


# ---------------------------------------------------------------------------
# fit / score
# ---------------------------------------------------------------------------

def test_fit_does_not_raise():
    ds = _normal_dataset(n=300)
    d = IsolationForestDetector(_if_cfg())
    d.fit(ds)  # should not raise


def test_score_returns_correct_shape():
    ds = _normal_dataset(n=200)
    d = IsolationForestDetector(_if_cfg())
    d.fit(ds)
    scores = d.score(ds)
    assert scores.shape == (200,)


def test_score_dtype_is_float32():
    ds = _normal_dataset(n=200)
    d = IsolationForestDetector(_if_cfg())
    d.fit(ds)
    assert d.score(ds).dtype == np.float32


def test_score_spike_higher_than_normal():
    ds = _spike_dataset()
    d = IsolationForestDetector(_if_cfg())
    d.fit(ds)
    scores = d.score(ds)
    assert scores[50] > scores[:50].mean()


def test_score_before_fit_raises():
    d = IsolationForestDetector(_if_cfg())
    with pytest.raises(RuntimeError, match="fitted"):
        d.score(_normal_dataset())


def test_fit_multi_feature():
    ds = _normal_dataset(n=300, n_features=3)
    d = IsolationForestDetector(_if_cfg())
    d.fit(ds)
    scores = d.score(ds)
    assert scores.shape == (300,)


# ---------------------------------------------------------------------------
# predict
# ---------------------------------------------------------------------------

def test_predict_returns_detection_result():
    ds = _normal_dataset(n=300)
    d = IsolationForestDetector(_if_cfg())
    d.fit(ds)
    result = d.predict(ds)
    assert isinstance(result, DetectionResult)
    assert result.detector_name == "isolation_forest"


def test_predict_labels_are_binary():
    ds = _normal_dataset(n=300)
    d = IsolationForestDetector(_if_cfg())
    d.fit(ds)
    result = d.predict(ds)
    assert set(result.labels.tolist()).issubset({0, 1})


def test_predict_anomaly_rate_near_contamination():
    """Predicted rate should be close to configured contamination."""
    ds = _normal_dataset(n=1000, seed=5)
    contamination = 0.05
    d = IsolationForestDetector(_if_cfg(contamination=contamination, n_estimators=100))
    d.fit(ds)
    result = d.predict(ds)
    assert abs(result.anomaly_rate - contamination) < 0.02


def test_predict_detects_obvious_spike():
    ds = _spike_dataset()
    d = IsolationForestDetector(_if_cfg(contamination=0.05))
    d.fit(ds)
    result = d.predict(ds)
    assert result.labels[50] == 1


def test_predict_before_fit_raises():
    d = IsolationForestDetector(_if_cfg())
    with pytest.raises(RuntimeError, match="fitted"):
        d.predict(_normal_dataset())


# ---------------------------------------------------------------------------
# Export -- JSON config
# ---------------------------------------------------------------------------

def test_export_creates_json_file(tmp_path: Path):
    ds = _normal_dataset(n=300)
    d = IsolationForestDetector(_if_cfg())
    d.fit(ds)
    written = d.export(tmp_path, stem="test-pipeline")
    assert len(written) == 1
    assert written[0].name == "isolation_forest_config.json"
    assert written[0].exists()


def test_export_json_is_valid(tmp_path: Path):
    ds = _normal_dataset(n=300)
    d = IsolationForestDetector(_if_cfg())
    d.fit(ds)
    d.export(tmp_path, stem="test")
    content = json.loads((tmp_path / "isolation_forest_config.json").read_text())
    assert content["detector"] == "isolation_forest"
    assert content["n_estimators"] == 50
    assert content["contamination"] == 0.05
    assert "decision_threshold" in content
    assert isinstance(content["features"], list)


def test_export_before_fit_raises(tmp_path: Path):
    d = IsolationForestDetector(_if_cfg())
    with pytest.raises(RuntimeError, match="fitted"):
        d.export(tmp_path, stem="test")


# ---------------------------------------------------------------------------
# End-to-end -- recall on synthetic data
# ---------------------------------------------------------------------------

def test_e2e_if_recall_on_synthetic():
    """IF trained on clean data should detect most +5-sigma anomalies."""
    base = {
        "source": "synthetic",
        "columns": ["x", "y"],   # multivariate — IF strength
        "noise_std": 0.1,
        "anomaly_magnitude": 5.0,
    }
    train_ds = generate(SyntheticDataConfig.model_validate(
        {**base, "n_samples": 1000, "anomaly_rate": 0.0, "seed": 10}
    ))
    test_ds = generate(SyntheticDataConfig.model_validate(
        {**base, "n_samples": 500, "anomaly_rate": 0.05, "seed": 11}
    ))
    d = IsolationForestDetector(_if_cfg(contamination=0.05, n_estimators=100))
    d.fit(train_ds)
    result = d.predict(test_ds)

    gt = test_ds.labels
    pred = result.labels
    tp = int(((pred == 1) & (gt == 1)).sum())
    recall = tp / int(gt.sum())
    assert recall > 0.5  # IF is less precise than Z-Score on Gaussian data but should still work


# ---------------------------------------------------------------------------
# Comparison: Z-Score vs Isolation Forest
# ---------------------------------------------------------------------------

def test_if_handles_multivariate_where_zscore_might_miss():
    """Contextual anomaly: normal in each axis individually but outlier jointly."""
    rng = np.random.default_rng(0)
    # Normal data: x and y correlated (along y=x diagonal)
    n = 500
    t = rng.normal(0, 1, size=n)
    noise = rng.normal(0, 0.05, size=(n, 2))
    normal = np.column_stack([t, t]).astype(np.float32) + noise

    # Anomaly: far from the diagonal (normal in each axis, outlier jointly)
    anomaly = np.array([[3.0, -3.0]], dtype=np.float32)  # normal per-axis, joint outlier

    train_ds = Dataset(samples=normal, columns=["x", "y"])
    test_ds = Dataset(
        samples=np.vstack([normal, anomaly]),
        columns=["x", "y"],
    )

    d = IsolationForestDetector(_if_cfg(contamination=0.05, n_estimators=200))
    d.fit(train_ds)
    scores = d.score(test_ds)

    # The joint outlier should score higher than average normal samples
    assert scores[-1] > float(scores[:-1].mean())
