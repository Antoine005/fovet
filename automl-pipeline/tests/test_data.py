"""Tests for data connectors: synthetic generator and CSV loader."""

import textwrap
from pathlib import Path

import numpy as np
import pytest

from forge.config import (
    CsvDataConfig,
    SyntheticDataConfig,
    DataSource,
    PipelineConfig,
)
from forge.data import load_data
from forge.data.base import Dataset
from forge.data.synthetic import generate
from forge.data.csv_loader import load


# ---------------------------------------------------------------------------
# Dataset base class
# ---------------------------------------------------------------------------

def test_dataset_rejects_1d_array():
    with pytest.raises(ValueError, match="2-D"):
        Dataset(samples=np.zeros(10), columns=["x"])


def test_dataset_rejects_column_mismatch():
    with pytest.raises(ValueError, match="columns length"):
        Dataset(samples=np.zeros((10, 2)), columns=["x"])


def test_dataset_rejects_label_length_mismatch():
    with pytest.raises(ValueError, match="labels length"):
        Dataset(
            samples=np.zeros((10, 1)),
            columns=["x"],
            labels=np.zeros(5, dtype=np.int8),
        )


def test_dataset_properties():
    ds = Dataset(
        samples=np.zeros((100, 3), dtype=np.float32),
        columns=["x", "y", "z"],
        labels=np.array([1] * 5 + [0] * 95, dtype=np.int8),
    )
    assert ds.n_samples == 100
    assert ds.n_features == 3
    assert ds.anomaly_count == 5
    assert ds.anomaly_rate == pytest.approx(0.05)


# ---------------------------------------------------------------------------
# Synthetic generator
# ---------------------------------------------------------------------------

def _cfg(**kwargs) -> SyntheticDataConfig:
    defaults = {
        "source": DataSource.synthetic,
        "columns": ["value"],
        "n_samples": 200,
        "seed": 0,
    }
    defaults.update(kwargs)
    return SyntheticDataConfig.model_validate(defaults)


def test_synthetic_shape():
    ds = generate(_cfg(n_samples=500, columns=["x", "y"]))
    assert ds.samples.shape == (500, 2)
    assert ds.n_features == 2
    assert ds.labels is not None
    assert len(ds.labels) == 500


def test_synthetic_dtype_is_float32():
    ds = generate(_cfg())
    assert ds.samples.dtype == np.float32


def test_synthetic_anomaly_count_matches_rate():
    n = 1000
    rate = 0.05
    ds = generate(_cfg(n_samples=n, anomaly_rate=rate))
    assert ds.anomaly_count == int(n * rate)


def test_synthetic_zero_anomaly_rate():
    ds = generate(_cfg(n_samples=200, anomaly_rate=0.0))
    assert ds.anomaly_count == 0


def test_synthetic_labels_are_binary():
    ds = generate(_cfg(n_samples=300))
    assert set(ds.labels.tolist()).issubset({0, 1})


def test_synthetic_seed_reproducibility():
    ds1 = generate(_cfg(seed=42))
    ds2 = generate(_cfg(seed=42))
    np.testing.assert_array_equal(ds1.samples, ds2.samples)
    np.testing.assert_array_equal(ds1.labels, ds2.labels)


def test_synthetic_different_seeds_differ():
    ds1 = generate(_cfg(seed=1))
    ds2 = generate(_cfg(seed=2))
    assert not np.array_equal(ds1.samples, ds2.samples)


def test_synthetic_sine_oscillates():
    ds = generate(_cfg(signal="sine", noise_std=0.0, n_samples=1000, anomaly_rate=0.0))
    # Sine without noise should have mean near 0
    # Use only non-anomaly points
    normal_mask = ds.labels == 0 if ds.labels is not None else slice(None)
    mean = float(ds.samples[normal_mask].mean())
    assert abs(mean) < 0.1


def test_synthetic_random_walk():
    ds = generate(_cfg(signal="random_walk", n_samples=500))
    assert ds.samples.shape == (500, 1)


def test_synthetic_constant_near_zero():
    ds = generate(_cfg(signal="constant", noise_std=0.0, n_samples=200, anomaly_rate=0.0))
    normal_mask = ds.labels == 0 if ds.labels is not None else slice(None)
    assert float(ds.samples[normal_mask].std()) == pytest.approx(0.0, abs=1e-5)


