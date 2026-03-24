"""
Isolation Forest detector -- scikit-learn backend.

DEPLOYMENT MODEL (architectural decision — 2026-03-14):
  IsolationForest is CLOUD-ONLY / GATEWAY-ONLY. It is NOT deployed on MCUs.

  Reason: A 100-tree IsolationForest requires storing the full tree structure
  in C (hundreds of if/else branches per tree), which is incompatible with the
  Fovet Sentinelle constraints (< 4 KB RAM, < 1 ms/sample).

  Intended usage:
    1. Forge trains and scores on a gateway or Scaleway server.
    2. JSON export contains the detection threshold for pipeline documentation.
    3. The MCU runs Z-Score or a quantized AutoEncoder (TFLite Micro) instead.
    4. IsolationForest results are compared offline to validate edge detector quality.

Export:
  - json_config: model metadata + decision threshold (documentation / offline audit)
  - C header: NOT supported — use ZScoreDetector for edge C export
  - TFLite: NOT planned — tree structure is not convertible to TFLite
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

    def export(self, output_dir: Path, stem: str, **_kwargs) -> list[Path]:
        """Export model metadata as JSON."""
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
            "deployment": "cloud_or_gateway_only",
            "note": (
                "IsolationForest is cloud/gateway-only — too large for MCU RAM. "
                "Use fovet_zscore or autoencoder (TFLite Micro) for edge deployment."
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
