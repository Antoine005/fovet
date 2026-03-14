"""
Evaluation metrics for anomaly detection results.

Computes precision, recall, F1-score, and confusion matrix components
when ground-truth labels are available.  When labels are absent (real
sensor data without annotation), only descriptive statistics are returned.

Usage:
    from forge.evaluation import compute_metrics, EvaluationMetrics
    metrics = compute_metrics(result, ground_truth=dataset.labels)
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from forge.detectors.base import DetectionResult


@dataclass
class EvaluationMetrics:
    """Evaluation metrics for one detector run.

    Attributes:
        detector_name:         Name of the detector (e.g. ``"zscore"``).
        n_samples:             Total number of samples evaluated.
        n_anomalies_predicted: Number of samples flagged as anomalies.
        anomaly_rate:          Fraction of samples flagged (predicted).
        has_ground_truth:      Whether ground-truth labels were available.
        tp, fp, fn, tn:        Confusion matrix counts (None if no ground truth).
        precision:             TP / (TP + FP), None if no ground truth.
        recall:                TP / (TP + FN), None if no ground truth.
        f1:                    Harmonic mean of precision and recall, None if no ground truth.
    """

    detector_name: str
    n_samples: int
    n_anomalies_predicted: int
    anomaly_rate: float
    has_ground_truth: bool = False
    tp: int | None = None
    fp: int | None = None
    fn: int | None = None
    tn: int | None = None
    precision: float | None = None
    recall: float | None = None
    f1: float | None = None

    def as_dict(self) -> dict:
        """Serialise to a plain dict (JSON-friendly)."""
        return {
            "detector": self.detector_name,
            "n_samples": self.n_samples,
            "n_anomalies_predicted": self.n_anomalies_predicted,
            "anomaly_rate": round(self.anomaly_rate, 4),
            "has_ground_truth": self.has_ground_truth,
            "tp": self.tp,
            "fp": self.fp,
            "fn": self.fn,
            "tn": self.tn,
            "precision": round(self.precision, 4) if self.precision is not None else None,
            "recall": round(self.recall, 4) if self.recall is not None else None,
            "f1": round(self.f1, 4) if self.f1 is not None else None,
        }


def compute_metrics(
    result: DetectionResult,
    ground_truth: np.ndarray | None = None,
) -> EvaluationMetrics:
    """Compute evaluation metrics for a detection result.

    Args:
        result:       Output of ``detector.predict(dataset)``.
        ground_truth: Ground-truth labels (1=anomaly, 0=normal).
                      Pass ``dataset.labels`` when available.

    Returns:
        ``EvaluationMetrics`` populated with confusion matrix and
        precision/recall/F1 when ground_truth is provided.
    """
    pred = result.labels
    n = len(pred)
    n_pred = int(pred.sum())

    if ground_truth is None:
        return EvaluationMetrics(
            detector_name=result.detector_name,
            n_samples=n,
            n_anomalies_predicted=n_pred,
            anomaly_rate=n_pred / n if n > 0 else 0.0,
        )

    gt = ground_truth
    tp = int(((pred == 1) & (gt == 1)).sum())
    fp = int(((pred == 1) & (gt == 0)).sum())
    fn = int(((pred == 0) & (gt == 1)).sum())
    tn = int(((pred == 0) & (gt == 0)).sum())

    precision = tp / (tp + fp) if (tp + fp) > 0 else 0.0
    recall = tp / (tp + fn) if (tp + fn) > 0 else 0.0
    f1 = (
        2 * precision * recall / (precision + recall)
        if (precision + recall) > 0
        else 0.0
    )

    return EvaluationMetrics(
        detector_name=result.detector_name,
        n_samples=n,
        n_anomalies_predicted=n_pred,
        anomaly_rate=n_pred / n if n > 0 else 0.0,
        has_ground_truth=True,
        tp=tp,
        fp=fp,
        fn=fn,
        tn=tn,
        precision=precision,
        recall=recall,
        f1=f1,
    )
