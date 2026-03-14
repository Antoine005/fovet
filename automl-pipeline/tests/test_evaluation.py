"""Tests for evaluation metrics and report generation -- Forge-5."""

import json
from pathlib import Path

import numpy as np
import pytest

from forge.config import (
    PipelineConfig,
    TrainTestSplitConfig,
    ReportConfig,
)
from forge.data.base import Dataset
from forge.data.synthetic import generate
from forge.config import SyntheticDataConfig
from forge.detectors.base import DetectionResult
from forge.detectors.zscore import ZScoreDetector
from forge.config import ZScoreDetectorConfig, DetectorType
from forge.evaluation import compute_metrics, EvaluationMetrics
from forge.report import generate_report


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_result(pred: list[int], scores: list[float] | None = None) -> DetectionResult:
    labels = np.array(pred, dtype=np.int8)
    sc = np.array(scores if scores else [float(p) for p in pred], dtype=np.float32)
    return DetectionResult(scores=sc, labels=labels, threshold=0.5, detector_name="test")


def _pipeline_cfg(report_format: str = "json", split_enabled: bool = False) -> PipelineConfig:
    return PipelineConfig.model_validate({
        "name": "test-pipeline",
        "data": {"source": "synthetic", "columns": ["v"]},
        "detectors": [{"type": "zscore", "threshold_sigma": 3.0}],
        "split": {"enabled": split_enabled, "test_ratio": 0.2},
        "report": {"enabled": True, "format": report_format, "output_dir": "reports"},
    })


# ---------------------------------------------------------------------------
# compute_metrics — no ground truth
# ---------------------------------------------------------------------------

def test_metrics_no_ground_truth():
    result = _make_result([0, 0, 1, 0, 1])
    m = compute_metrics(result)
    assert m.n_samples == 5
    assert m.n_anomalies_predicted == 2
    assert abs(m.anomaly_rate - 0.4) < 1e-6
    assert not m.has_ground_truth
    assert m.precision is None
    assert m.recall is None
    assert m.f1 is None


def test_metrics_no_ground_truth_all_normal():
    result = _make_result([0, 0, 0])
    m = compute_metrics(result)
    assert m.n_anomalies_predicted == 0
    assert m.anomaly_rate == 0.0


# ---------------------------------------------------------------------------
# compute_metrics — with ground truth
# ---------------------------------------------------------------------------

def test_metrics_perfect_detection():
    gt = np.array([0, 0, 1, 0, 1], dtype=np.int8)
    result = _make_result([0, 0, 1, 0, 1])
    m = compute_metrics(result, ground_truth=gt)
    assert m.has_ground_truth
    assert m.tp == 2
    assert m.fp == 0
    assert m.fn == 0
    assert m.tn == 3
    assert m.precision == pytest.approx(1.0)
    assert m.recall == pytest.approx(1.0)
    assert m.f1 == pytest.approx(1.0)


def test_metrics_no_true_positives():
    gt = np.array([0, 0, 1, 0, 1], dtype=np.int8)
    result = _make_result([1, 0, 0, 1, 0])  # FP only, no TP
    m = compute_metrics(result, ground_truth=gt)
    assert m.tp == 0
    assert m.fp == 2
    assert m.fn == 2
    assert m.precision == 0.0
    assert m.recall == 0.0
    assert m.f1 == 0.0


def test_metrics_partial_detection():
    gt = np.array([0, 0, 1, 0, 1, 0, 0, 0, 0, 0], dtype=np.int8)
    pred = np.array([0, 0, 1, 0, 0, 0, 0, 0, 0, 0], dtype=np.int8)
    result = _make_result(pred.tolist())
    m = compute_metrics(result, ground_truth=gt)
    assert m.tp == 1
    assert m.fn == 1
    assert m.recall == pytest.approx(0.5)
    assert m.precision == pytest.approx(1.0)


