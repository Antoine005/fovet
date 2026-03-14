"""
Abstract base class for all anomaly detectors.

Every detector implements:
  fit(dataset)     -> trains on the dataset
  score(dataset)   -> returns anomaly scores in [0, inf)
  predict(dataset) -> returns binary labels (1 = anomaly)
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from forge.data.base import Dataset


@dataclass
class DetectionResult:
    """Output of a detector run on a dataset."""

    scores: np.ndarray       # shape (n_samples,) — anomaly score per sample
    labels: np.ndarray       # shape (n_samples,) — 1=anomaly, 0=normal
    threshold: float         # score value used as decision boundary
    detector_name: str

    @property
    def n_anomalies(self) -> int:
        return int(self.labels.sum())

    @property
    def anomaly_rate(self) -> float:
        return self.n_anomalies / len(self.labels) if len(self.labels) > 0 else 0.0


class Detector(ABC):
    """Common interface for all Fovet Forge anomaly detectors."""

    @abstractmethod
    def fit(self, dataset: Dataset) -> None:
        """Train the detector on a dataset."""

    @abstractmethod
    def score(self, dataset: Dataset) -> np.ndarray:
        """Return per-sample anomaly scores (higher = more anomalous)."""

    @abstractmethod
    def predict(self, dataset: Dataset) -> DetectionResult:
        """Return binary anomaly labels + scores."""

    def export(self, output_dir: Path, stem: str, **kwargs) -> list[Path]:
        """Export the trained detector to files. Returns list of written paths."""
        return []
