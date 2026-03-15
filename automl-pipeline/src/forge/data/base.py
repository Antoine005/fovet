"""
Dataset — common data container used by all connectors and detectors.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np


@dataclass
class Dataset:
    """Holds samples loaded by a data connector.

    Attributes:
        samples:    shape (n_samples, n_features) — normalised float32 array
        columns:    feature names matching samples columns
        labels:     ground-truth anomaly flags (1=anomaly, 0=normal); None for real data
        timestamps: optional ISO-8601 timestamps, shape (n_samples,)
    """

    samples: np.ndarray
    columns: list[str]
    labels: np.ndarray | None = field(default=None)
    timestamps: np.ndarray | None = field(default=None)

    def __post_init__(self) -> None:
        if self.samples.ndim != 2:
            raise ValueError(
                f"samples must be 2-D (n_samples, n_features), got shape {self.samples.shape}"
            )
        if len(self.columns) != self.samples.shape[1]:
            raise ValueError(
                f"columns length {len(self.columns)} != samples.shape[1] {self.samples.shape[1]}"
            )
        if self.labels is not None and len(self.labels) != len(self.samples):
            raise ValueError("labels length must match n_samples")

    @property
    def n_samples(self) -> int:
        return self.samples.shape[0]

    @property
    def n_features(self) -> int:
        return self.samples.shape[1]

    @property
    def anomaly_count(self) -> int:
        if self.labels is None:
            return 0
        return int(self.labels.sum())

    @property
    def anomaly_rate(self) -> float:
        if self.labels is None or self.n_samples == 0:
            return 0.0
        return self.anomaly_count / self.n_samples

    def split(
        self, test_ratio: float = 0.2, random_state: int = 42
    ) -> tuple["Dataset", "Dataset"]:
        """Split into (train, test) datasets.

        If labels are available, uses stratified sampling to preserve
        the anomaly rate in both splits.

        Args:
            test_ratio: Fraction of samples to keep for testing (0 < ratio < 1).
            random_state: Seed for reproducibility.

        Returns:
            Tuple of (train_dataset, test_dataset).
        """
        rng = np.random.default_rng(random_state)
        n_test = max(1, int(self.n_samples * test_ratio))

        if self.labels is not None:
            normal_idx = np.where(self.labels == 0)[0]
            anomaly_idx = np.where(self.labels == 1)[0]
            rng.shuffle(normal_idx)
            rng.shuffle(anomaly_idx)
            n_test_anomaly = max(0, int(len(anomaly_idx) * test_ratio))
            n_test_normal = n_test - n_test_anomaly
            test_idx = np.concatenate([normal_idx[:n_test_normal], anomaly_idx[:n_test_anomaly]])
            train_idx = np.concatenate([normal_idx[n_test_normal:], anomaly_idx[n_test_anomaly:]])
        else:
            idx = np.arange(self.n_samples)
            rng.shuffle(idx)
            test_idx = idx[:n_test]
            train_idx = idx[n_test:]

        def _subset(indices: np.ndarray) -> "Dataset":
            return Dataset(
                samples=self.samples[indices],
                columns=self.columns,
                labels=self.labels[indices] if self.labels is not None else None,
                timestamps=self.timestamps[indices] if self.timestamps is not None else None,
            )

        return _subset(train_idx), _subset(test_idx)

    def __repr__(self) -> str:
        anomaly_info = (
            f", anomalies={self.anomaly_count}/{self.n_samples}"
            if self.labels is not None
            else ""
        )
        return (
            f"Dataset(n_samples={self.n_samples}, "
            f"n_features={self.n_features}, "
            f"columns={self.columns}"
            f"{anomaly_info})"
        )