def test_metrics_as_dict_keys():
    result = _make_result([0, 1])
    m = compute_metrics(result)
    d = m.as_dict()
    assert "detector" in d
    assert "precision" in d
    assert "recall" in d
    assert "f1" in d


def test_metrics_as_dict_with_ground_truth():
    gt = np.array([0, 1], dtype=np.int8)
    result = _make_result([0, 1])
    m = compute_metrics(result, ground_truth=gt)
    d = m.as_dict()
    assert d["precision"] == 1.0
    assert d["recall"] == 1.0


# ---------------------------------------------------------------------------
# Dataset.split()
# ---------------------------------------------------------------------------

def test_split_sizes():
    rng = np.random.default_rng(0)
    samples = rng.normal(0, 1, (100, 1)).astype(np.float32)
    ds = Dataset(samples=samples, columns=["v"])
    train, test = ds.split(test_ratio=0.2)
    assert train.n_samples + test.n_samples == 100
    assert test.n_samples == 20


def test_split_stratified_preserves_labels():
    """Stratified split should preserve anomaly rate in both splits."""
    samples = np.zeros((100, 1), dtype=np.float32)
    labels = np.zeros(100, dtype=np.int8)
    labels[:10] = 1  # 10% anomaly rate
    ds = Dataset(samples=samples, columns=["v"], labels=labels)
    train, test = ds.split(test_ratio=0.2)
    # Both splits should have anomalies
    assert train.anomaly_count > 0
    assert test.anomaly_count > 0


def test_split_no_overlap():
    """Samples in train and test should be disjoint."""
    rng = np.random.default_rng(1)
    samples = rng.normal(0, 1, (50, 1)).astype(np.float32)
    ds = Dataset(samples=samples, columns=["v"])
    train, test = ds.split(test_ratio=0.2)
    train_set = {tuple(r) for r in train.samples.tolist()}
    test_set = {tuple(r) for r in test.samples.tolist()}
    assert len(train_set & test_set) == 0


def test_split_preserves_columns():
    samples = np.zeros((20, 2), dtype=np.float32)
    ds = Dataset(samples=samples, columns=["x", "y"])
    train, test = ds.split(test_ratio=0.2)
    assert train.columns == ["x", "y"]
    assert test.columns == ["x", "y"]


def test_split_reproducible():
    samples = np.random.default_rng(0).normal(0, 1, (100, 1)).astype(np.float32)
    ds = Dataset(samples=samples, columns=["v"])
    train1, test1 = ds.split(test_ratio=0.2, random_state=42)
    train2, test2 = ds.split(test_ratio=0.2, random_state=42)
    np.testing.assert_array_equal(train1.samples, train2.samples)
    np.testing.assert_array_equal(test1.samples, test2.samples)


# ---------------------------------------------------------------------------
# TrainTestSplitConfig validation
# ---------------------------------------------------------------------------

def test_split_config_defaults():
    cfg = TrainTestSplitConfig()
    assert not cfg.enabled
    assert cfg.test_ratio == pytest.approx(0.2)
    assert cfg.random_state == 42


def test_split_config_invalid_ratio():
    with pytest.raises(Exception):
        TrainTestSplitConfig.model_validate({"enabled": True, "test_ratio": 1.5})


# ---------------------------------------------------------------------------
# generate_report — JSON
# ---------------------------------------------------------------------------

def test_report_json_creates_file(tmp_path: Path):
    cfg = _pipeline_cfg(report_format="json")
    m = compute_metrics(_make_result([0, 1, 0, 1]))
    path = generate_report(cfg, [m], train_n=80, test_n=20, output_dir=tmp_path)
    assert path.exists()
    assert path.suffix == ".json"


