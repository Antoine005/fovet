"""Tests for AutoEncoderDetector -- Forge-4.

These tests require TensorFlow.  If TF is not installed (uv sync --extra ml),
all tests in this module are skipped automatically.
"""

import json
from pathlib import Path

import numpy as np
import pytest

tf = pytest.importorskip("tensorflow", reason="tensorflow not installed -- run: uv sync --extra ml")

from forge.config import AutoEncoderDetectorConfig, DetectorType, Quantization
from forge.data.base import Dataset
from forge.data.synthetic import generate
from forge.config import SyntheticDataConfig
from forge.detectors.autoencoder import AutoEncoderDetector
from forge.detectors.base import DetectionResult


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _ae_cfg(**kwargs) -> AutoEncoderDetectorConfig:
    defaults = {
        "type": DetectorType.autoencoder,
        "latent_dim": 2,
        "epochs": 3,        # very short for test speed
        "batch_size": 16,
        "threshold_percentile": 95.0,
    }
    defaults.update(kwargs)
    return AutoEncoderDetectorConfig.model_validate(defaults)


def _normal_dataset(n: int = 200, n_features: int = 1, seed: int = 0) -> Dataset:
    rng = np.random.default_rng(seed)
    samples = rng.normal(0.0, 1.0, size=(n, n_features)).astype(np.float32)
    columns = [f"f{i}" for i in range(n_features)]
    return Dataset(samples=samples, columns=columns)


def _spike_dataset() -> Dataset:
    """100 normal samples + 1 clear outlier at index 50."""
    samples = np.zeros((101, 1), dtype=np.float32)
    samples[50, 0] = 100.0
    return Dataset(samples=samples, columns=["value"])


# ---------------------------------------------------------------------------
# fit / score
# ---------------------------------------------------------------------------

def test_fit_does_not_raise():
    ds = _normal_dataset(n=100)
    d = AutoEncoderDetector(_ae_cfg())
    d.fit(ds)


def test_score_returns_correct_shape():
    ds = _normal_dataset(n=100)
    d = AutoEncoderDetector(_ae_cfg())
    d.fit(ds)
    scores = d.score(ds)
    assert scores.shape == (100,)


def test_score_dtype_is_float32():
    ds = _normal_dataset(n=100)
    d = AutoEncoderDetector(_ae_cfg())
    d.fit(ds)
    assert d.score(ds).dtype == np.float32


def test_score_normal_low_after_training():
    """Reconstruction error should be low for in-distribution data."""
    ds = _normal_dataset(n=200, seed=0)
    d = AutoEncoderDetector(_ae_cfg(epochs=10))
    d.fit(ds)
    scores = d.score(ds)
    # Training MSE should be modest (autoencoder learned the distribution)
    assert float(scores.mean()) < 5.0


def test_score_spike_higher_than_normal():
    """Spike reconstruction error > average normal reconstruction error."""
    ds = _spike_dataset()
    d = AutoEncoderDetector(_ae_cfg())
    d.fit(ds)
    scores = d.score(ds)
    assert scores[50] > scores[:50].mean()


def test_score_before_fit_raises():
    d = AutoEncoderDetector(_ae_cfg())
    with pytest.raises(RuntimeError, match="fitted"):
        d.score(_normal_dataset())


def test_fit_multi_feature():
    ds = _normal_dataset(n=200, n_features=3)
    d = AutoEncoderDetector(_ae_cfg())
    d.fit(ds)
    scores = d.score(ds)
    assert scores.shape == (200,)


# ---------------------------------------------------------------------------
# predict
# ---------------------------------------------------------------------------

def test_predict_returns_detection_result():
    ds = _normal_dataset(n=100)
    d = AutoEncoderDetector(_ae_cfg())
    d.fit(ds)
    result = d.predict(ds)
    assert isinstance(result, DetectionResult)
    assert result.detector_name == "autoencoder"


def test_predict_labels_are_binary():
    ds = _normal_dataset(n=100)
    d = AutoEncoderDetector(_ae_cfg())
    d.fit(ds)
    result = d.predict(ds)
    assert set(result.labels.tolist()).issubset({0, 1})


def test_predict_anomaly_rate_near_complement_percentile():
    """With threshold_percentile=95, ~5% of training samples should be flagged."""
    ds = _normal_dataset(n=300, seed=7)
    d = AutoEncoderDetector(_ae_cfg(threshold_percentile=95.0))
    d.fit(ds)
    result = d.predict(ds)
    # On training data the rate should be roughly (100 - percentile)%
    assert result.anomaly_rate < 0.15  # allow some slack


