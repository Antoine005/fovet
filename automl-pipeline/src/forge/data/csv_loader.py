"""
CSV data connector — loads sensor data from a CSV file.

Expected format: one row per sample, one column per feature.
An optional timestamp column is parsed but not included in samples.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from forge.config import CsvDataConfig
from forge.data.base import Dataset


def load(config: CsvDataConfig) -> Dataset:
    """Load a CSV file and return a Dataset."""
    path = config.path
    if not path.exists():
        raise FileNotFoundError(f"CSV file not found: {path}")

    df = pd.read_csv(path, sep=config.separator)

    # Validate required columns
    all_expected = list(config.columns)
    if config.timestamp_column:
        all_expected.append(config.timestamp_column)

    missing = [c for c in all_expected if c not in df.columns]
    if missing:
        raise ValueError(
            f"Column(s) not found in {path}: {missing}. "
            f"Available columns: {list(df.columns)}"
        )

    # Extract timestamps
    timestamps: np.ndarray | None = None
    if config.timestamp_column:
        timestamps = df[config.timestamp_column].to_numpy(dtype=str)

    # Extract feature matrix
    samples = df[list(config.columns)].to_numpy(dtype=np.float32)

    return Dataset(
        samples=samples,
        columns=list(config.columns),
        timestamps=timestamps,
    )
