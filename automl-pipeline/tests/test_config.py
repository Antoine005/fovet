"""Tests for PipelineConfig — YAML loading and validation."""

import pytest
from pathlib import Path
from pydantic import ValidationError

from forge.config import (
    PipelineConfig,
    DataSource,
    DetectorType,
    ExportTarget,
    Quantization,
)

CONFIGS_DIR = Path(__file__).parent.parent / "configs"


# ---------------------------------------------------------------------------
# Load shipped example configs
# ---------------------------------------------------------------------------

def test_load_demo_zscore_yaml():
    cfg = PipelineConfig.from_yaml(CONFIGS_DIR / "demo_zscore.yaml")
    assert cfg.name == "demo-zscore-sine"
    assert cfg.data.source == DataSource.synthetic
    assert len(cfg.detectors) == 1
    assert cfg.detectors[0].type == DetectorType.zscore
    assert ExportTarget.c_header in cfg.export.targets
    assert ExportTarget.json_config in cfg.export.targets


def test_load_client_vibration_yaml():
    cfg = PipelineConfig.from_yaml(CONFIGS_DIR / "client_vibration.yaml")
    assert cfg.name == "client-vibration"
    assert cfg.data.source == DataSource.csv
    assert len(cfg.detectors) == 2
    detector_types = {d.type for d in cfg.detectors}
    assert DetectorType.zscore in detector_types
    assert DetectorType.isolation_forest in detector_types
    assert ExportTarget.tflite_micro in cfg.export.targets
    assert cfg.export.quantization == Quantization.int8


# ---------------------------------------------------------------------------
# Inline config validation
# ---------------------------------------------------------------------------

def test_minimal_valid_config():
    cfg = PipelineConfig.model_validate({
        "name": "test",
        "data": {"source": "synthetic", "columns": ["value"]},
        "detectors": [{"type": "zscore"}],
    })
    assert cfg.name == "test"
    assert cfg.detectors[0].threshold_sigma == 3.0  # default


def test_zscore_defaults():
    cfg = PipelineConfig.model_validate({
        "name": "test",
        "data": {"source": "synthetic", "columns": ["value"]},
        "detectors": [{"type": "zscore"}],
    })
    d = cfg.detectors[0]
    assert d.threshold_sigma == 3.0
    assert d.min_samples == 30


def test_synthetic_defaults():
    cfg = PipelineConfig.model_validate({
        "name": "test",
        "data": {"source": "synthetic", "columns": ["value"]},
        "detectors": [{"type": "zscore"}],
    })
    assert cfg.data.n_samples == 1000
    assert cfg.data.anomaly_rate == 0.05
    assert cfg.data.anomaly_magnitude == 5.0


def test_missing_name_raises():
    with pytest.raises(ValidationError):
        PipelineConfig.model_validate({
            "data": {"source": "synthetic", "columns": ["value"]},
            "detectors": [{"type": "zscore"}],
        })


def test_empty_detectors_raises():
    with pytest.raises(ValidationError):
        PipelineConfig.model_validate({
            "name": "test",
            "data": {"source": "synthetic", "columns": ["value"]},
            "detectors": [],
        })


def test_empty_columns_raises():
    with pytest.raises(ValidationError):
        PipelineConfig.model_validate({
            "name": "test",
            "data": {"source": "synthetic", "columns": []},
            "detectors": [{"type": "zscore"}],
        })


def test_tflite_without_ml_detector_raises():
    with pytest.raises(ValidationError, match="tflite_micro"):
        PipelineConfig.model_validate({
            "name": "test",
            "data": {"source": "synthetic", "columns": ["value"]},
            "detectors": [{"type": "zscore"}],
            "export": {"targets": ["tflite_micro"]},
        })


def test_tflite_with_isolation_forest_ok():
    cfg = PipelineConfig.model_validate({
        "name": "test",
        "data": {"source": "synthetic", "columns": ["value"]},
        "detectors": [
            {"type": "zscore"},
            {"type": "isolation_forest"},
        ],
        "export": {"targets": ["tflite_micro", "json_config"]},
    })
    assert ExportTarget.tflite_micro in cfg.export.targets


def test_negative_sigma_raises():
    with pytest.raises(ValidationError):
        PipelineConfig.model_validate({
            "name": "test",
            "data": {"source": "synthetic", "columns": ["value"]},
            "detectors": [{"type": "zscore", "threshold_sigma": -1.0}],
        })


def test_csv_config():
    cfg = PipelineConfig.model_validate({
        "name": "test",
        "data": {
            "source": "csv",
            "path": "data/test.csv",
            "columns": ["x", "y", "z"],
        },
        "detectors": [{"type": "zscore"}],
    })
    assert cfg.data.source == DataSource.csv
    assert cfg.data.columns == ["x", "y", "z"]


def test_mqtt_config():
    cfg = PipelineConfig.model_validate({
        "name": "test",
        "data": {
            "source": "mqtt",
            "broker": "localhost",
            "topic": "fovet/devices/+/readings",
            "columns": ["value"],
        },
        "detectors": [{"type": "zscore"}],
    })
    assert cfg.data.source == DataSource.mqtt
    assert cfg.data.port == 1883  # default