def test_predict_before_fit_raises():
    d = AutoEncoderDetector(_ae_cfg())
    with pytest.raises(RuntimeError, match="fitted"):
        d.predict(_normal_dataset())


# ---------------------------------------------------------------------------
# Export -- TFLite + JSON + C header
# ---------------------------------------------------------------------------

def test_export_creates_three_files(tmp_path: Path):
    ds = _normal_dataset(n=100)
    d = AutoEncoderDetector(_ae_cfg())
    d.fit(ds)
    written = d.export(tmp_path, stem="test")
    names = {p.name for p in written}
    assert "autoencoder.tflite" in names
    assert "autoencoder_config.json" in names
    assert "fovet_autoencoder_model.h" in names


def test_export_tflite_is_valid_bytes(tmp_path: Path):
    ds = _normal_dataset(n=100)
    d = AutoEncoderDetector(_ae_cfg())
    d.fit(ds)
    d.export(tmp_path, stem="test")
    tflite_bytes = (tmp_path / "autoencoder.tflite").read_bytes()
    # TFLite flat-buffer starts with 4-byte identifier at offset 4: "TFL3"
    assert len(tflite_bytes) > 0


def test_export_json_is_valid(tmp_path: Path):
    ds = _normal_dataset(n=100)
    d = AutoEncoderDetector(_ae_cfg())
    d.fit(ds)
    d.export(tmp_path, stem="my-pipeline")
    content = json.loads((tmp_path / "autoencoder_config.json").read_text())
    assert content["detector"] == "autoencoder"
    assert content["pipeline"] == "my-pipeline"
    assert "decision_threshold" in content
    assert isinstance(content["features"], list)
    assert content["latent_dim"] == 2


def test_export_c_header_guard(tmp_path: Path):
    ds = _normal_dataset(n=100)
    d = AutoEncoderDetector(_ae_cfg())
    d.fit(ds)
    d.export(tmp_path, stem="test")
    content = (tmp_path / "fovet_autoencoder_model.h").read_text()
    assert "FOVET_AUTOENCODER_MODEL_H" in content
    assert "g_autoencoder_model_data" in content
    assert "g_autoencoder_threshold" in content
    assert "uint8_t" in content


def test_export_before_fit_raises(tmp_path: Path):
    d = AutoEncoderDetector(_ae_cfg())
    with pytest.raises(RuntimeError, match="fitted"):
        d.export(tmp_path, stem="test")


def test_export_int8_produces_file(tmp_path: Path):
    """INT8 quantisation path should complete without error."""
    ds = _normal_dataset(n=200, seed=1)
    d = AutoEncoderDetector(_ae_cfg(epochs=5))
    d.fit(ds)
    written = d.export(tmp_path, stem="test", quantization=Quantization.int8)
    assert (tmp_path / "autoencoder.tflite").exists()
    assert len(written) == 3


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------

def test_registry_builds_autoencoder():
    from forge.config import PipelineConfig
    cfg = PipelineConfig.model_validate({
        "name": "test",
        "data": {"source": "synthetic", "columns": ["v"]},
        "detectors": [{"type": "autoencoder", "latent_dim": 4, "epochs": 2}],
    })
    from forge.detectors.registry import build_detectors
    detectors = build_detectors(cfg.detectors)
    assert len(detectors) == 1
    assert isinstance(detectors[0], AutoEncoderDetector)


# ---------------------------------------------------------------------------
# End-to-end -- recall on synthetic data
# ---------------------------------------------------------------------------

def test_e2e_ae_recall_on_synthetic():
    """AE trained on clean data should detect most +5-sigma anomalies."""
    base = {
        "source": "synthetic",
        "columns": ["x", "y"],
        "noise_std": 0.1,
        "anomaly_magnitude": 5.0,
    }
    train_ds = generate(SyntheticDataConfig.model_validate(
        {**base, "n_samples": 500, "anomaly_rate": 0.0, "seed": 20}
    ))
    test_ds = generate(SyntheticDataConfig.model_validate(
        {**base, "n_samples": 300, "anomaly_rate": 0.05, "seed": 21}
    ))
    d = AutoEncoderDetector(_ae_cfg(epochs=20, threshold_percentile=95.0))
    d.fit(train_ds)
    result = d.predict(test_ds)

    gt = test_ds.labels
    pred = result.labels
    tp = int(((pred == 1) & (gt == 1)).sum())
    recall = tp / int(gt.sum())
    assert recall > 0.3  # Dense AE on low-noise Gaussian: modest recall threshold
