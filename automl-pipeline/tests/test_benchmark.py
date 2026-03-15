"""Tests for BenchmarkSummary and multi-detector comparison report — Forge F4-bench."""

import json
from pathlib import Path

import numpy as np
import pytest

from forge.evaluation import BenchmarkSummary, EvaluationMetrics
from forge.detectors.base import DetectionResult


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _metrics(name: str, precision: float, recall: float, f1: float,
             tp: int = 10, fp: int = 2, fn: int = 3, tn: int = 85) -> EvaluationMetrics:
    return EvaluationMetrics(
        detector_name=name,
        n_samples=tp + fp + fn + tn,
        n_anomalies_predicted=tp + fp,
        anomaly_rate=(tp + fp) / (tp + fp + fn + tn),
        has_ground_truth=True,
        tp=tp, fp=fp, fn=fn, tn=tn,
        precision=precision,
        recall=recall,
        f1=f1,
    )


def _metrics_no_gt(name: str) -> EvaluationMetrics:
    return EvaluationMetrics(
        detector_name=name,
        n_samples=100,
        n_anomalies_predicted=5,
        anomaly_rate=0.05,
        has_ground_truth=False,
    )


# ---------------------------------------------------------------------------
# BenchmarkSummary
# ---------------------------------------------------------------------------

def test_benchmark_summary_best_by_f1():
    metrics = [
        _metrics("zscore",    precision=0.80, recall=0.70, f1=0.75),
        _metrics("isoforest", precision=0.85, recall=0.75, f1=0.80),
        _metrics("autoenc",   precision=0.70, recall=0.90, f1=0.79),
    ]
    summary = BenchmarkSummary.from_metrics(metrics)
    assert summary.best_by_f1 == "isoforest"


def test_benchmark_summary_best_by_recall():
    metrics = [
        _metrics("zscore",    precision=0.80, recall=0.70, f1=0.75),
        _metrics("isoforest", precision=0.85, recall=0.75, f1=0.80),
        _metrics("autoenc",   precision=0.70, recall=0.90, f1=0.79),
    ]
    summary = BenchmarkSummary.from_metrics(metrics)
    assert summary.best_by_recall == "autoenc"


def test_benchmark_summary_best_by_precision():
    metrics = [
        _metrics("zscore",    precision=0.80, recall=0.70, f1=0.75),
        _metrics("isoforest", precision=0.85, recall=0.75, f1=0.80),
        _metrics("autoenc",   precision=0.70, recall=0.90, f1=0.79),
    ]
    summary = BenchmarkSummary.from_metrics(metrics)
    assert summary.best_by_precision == "isoforest"


def test_benchmark_summary_no_ground_truth_returns_none():
    metrics = [_metrics_no_gt("zscore"), _metrics_no_gt("isoforest")]
    summary = BenchmarkSummary.from_metrics(metrics)
    assert summary.best_by_f1 is None
    assert summary.best_by_precision is None
    assert summary.best_by_recall is None


def test_benchmark_summary_single_detector():
    metrics = [_metrics("zscore", precision=0.80, recall=0.70, f1=0.75)]
    summary = BenchmarkSummary.from_metrics(metrics)
    assert summary.best_by_f1 == "zscore"


def test_benchmark_summary_as_dict_keys():
    metrics = [
        _metrics("zscore",    precision=0.80, recall=0.70, f1=0.75),
        _metrics("isoforest", precision=0.85, recall=0.75, f1=0.80),
    ]
    d = BenchmarkSummary.from_metrics(metrics).as_dict()
    assert "best_by_f1" in d
    assert "best_by_precision" in d
    assert "best_by_recall" in d
    assert "detectors" in d
    assert len(d["detectors"]) == 2


def test_benchmark_summary_as_dict_best_values():
    metrics = [
        _metrics("zscore",    precision=0.80, recall=0.70, f1=0.75),
        _metrics("isoforest", precision=0.85, recall=0.75, f1=0.80),
    ]
    d = BenchmarkSummary.from_metrics(metrics).as_dict()
    assert d["best_by_f1"] == "isoforest"
    assert d["best_by_precision"] == "isoforest"


def test_benchmark_summary_mixed_gt_and_no_gt():
    """Detectors without ground truth are ignored for best_by_* selection."""
    metrics = [
        _metrics("zscore",    precision=0.80, recall=0.70, f1=0.75),
        _metrics_no_gt("isoforest"),
    ]
    summary = BenchmarkSummary.from_metrics(metrics)
    assert summary.best_by_f1 == "zscore"  # only one detector with GT


# ---------------------------------------------------------------------------
# Report — comparison table (HTML)
# ---------------------------------------------------------------------------

def test_html_report_contains_comparison_table_for_multiple_detectors(tmp_path: Path):
    """With 2+ detectors and ground truth, HTML should include comparison table."""
    from forge.config import PipelineConfig
    from forge.report import generate_report

    cfg = PipelineConfig.model_validate({
        "name": "bench-test",
        "data": {"source": "synthetic", "columns": ["v"]},
        "detectors": [{"type": "zscore"}, {"type": "isolation_forest"}],
        "report": {"enabled": True, "format": "html", "output_dir": str(tmp_path)},
    })

    metrics = [
        _metrics("zscore",    precision=0.80, recall=0.70, f1=0.75),
        _metrics("isoforest", precision=0.85, recall=0.75, f1=0.80),
    ]

    report_path = generate_report(cfg, metrics, train_n=800, test_n=200, output_dir=tmp_path)
    content = report_path.read_text(encoding="utf-8")

    assert "Comparaison des détecteurs" in content
    assert "cmp-table" in content
    assert "zscore" in content
    assert "isoforest" in content


