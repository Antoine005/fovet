"""Tests for LSTMAutoEncoderDetector -- Forge-4.

These tests require TensorFlow.  If TF is not installed (uv sync --extra ml),
all tests in this module are skipped automatically.
"""

import json
from pathlib import Path

import numpy as np
import pytest

tf = pytest.importorskip("tensorflow", reason="tensorflow not installed -- run: uv sync --extra ml")

from forge.config import DetectorType, LSTMAutoEncoderDetectorConfig, Quantization
from forge.data.base import Dataset
from forge.detectors.lstm_autoencoder import LSTMAutoEncoderDetector, _make_sequences
from forge.detectors.base import DetectionResult


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _lstm_cfg(**kwargs) -> LSTMAutoEncoderDetectorConfig:
    defaults = {
        "type": DetectorType.lstm_autoencoder,
        "sequence_length": 10,
        "latent_dim": 4,
        "epochs": 2,        # very short for test speed
        "batch_size": 16,
        "threshold_percentile": 95.0,
    }
    defaults.update(kwargs)
    return LSTMAutoEncoderDetectorConfig.model_validate(defaults)


def _normal_dataset(n: int = 200, n_features: int = 1, seed: int = 0) -> Dataset:
    rng = np.random.default_rng(seed)
    samples = rng.normal(0.0, 1.0, size=(n, n_features)).astype(np.float32)
    columns = [f"f{i}" for i in range(n_features)]
    return Dataset(samples=samples, columns=columns)


def _spike_dataset(seq_len: int = 10) -> Dataset:
    """seq_len*3 normal samples + 1 clear outlier at index seq_len*2."""
    n = seq_len * 3 + 1
    samples = np.zeros((n, 1), dtype=np.float32)
    samples[seq_len * 2, 0] = 100.0
    return Dataset(samples=samples, columns=["value"])


# ---------------------------------------------------------------------------
# _make_sequences helper
# ---------------------------------------------------------------------------

def test_make_sequences_shape():
    X = np.zeros((50, 2), dtype=np.float32)
    seqs = _make_sequences(X, seq_len=10)
    assert seqs.shape == (41, 10, 2)


def test_make_sequences_single_window():
    X = np.arange(10, dtype=np.float32).reshape(10, 1)
    seqs = _make_sequences(X, seq_len=10)
    assert seqs.shape == (1, 10, 1)
    assert np.allclose(seqs[0, :, 0], np.arange(10))


def test_make_sequences_too_short_raises():
    X = np.zeros((5, 1), dtype=np.float32)
    with pytest.raises(ValueError, match="sequence_length"):
        _make_sequences(X, seq_len=10)


# ---------------------------------------------------------------------------
# fit / score
# ---------------------------------------------------------------------------

def test_fit_does_not_raise():
    ds = _normal_dataset(n=100)
    d = LSTMAutoEncoderDetector(_lstm_cfg())
    d.fit(ds)


def test_score_returns_correct_shape():
    ds = _normal_dataset(n=100)
    d = LSTMAutoEncoderDetector(_lstm_cfg())
    d.fit(ds)
    scores = d.score(ds)
    assert scores.shape == (100,)


def test_score_dtype_is_float32():
    ds = _normal_dataset(n=100)
    d = LSTMAutoEncoderDetector(_lstm_cfg())
    d.fit(ds)
    assert d.score(ds).dtype == np.float32


def test_score_first_samples_are_zero():
    """First sequence_length - 1 samples have no full window → score 0."""
    seq_len = 10
    ds = _normal_dataset(n=100)
    d = LSTMAutoEncoderDetector(_lstm_cfg(sequence_length=seq_len))
    d.fit(ds)
    scores = d.score(ds)
    assert np.all(scores[: seq_len - 1] == 0.0)


def test_score_scored_samples_nonzero_after_fit():
    """Samples from seq_len onward should have non-zero scores (reconstruction error > 0)."""
    seq_len = 5
    ds = _normal_dataset(n=100, seed=99)
    d = LSTMAutoEncoderDetector(_lstm_cfg(sequence_length=seq_len, epochs=3))
    d.fit(ds)
    scores = d.score(ds)
    assert np.any(scores[seq_len - 1:] > 0.0)


def test_score_spike_higher_than_normal():
    """Spike reconstruction error should exceed average normal error."""
    seq_len = 5
    ds = _spike_dataset(seq_len=seq_len)
    d = LSTMAutoEncoderDetector(_lstm_cfg(sequence_length=seq_len, epochs=5))
    d.fit(ds)
    scores = d.score(ds)
    spike_idx = seq_len * 2
    # Score at spike position should be higher than median of normal scores
    normal_scores = np.concatenate([scores[seq_len - 1: spike_idx], scores[spike_idx + 1:]])
    assert scores[spike_idx] > np.median(normal_scores)


def test_score_before_fit_raises():
    d = LSTMAutoEncoderDetector(_lstm_cfg())
    with pytest.raises(RuntimeError, match="fitted"):
        d.score(_normal_dataset())


def test_dataset_too_short_raises():
    """Dataset shorter than sequence_length should raise ValueError on fit."""
    ds = _normal_dataset(n=5)
    d = LSTMAutoEncoderDetector(_lstm_cfg(sequence_length=10))
    with pytest.raises(ValueError, match="sequence_length"):
        d.fit(ds)


def test_fit_multi_feature():
    ds = _normal_dataset(n=200, n_features=3)
    d = LSTMAutoEncoderDetector(_lstm_cfg())
    d.fit(ds)
    scores = d.score(ds)
    assert scores.shape == (200,)


# ---------------------------------------------------------------------------
# predict
# ---------------------------------------------------------------------------