def test_synthetic_anomalies_are_outliers():
    ds = generate(_cfg(n_samples=1000, anomaly_magnitude=10.0, noise_std=0.01, seed=7))
    normal = ds.samples[ds.labels == 0]
    anomaly = ds.samples[ds.labels == 1]
    mean, std = float(normal.mean()), float(normal.std())
    # Each anomaly should be at least 3 std from normal mean
    distances = np.abs(anomaly - mean) / (std + 1e-9)
    assert float(distances.min()) > 3.0


# ---------------------------------------------------------------------------
# CSV loader
# ---------------------------------------------------------------------------

@pytest.fixture
def tmp_csv(tmp_path: Path) -> Path:
    content = textwrap.dedent("""\
        timestamp,x_accel,y_accel,z_accel
        2026-01-01T00:00:00,0.1,0.2,9.8
        2026-01-01T00:00:01,0.15,0.18,9.81
        2026-01-01T00:00:02,0.12,0.22,9.79
    """)
    p = tmp_path / "test.csv"
    p.write_text(content)
    return p


def test_csv_loads_correct_shape(tmp_csv: Path):
    cfg = CsvDataConfig.model_validate({
        "source": "csv",
        "path": str(tmp_csv),
        "columns": ["x_accel", "y_accel", "z_accel"],
    })
    ds = load(cfg)
    assert ds.samples.shape == (3, 3)
    assert ds.n_features == 3
    assert ds.labels is None


def test_csv_loads_timestamps(tmp_csv: Path):
    cfg = CsvDataConfig.model_validate({
        "source": "csv",
        "path": str(tmp_csv),
        "columns": ["x_accel"],
        "timestamp_column": "timestamp",
    })
    ds = load(cfg)
    assert ds.timestamps is not None
    assert len(ds.timestamps) == 3


def test_csv_dtype_is_float32(tmp_csv: Path):
    cfg = CsvDataConfig.model_validate({
        "source": "csv",
        "path": str(tmp_csv),
        "columns": ["x_accel"],
    })
    ds = load(cfg)
    assert ds.samples.dtype == np.float32


def test_csv_missing_column_raises(tmp_csv: Path):
    cfg = CsvDataConfig.model_validate({
        "source": "csv",
        "path": str(tmp_csv),
        "columns": ["nonexistent"],
    })
    with pytest.raises(ValueError, match="not found"):
        load(cfg)


def test_csv_file_not_found_raises():
    cfg = CsvDataConfig.model_validate({
        "source": "csv",
        "path": "nonexistent.csv",
        "columns": ["x"],
    })
    with pytest.raises(FileNotFoundError):
        load(cfg)


# ---------------------------------------------------------------------------
# load_data factory
# ---------------------------------------------------------------------------

def test_load_data_synthetic():
    cfg = PipelineConfig.model_validate({
        "name": "test",
        "data": {"source": "synthetic", "columns": ["v"], "n_samples": 100},
        "detectors": [{"type": "zscore"}],
    })
    ds = load_data(cfg.data)
    assert ds.n_samples == 100


def test_load_data_csv(tmp_csv: Path):
    cfg = PipelineConfig.model_validate({
        "name": "test",
        "data": {"source": "csv", "path": str(tmp_csv), "columns": ["x_accel"]},
        "detectors": [{"type": "zscore"}],
    })
    ds = load_data(cfg.data)
    assert ds.n_samples == 3


def test_load_data_mqtt_raises_without_paho(monkeypatch):
    """load_data(mqtt) raises ImportError when paho-mqtt is not installed."""
    import sys
    monkeypatch.setitem(sys.modules, "paho", None)
    monkeypatch.setitem(sys.modules, "paho.mqtt", None)
    monkeypatch.setitem(sys.modules, "paho.mqtt.client", None)

    cfg = PipelineConfig.model_validate({
        "name": "test",
        "data": {"source": "mqtt", "columns": ["v"]},
        "detectors": [{"type": "zscore"}],
    })
    with pytest.raises(ImportError, match="paho-mqtt"):
        load_data(cfg.data)
