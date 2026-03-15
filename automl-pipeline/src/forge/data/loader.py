"""
Data loader factory — dispatches to the right connector based on config.source.
"""

from __future__ import annotations

from forge.config import DataConfig, DataSource
from forge.data.base import Dataset


def load_data(config: DataConfig) -> Dataset:
    """Load data from any supported source (synthetic, csv, mqtt)."""
    if config.source == DataSource.synthetic:
        from forge.data.synthetic import generate
        return generate(config)

    if config.source == DataSource.csv:
        from forge.data.csv_loader import load
        return load(config)

    if config.source == DataSource.mqtt:
        from forge.data.mqtt_loader import load
        return load(config)

    raise ValueError(f"Unknown data source: {config.source}")