def test_predict_returns_detection_result():
    ds = _normal_dataset(n=100)
    d = LSTMAutoEncoderDetector(_lstm_cfg())
    d.fit(ds)
    result = d.predict(ds)
    assert isinstance(result, DetectionResult)
    assert result.detector_name == "lstm_autoencoder"


def test_predict_labels_are_binary():
    ds = _normal_dataset(n=100)
    d = LSTMAutoEncoderDetector(_lstm_cfg())
    d.fit(ds)
    result = d.predict(ds)
    assert set(result.labels.tolist()).issubset({0, 1})


def test_predict_before_fit_raises():
    d = LSTMAutoEncoderDetector(_lstm_cfg())
    with pytest.raises(RuntimeError, match="fitted"):
        d.predict(_normal_dataset())


# ---------------------------------------------------------------------------
# Export -- TFLite + JSON + C header
# ---------------------------------------------------------------------------

def test_export_creates_three_files(tmp_path: Path):
    ds = _normal_dataset(n=100)
    d = LSTMAutoEncoderDetector(_lstm_cfg())
    d.fit(ds)
    written = d.export(tmp_path, stem="test")
    names = {p.name for p in written}
    assert "lstm_autoencoder.tflite" in names
    assert "lstm_autoencoder_config.json" in names
    assert "fovet_lstm_autoencoder_model.h" in names


def test_export_tflite_is_non_empty(tmp_path: Path):
    ds = _normal_dataset(n=100)
    d = LSTMAutoEncoderDetector(_lstm_cfg())
    d.fit(ds)
    d.export(tmp_path, stem="test")
    assert (tmp_path / "lstm_autoencoder.tflite").stat().st_size > 0


def test_export_json_is_valid(tmp_path: Path):
    ds = _normal_dataset(n=100)
    d = LSTMAutoEncoderDetector(_lstm_cfg())
    d.fit(ds)
    d.export(tmp_path, stem="my-pipeline")
    content = json.loads((tmp_path / "lstm_autoencoder_config.json").read_text())
    assert content["detector"] == "lstm_autoencoder"
    assert content["pipeline"] == "my-pipeline"
    assert "decision_threshold" in content
    assert content["sequence_length"] == 10
    assert isinstance(content["features"], list)


def test_export_c_header_guard(tmp_path: Path):
    ds = _normal_dataset(n=100)
    d = LSTMAutoEncoderDetector(_lstm_cfg())
    d.fit(ds)
    d.export(tmp_path, stem="test")
    content = (tmp_path / "fovet_lstm_autoencoder_model.h").read_text()
    assert "FOVET_LSTM_AUTOENCODER_MODEL_H" in content
    assert "g_lstm_autoencoder_model_data" in content
    assert "g_lstm_autoencoder_threshold" in content
    assert "g_lstm_autoencoder_seq_len" in content
    assert "uint8_t" in content


def test_export_c_header_seq_len_matches_config(tmp_path: Path):
    ds = _normal_dataset(n=150)
    seq_len = 15
    d = LSTMAutoEncoderDetector(_lstm_cfg(sequence_length=seq_len))
    d.fit(ds)
    d.export(tmp_path, stem="test")
    content = (tmp_path / "fovet_lstm_autoencoder_model.h").read_text()
    assert f"g_lstm_autoencoder_seq_len   = {seq_len};" in content


def test_export_before_fit_raises(tmp_path: Path):
    d = LSTMAutoEncoderDetector(_lstm_cfg())
    with pytest.raises(RuntimeError, match="fitted"):
        d.export(tmp_path, stem="test")


def test_export_int8_produces_file(tmp_path: Path):
    """INT8 quantisation path should complete without error."""
    ds = _normal_dataset(n=200, seed=1)
    d = LSTMAutoEncoderDetector(_lstm_cfg(epochs=3))
    d.fit(ds)
    written = d.export(tmp_path, stem="test", quantization=Quantization.int8)
    assert (tmp_path / "lstm_autoencoder.tflite").exists()
    assert len(written) == 3


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------

def test_registry_builds_lstm_autoencoder():
    from forge.config import PipelineConfig
    cfg = PipelineConfig.model_validate({
        "name": "test",
        "data": {"source": "synthetic", "columns": ["v"]},
        "detectors": [{"type": "lstm_autoencoder", "sequence_length": 10, "latent_dim": 4, "epochs": 2}],
    })
    from forge.detectors.registry import build_detectors
    detectors = build_detectors(cfg.detectors)
    assert len(detectors) == 1
    assert isinstance(detectors[0], LSTMAutoEncoderDetector)


# ---------------------------------------------------------------------------
# Config validation
# ---------------------------------------------------------------------------

def test_config_defaults():
    cfg = LSTMAutoEncoderDetectorConfig.model_validate({"type": "lstm_autoencoder"})
    assert cfg.sequence_length == 30
    assert cfg.latent_dim == 16
    assert cfg.epochs == 50
    assert cfg.threshold_percentile == 95.0


def test_config_sequence_length_minimum():
    with pytest.raises(Exception):
        LSTMAutoEncoderDetectorConfig.model_validate(
            {"type": "lstm_autoencoder", "sequence_length": 1}
        )


def test_tflite_micro_export_allowed_with_lstm_detector():
    """PipelineConfig tflite_micro validator should accept lstm_autoencoder."""
    from forge.config import PipelineConfig
    cfg = PipelineConfig.model_validate({
        "name": "test",
        "data": {"source": "synthetic", "columns": ["v"]},
        "detectors": [{"type": "lstm_autoencoder", "sequence_length": 5, "epochs": 2}],
        "export": {"targets": ["tflite_micro"], "output_dir": "models"},
    })
    assert cfg is not None
