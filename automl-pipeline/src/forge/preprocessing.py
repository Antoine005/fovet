"""
Feature normalization — StandardScaler wrapper for Fovet Forge pipelines.

The scaler is fit on training data ONLY, then applied to both train and test
datasets. Fitted parameters are exported so that firmware/gateway code can
apply the same transformation before inference.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from forge.data.base import Dataset


class Scaler:
    """StandardScaler (zero-mean, unit-variance) for Forge datasets.

    Fit on training data, apply to both train and test.
    Stores mean_ and scale_ per feature for export.
    """

    def __init__(self) -> None:
        self.mean_: np.ndarray | None = None    # shape (n_features,)
        self.scale_: np.ndarray | None = None   # shape (n_features,)
        self.columns_: list[str] = []

    def fit(self, dataset: Dataset) -> None:
        """Compute per-feature mean and std from training data."""
        X = dataset.samples.astype(np.float64)
        self.mean_ = X.mean(axis=0)
        std = X.std(axis=0, ddof=1)  # sample std (ddof=1)
        # Avoid division by zero for constant features
        self.scale_ = np.where(std > 1e-9, std, 1.0)
        self.columns_ = list(dataset.columns)

    def transform(self, dataset: Dataset) -> Dataset:
        """Apply (x - mean) / scale to each feature column."""
        if self.mean_ is None:
            raise RuntimeError("Scaler must be fitted before transform.")
        X = dataset.samples.astype(np.float32)
        X_norm = (X - self.mean_.astype(np.float32)) / self.scale_.astype(np.float32)
        return Dataset(
            samples=X_norm,
            columns=dataset.columns,
            labels=dataset.labels,
        )

    def fit_transform(self, dataset: Dataset) -> Dataset:
        """Fit on dataset then return transformed version."""
        self.fit(dataset)
        return self.transform(dataset)

    def export(self, output_dir: Path, stem: str) -> Path:
        """Write scaler parameters as JSON for documentation and firmware use.

        The exported file contains per-feature mean and scale so that
        firmware can apply: normalized = (raw - mean) / scale
        """
        if self.mean_ is None:
            raise RuntimeError("Scaler must be fitted before export.")
        output_dir.mkdir(parents=True, exist_ok=True)

        params = {
            "pipeline": stem,
            "normalization": "StandardScaler",
            "formula": "normalized = (raw - mean) / scale",
            "features": self.columns_,
            "mean": [round(float(v), 8) for v in self.mean_],
            "scale": [round(float(v), 8) for v in self.scale_],
            "note": (
                "Apply this normalization to each sensor reading before "
                "passing to the detector. mean and scale are per-feature."
            ),
        }

        out_path = output_dir / "scaler_params.json"
        out_path.write_text(json.dumps(params, indent=2), encoding="utf-8")
        return out_path