def test_html_report_highlights_best_detector(tmp_path: Path):
    from forge.config import PipelineConfig
    from forge.report import generate_report

    cfg = PipelineConfig.model_validate({
        "name": "bench-test",
        "data": {"source": "synthetic", "columns": ["v"]},
        "detectors": [{"type": "zscore"}, {"type": "isolation_forest"}],
        "report": {"enabled": True, "format": "html", "output_dir": str(tmp_path)},
    })

    metrics = [
        _metrics("zscore",    precision=0.80, recall=0.70, f1=0.75),
        _metrics("isoforest", precision=0.85, recall=0.75, f1=0.80),
    ]

    report_path = generate_report(cfg, metrics, train_n=800, test_n=200, output_dir=tmp_path)
    content = report_path.read_text(encoding="utf-8")

    assert 'class="best"' in content
    assert "isoforest" in content


def test_html_report_no_comparison_for_single_detector(tmp_path: Path):
    """Single detector → no comparison table section."""
    from forge.config import PipelineConfig
    from forge.report import generate_report

    cfg = PipelineConfig.model_validate({
        "name": "single",
        "data": {"source": "synthetic", "columns": ["v"]},
        "detectors": [{"type": "zscore"}],
        "report": {"enabled": True, "format": "html", "output_dir": str(tmp_path)},
    })

    metrics = [_metrics("zscore", precision=0.80, recall=0.70, f1=0.75)]
    report_path = generate_report(cfg, metrics, train_n=800, test_n=200, output_dir=tmp_path)
    content = report_path.read_text(encoding="utf-8")

    assert "Comparaison des détecteurs" not in content
    assert '<table class="cmp-table">' not in content


def test_html_report_comparison_no_gt_shows_badge(tmp_path: Path):
    """No ground truth + multiple detectors → badge message, no table."""
    from forge.config import PipelineConfig
    from forge.report import generate_report

    cfg = PipelineConfig.model_validate({
        "name": "no-gt",
        "data": {"source": "synthetic", "columns": ["v"]},
        "detectors": [{"type": "zscore"}, {"type": "isolation_forest"}],
        "report": {"enabled": True, "format": "html", "output_dir": str(tmp_path)},
    })

    metrics = [_metrics_no_gt("zscore"), _metrics_no_gt("isoforest")]
    report_path = generate_report(cfg, metrics, train_n=800, test_n=200, output_dir=tmp_path)
    content = report_path.read_text(encoding="utf-8")

    assert "Comparaison des détecteurs" in content
    assert "badge-na" in content
    assert '<table class="cmp-table">' not in content


# ---------------------------------------------------------------------------
# Report — JSON format includes benchmark section
# ---------------------------------------------------------------------------

def test_json_report_benchmark_section_for_multiple_detectors(tmp_path: Path):
    from forge.config import PipelineConfig
    from forge.report import generate_report

    cfg = PipelineConfig.model_validate({
        "name": "bench-json",
        "data": {"source": "synthetic", "columns": ["v"]},
        "detectors": [{"type": "zscore"}, {"type": "isolation_forest"}],
        "report": {"enabled": True, "format": "json", "output_dir": str(tmp_path)},
    })

    metrics = [
        _metrics("zscore",    precision=0.80, recall=0.70, f1=0.75),
        _metrics("isoforest", precision=0.85, recall=0.75, f1=0.80),
    ]

    report_path = generate_report(cfg, metrics, train_n=800, test_n=200, output_dir=tmp_path)
    data = json.loads(report_path.read_text(encoding="utf-8"))

    assert "benchmark" in data
    assert data["benchmark"]["best_by_f1"] == "isoforest"
    assert data["benchmark"]["best_by_precision"] == "isoforest"
    assert len(data["benchmark"]["detectors"]) == 2


def test_json_report_no_benchmark_section_for_single_detector(tmp_path: Path):
    from forge.config import PipelineConfig
    from forge.report import generate_report

    cfg = PipelineConfig.model_validate({
        "name": "single-json",
        "data": {"source": "synthetic", "columns": ["v"]},
        "detectors": [{"type": "zscore"}],
        "report": {"enabled": True, "format": "json", "output_dir": str(tmp_path)},
    })

    metrics = [_metrics("zscore", precision=0.80, recall=0.70, f1=0.75)]
    report_path = generate_report(cfg, metrics, train_n=800, test_n=200, output_dir=tmp_path)
    data = json.loads(report_path.read_text(encoding="utf-8"))

    assert "benchmark" not in data


# ---------------------------------------------------------------------------
# Config validation — benchmark_4detectors.yaml
# ---------------------------------------------------------------------------

def test_benchmark_yaml_config_is_valid():
    from forge.config import PipelineConfig
    cfg = PipelineConfig.from_yaml("configs/benchmark_4detectors.yaml")
    assert cfg.name == "benchmark-4detectors"
    assert len(cfg.detectors) == 4
    types = [d.type.value for d in cfg.detectors]
    assert "zscore" in types
    assert "isolation_forest" in types
    assert "autoencoder" in types
    assert "lstm_autoencoder" in types
    assert cfg.split.enabled is True