def test_report_json_content(tmp_path: Path):
    cfg = _pipeline_cfg(report_format="json")
    gt = np.array([0, 1, 0, 1], dtype=np.int8)
    m = compute_metrics(_make_result([0, 1, 0, 1]), ground_truth=gt)
    path = generate_report(cfg, [m], train_n=80, test_n=20, output_dir=tmp_path)
    data = json.loads(path.read_text())
    assert data["pipeline"] == "test-pipeline"
    assert "generated_at" in data
    assert len(data["detectors"]) == 1
    assert data["detectors"][0]["precision"] == pytest.approx(1.0)
    assert data["detectors"][0]["recall"] == pytest.approx(1.0)


def test_report_json_split_info(tmp_path: Path):
    cfg = _pipeline_cfg(report_format="json", split_enabled=True)
    m = compute_metrics(_make_result([0, 1]))
    path = generate_report(cfg, [m], train_n=800, test_n=200, output_dir=tmp_path)
    data = json.loads(path.read_text())
    assert data["split"]["enabled"] is True
    assert data["split"]["train_n"] == 800
    assert data["split"]["test_n"] == 200


# ---------------------------------------------------------------------------
# generate_report — HTML
# ---------------------------------------------------------------------------

def test_report_html_creates_file(tmp_path: Path):
    cfg = _pipeline_cfg(report_format="html")
    m = compute_metrics(_make_result([0, 1]))
    path = generate_report(cfg, [m], train_n=80, test_n=20, output_dir=tmp_path)
    assert path.exists()
    assert path.suffix == ".html"


def test_report_html_content(tmp_path: Path):
    cfg = _pipeline_cfg(report_format="html")
    gt = np.array([0, 1, 0, 1], dtype=np.int8)
    m = compute_metrics(_make_result([0, 1, 0, 1]), ground_truth=gt)
    path = generate_report(cfg, [m], train_n=80, test_n=20, output_dir=tmp_path)
    content = path.read_text(encoding="utf-8")
    assert "<!DOCTYPE html>" in content
    assert "test-pipeline" in content
    assert "Pr" in content        # "Précision" — encoding-safe check
    assert "Rappel" in content


# ---------------------------------------------------------------------------
# End-to-end: pipeline with split + report
# ---------------------------------------------------------------------------

def test_e2e_pipeline_with_split_and_report(tmp_path: Path):
    """Full pipeline run with train/test split produces metrics and report."""
    from forge.pipeline import Pipeline

    cfg = PipelineConfig.model_validate({
        "name": "e2e-split",
        "data": {
            "source": "synthetic",
            "columns": ["v"],
            "n_samples": 500,
            "anomaly_rate": 0.05,
            "seed": 0,
        },
        "detectors": [{"type": "zscore", "threshold_sigma": 3.0}],
        "split": {"enabled": True, "test_ratio": 0.2, "random_state": 42},
        "report": {"enabled": True, "format": "json", "output_dir": str(tmp_path)},
        "export": {"targets": ["json_config"], "output_dir": str(tmp_path)},
    })

    pipeline = Pipeline(cfg)
    pipeline.run()

    assert len(pipeline.metrics) == 1
    m = pipeline.metrics[0]
    assert m.has_ground_truth
    assert m.n_samples == pipeline.test_dataset.n_samples

    # Report file was created
    reports = list(tmp_path.glob("report_*.json"))
    assert len(reports) == 1


def test_e2e_pipeline_no_split_still_works(tmp_path: Path):
    """Pipeline without split still computes metrics if labels available."""
    from forge.pipeline import Pipeline

    cfg = PipelineConfig.model_validate({
        "name": "e2e-nosplit",
        "data": {
            "source": "synthetic",
            "columns": ["v"],
            "n_samples": 200,
            "anomaly_rate": 0.05,
            "seed": 1,
        },
        "detectors": [{"type": "zscore", "threshold_sigma": 3.0}],
        "split": {"enabled": False},
        "report": {"enabled": True, "format": "json", "output_dir": str(tmp_path)},
        "export": {"targets": ["json_config"], "output_dir": str(tmp_path)},
    })

    pipeline = Pipeline(cfg)
    pipeline.run()

    assert len(pipeline.metrics) == 1
    assert pipeline.metrics[0].n_samples == 200
