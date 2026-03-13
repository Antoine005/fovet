"""
Isolation Forest detector -- scikit-learn backend.

Suited for multivariate sensor data and contextual anomalies that
Z-Score misses. Does NOT require the signal to be Gaussian.

Export:
  - json_config: model metadata + decision threshold (for documentation / client report)
  - tflite_micro: planned Forge-4 (ONNX -> TFLite conversion)
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from sklearn.ensemble import IsolationForest as _SklearnIF

from forge.config import IsolationForestDetectorConfig
from forge.data.base import Dataset
from forge.detectors.base import Detector, DetectionResult


class IsolationForestDetector(Detector):
    """Anomaly detector based on scikit-learn IsolationForest.

    Anomaly score = -decision_function(X), so higher score = more anomalous.
    Threshold is derived from sklearn's internal contamination-based offset.
    """

    def __init__(self, config: IsolationForestDetectorConfig) -> None:
        self.config = config
        self._model: _SklearnIF | None = None
        self._columns: list[str] = []
        self._threshold: float | None = None

    # ------------------------------------------------------------------
    # Detector interface
    # ------------------------------------------------------------------

    def fit(self, dataset: Dataset) -> None:
        """Fit Isolation Forest on the dataset."""
        self._model = _SklearnIF(
            n_estimators=self.config.n_estimators,
            contamination=self.config.contamination,
            random_state=self.config.random_state,
            n_jobs=-1,
        )
        self._model.fit(dataset.samples.astype(np.float64))
        self._columns = list(dataset.columns)
        # sklearn sets offset_ so that score < 0 means anomaly
        # our threshold: anomaly_score > -offset_
        self._threshold = float(-self._model.offset_)

    def score(self, dataset: Dataset) -> np.ndarray:
        """Return anomaly scores (higher = more anomalous)."""
        self._check_fitted()
        raw = self._model.decision_function(dataset.samples.astype(np.float64))
        return (-raw).astype(np.float32)

    def predict(self, dataset: Dataset) -> DetectionResult:
        self._check_fitted()
        scores = self.score(dataset)
        # sklearn predict: -1 anomaly, 1 normal -> remap to 1/0
        sk_pred = self._model.predict(dataset.samples.astype(np.float64))
        labels = ((sk_pred == -1)).astype(np.int8)
        return DetectionResult(
            scores=scores,
            labels=labels,
            threshold=self._threshold,
            detector_name="isolation_forest",
        )

    # ------------------------------------------------------------------
    # Export
    # ------------------------------------------------------------------

    def export(self, output_dir: Path, stem: str) -> list[Path]:
        """Export model metadata as JSON (TFLite conversion planned Forge-4)."""
        self._check_fitted()
        output_dir.mkdir(parents=True, exist_ok=True)

        meta = {
            "detector": "isolation_forest",
            "pipeline": stem,
            "features": self._columns,
            "n_features": len(self._columns),
            "n_estimators": self.config.n_estimators,
            "contamination": self.config.contamination,
            "random_state": self.config.random_state,
            "decision_threshold": self._threshold,
            "note": (
                "decision_threshold: anomaly_score > threshold -> anomaly. "
                "TFLite export planned in Forge-4."
            ),
        }

        out_path = output_dir / "isolation_forest_config.json"
        out_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")
        return [out_path]

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _check_fitted(self) -> None:
        if self._model is None:
            raise RuntimeError("IsolationForestDetector must be fitted before use.")
