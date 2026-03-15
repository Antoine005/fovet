"""
Detector factory -- builds the list of detectors from pipeline config.
"""

from __future__ import annotations

from forge.config import DetectorConfig, DetectorType
from forge.detectors.base import Detector


def build_detectors(configs: list[DetectorConfig]) -> list[Detector]:
    """Instantiate detectors from a list of DetectorConfig objects."""
    detectors: list[Detector] = []
    for cfg in configs:
        if cfg.type == DetectorType.zscore:
            from forge.detectors.zscore import ZScoreDetector
            detectors.append(ZScoreDetector(cfg))
        elif cfg.type == DetectorType.isolation_forest:
            from forge.detectors.isolation_forest import IsolationForestDetector
            detectors.append(IsolationForestDetector(cfg))
        elif cfg.type == DetectorType.autoencoder:
            from forge.detectors.autoencoder import AutoEncoderDetector
            detectors.append(AutoEncoderDetector(cfg))
        elif cfg.type == DetectorType.lstm_autoencoder:
            from forge.detectors.lstm_autoencoder import LSTMAutoEncoderDetector
            detectors.append(LSTMAutoEncoderDetector(cfg))
        elif cfg.type == DetectorType.ewma_drift:
            from forge.detectors.ewma_drift import EWMADriftDetector
            detectors.append(EWMADriftDetector(cfg))
        else:
            raise ValueError(f"Unknown detector type: {cfg.type}")
    return detectors
