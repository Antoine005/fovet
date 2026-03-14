"""
Pipeline configuration — loaded from a YAML file, validated with Pydantic.

Example usage:
    config = PipelineConfig.from_yaml("configs/demo_zscore.yaml")
"""

from __future__ import annotations

from enum import Enum
from pathlib import Path
from typing import Annotated, Literal

import yaml
from pydantic import BaseModel, Field, field_validator, model_validator


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------

class DataSource(str, Enum):
    csv = "csv"
    mqtt = "mqtt"
    synthetic = "synthetic"


class DetectorType(str, Enum):
    zscore = "zscore"
    isolation_forest = "isolation_forest"
    autoencoder = "autoencoder"


class ExportTarget(str, Enum):
    c_header = "c_header"
    tflite_micro = "tflite_micro"
    json_config = "json_config"


class Quantization(str, Enum):
    float32 = "float32"
    int8 = "int8"


# ---------------------------------------------------------------------------
# Data config
# ---------------------------------------------------------------------------

class CsvDataConfig(BaseModel):
    """Load data from a local CSV file.  ``columns`` must match CSV column headers."""

    source: Literal[DataSource.csv]
    path: Path
    columns: list[str] = Field(min_length=1)
    timestamp_column: str | None = None
    separator: str = ","


class MqttDataConfig(BaseModel):
    """Stream data from a live MQTT broker.  Subscribes for ``duration_seconds``."""

    source: Literal[DataSource.mqtt]
    broker: str = "localhost"
    port: int = 1883
    topic: str = "fovet/devices/+/readings"
    username: str | None = None
    password: str | None = None
    duration_seconds: int = Field(default=60, ge=1)
    columns: list[str] = Field(min_length=1)


class SyntheticDataConfig(BaseModel):
    """Generate synthetic sensor data with optional injected anomalies.

    Supported signals: ``sine`` (periodic), ``random_walk``, ``constant``.
    Anomalies are Gaussian spikes of amplitude ``anomaly_magnitude * noise_std``.
    """

    source: Literal[DataSource.synthetic]
    signal: Literal["sine", "random_walk", "constant"] = "sine"
    n_samples: int = Field(default=1000, ge=100)
    frequency: float = Field(default=1.0, gt=0)
    noise_std: float = Field(default=0.1, ge=0)
    anomaly_rate: float = Field(default=0.05, ge=0, le=0.5)
    anomaly_magnitude: float = Field(default=5.0, gt=0)
    columns: list[str] = Field(default=["value"], min_length=1)
    seed: int | None = None


DataConfig = Annotated[
    CsvDataConfig | MqttDataConfig | SyntheticDataConfig,
    Field(discriminator="source"),
]


# ---------------------------------------------------------------------------
# Detector configs
# ---------------------------------------------------------------------------

class ZScoreDetectorConfig(BaseModel):
    """Z-Score detector using Welford online statistics.  Best for univariate Gaussian signals."""

    type: Literal[DetectorType.zscore]
    threshold_sigma: float = Field(default=3.0, gt=0)
    min_samples: int = Field(default=30, ge=2)


class IsolationForestDetectorConfig(BaseModel):
    """Isolation Forest detector (scikit-learn).  Handles multivariate and contextual anomalies."""

    type: Literal[DetectorType.isolation_forest]
    contamination: float = Field(default=0.05, gt=0, le=0.5)
    n_estimators: int = Field(default=100, ge=10)
    random_state: int = 42


class AutoEncoderDetectorConfig(BaseModel):
    """Dense autoencoder detector (Keras/TF).  Exports TFLite INT8 for TFLite Micro on ESP32."""

    type: Literal[DetectorType.autoencoder]
    latent_dim: int = Field(default=8, ge=2)
    epochs: int = Field(default=50, ge=1)
    batch_size: int = Field(default=32, ge=1)
    threshold_percentile: float = Field(default=95.0, gt=50, le=100)


DetectorConfig = Annotated[
    ZScoreDetectorConfig | IsolationForestDetectorConfig | AutoEncoderDetectorConfig,
    Field(discriminator="type"),
]


# ---------------------------------------------------------------------------
# Export config
# ---------------------------------------------------------------------------

class ExportConfig(BaseModel):
    """Controls where and how trained detector artifacts are written.

    Targets:
        - ``c_header``    -- C header with pre-calibrated structs (Z-Score)
        - ``tflite_micro`` -- TFLite model + C byte-array header (AutoEncoder)
        - ``json_config`` -- JSON metadata + decision threshold (all detectors)
    """

    targets: list[ExportTarget] = Field(default=[ExportTarget.json_config])
    output_dir: Path = Path("models")
    quantization: Quantization = Quantization.float32

    @field_validator("targets")
    @classmethod
    def at_least_one_target(cls, v: list[ExportTarget]) -> list[ExportTarget]:
        if not v:
            raise ValueError("At least one export target is required")
        return v


# ---------------------------------------------------------------------------
# Report config
# ---------------------------------------------------------------------------

class ReportConfig(BaseModel):
    """Optional HTML/JSON evaluation report (precision, recall, anomaly timeline).  Forge-5."""

    enabled: bool = True
    format: Literal["html", "json"] = "html"
    output_dir: Path = Path("reports")


# ---------------------------------------------------------------------------
# Top-level pipeline config
# ---------------------------------------------------------------------------

class PipelineConfig(BaseModel):
    """Root configuration for a Fovet Forge pipeline.

    Validated from a YAML file with ``PipelineConfig.from_yaml(path)``.
    Cross-field validation enforces that ``tflite_micro`` export requires an ML detector.
    """

    name: str = Field(min_length=1, max_length=100)
    description: str = ""
    data: DataConfig
    detectors: list[DetectorConfig] = Field(min_length=1)
    export: ExportConfig = Field(default_factory=ExportConfig)
    report: ReportConfig = Field(default_factory=ReportConfig)

    @model_validator(mode="after")
    def tflite_requires_ml_detector(self) -> PipelineConfig:
        has_tflite = ExportTarget.tflite_micro in self.export.targets
        has_ml = any(
            d.type in (DetectorType.isolation_forest, DetectorType.autoencoder)
            for d in self.detectors
        )
        if has_tflite and not has_ml:
            raise ValueError(
                "export.targets includes 'tflite_micro' but no ML detector "
                "(isolation_forest or autoencoder) is configured"
            )
        return self

    @classmethod
    def from_yaml(cls, path: str | Path) -> "PipelineConfig":
        """Load and validate a pipeline config from a YAML file."""
        raw = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
        return cls.model_validate(raw)
