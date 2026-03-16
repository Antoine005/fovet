"""
Tests for forge benchmark CLI command — Forge-7.

Tests:
    - test_benchmark_requires_at_least_two_configs
    - test_benchmark_two_zscore_configs
    - test_benchmark_generates_report
    - test_benchmark_returns_all_metrics
    - test_benchmark_mixed_detectors
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from forge.config import PipelineConfig
from forge.benchmark import run_benchmark


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _zscore_config(name: str = "cfg-zscore", **zscore_kwargs) -> PipelineConfig:
    """Build a minimal zscore PipelineConfig using synthetic data."""
    detector = {"type": "zscore", "threshold_sigma": 3.0, "min_samples": 10}
    detector.update(zscore_kwargs)
    return PipelineConfig.model_validate({
        "name": name,
        "data": {
            "source": "synthetic",
            "signal": "sine",
            "n_samples": 300,
            "noise_std": 0.1,
            "anomaly_rate": 0.05,
            "anomaly_magnitude": 5.0,
            "columns": ["value"],
            "seed": 42,
        },
        "detectors": [detector],
        "split": {"enabled": True, "test_ratio": 0.2, "random_state": 42},
        "report": {"enabled": True, "format": "json"},
    })


def _isoforest_config(name: str = "cfg-isoforest") -> PipelineConfig:
    """Build a minimal isolation_forest PipelineConfig using synthetic data."""
    return PipelineConfig.model_validate({
        "name": name,
        "data": {
            "source": "synthetic",
            "signal": "sine",
            "n_samples": 300,
            "noise_std": 0.1,
            "anomaly_rate": 0.05,
            "anomaly_magnitude": 5.0,
            "columns": ["value"],
            "seed": 42,
        },
        "detectors": [{"type": "isolation_forest", "contamination": 0.05, "n_estimators": 10, "random_state": 0}],
        "split": {"enabled": True, "test_ratio": 0.2, "random_state": 42},
        "report": {"enabled": True, "format": "json"},
    })


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_benchmark_requires_at_least_two_configs():
    """Passing a single config must raise ValueError."""
    cfg = _zscore_config()
    with pytest.raises(ValueError, match="at least 2"):
        run_benchmark([cfg])


def test_benchmark_requires_at_least_two_configs_empty():
    """Passing an empty list must raise ValueError."""
    with pytest.raises(ValueError, match="at least 2"):
        run_benchmark([])


def test_benchmark_two_zscore_configs(tmp_path: Path):
    """Two zscore configs on synthetic data return exactly 2 EvaluationMetrics."""
    cfg1 = _zscore_config("zscore-3sigma", threshold_sigma=3.0)
    cfg2 = _zscore_config("zscore-2sigma", threshold_sigma=2.0)

    metrics = run_benchmark([cfg1, cfg2], output_dir=tmp_path)

    assert len(metrics) == 2
    assert metrics[0].detector_name == "zscore"
    assert metrics[1].detector_name == "zscore"
    assert metrics[0].n_samples > 0
    assert metrics[1].n_samples > 0


def test_benchmark_generates_report(tmp_path: Path):
    """run_benchmark writes a report file to output_dir."""
    cfg1 = _zscore_config("cfg-a")
    cfg2 = _zscore_config("cfg-b")

    run_benchmark([cfg1, cfg2], output_dir=tmp_path)

    reports = list(tmp_path.glob("benchmark_*.json"))
    assert len(reports) == 1, f"Expected 1 report, found: {reports}"


def test_benchmark_generates_report_filename_prefix(tmp_path: Path):
    """The report file must be named benchmark_<timestamp>.json (or .html)."""
    cfg1 = _zscore_config("cfg-x")
    cfg2 = _zscore_config("cfg-y")

    run_benchmark([cfg1, cfg2], output_dir=tmp_path)

    reports = list(tmp_path.iterdir())
    assert len(reports) == 1
    assert reports[0].name.startswith("benchmark_")


def test_benchmark_returns_all_metrics(tmp_path: Path):
    """Total metrics count equals total number of detectors across all configs."""
    cfg1 = PipelineConfig.model_validate({
        "name": "multi-a",
        "data": {
            "source": "synthetic",
            "n_samples": 300,
            "columns": ["value"],
            "seed": 0,
        },
        "detectors": [
            {"type": "zscore"},
            {"type": "ewma_drift"},
        ],
        "split": {"enabled": True, "test_ratio": 0.2},
        "report": {"enabled": True, "format": "json"},
    })
    cfg2 = _zscore_config("single-det")

    # cfg1 has 2 detectors, cfg2 has 1 → total = 3
    metrics = run_benchmark([cfg1, cfg2], output_dir=tmp_path)
    assert len(metrics) == 3


def test_benchmark_mixed_detectors(tmp_path: Path):
    """zscore + isolation_forest configs both produce metrics."""
    cfg_zscore = _zscore_config("z")
    cfg_iso = _isoforest_config("iso")

    metrics = run_benchmark([cfg_zscore, cfg_iso], output_dir=tmp_path)

    assert len(metrics) == 2
    detector_names = {m.detector_name for m in metrics}
    assert "zscore" in detector_names
    assert "isolation_forest" in detector_names


def test_benchmark_report_json_structure(tmp_path: Path):
    """JSON benchmark report contains expected top-level keys."""
    cfg1 = _zscore_config("p")
    cfg2 = _zscore_config("q")

    run_benchmark([cfg1, cfg2], output_dir=tmp_path)

    report_file = next(tmp_path.glob("benchmark_*.json"))
    data = json.loads(report_file.read_text(encoding="utf-8"))

    assert data["benchmark"] is True
    assert "configs" in data
    assert "detectors" in data
    assert "summary" in data
    assert len(data["detectors"]) == 2


def test_benchmark_metrics_have_ground_truth(tmp_path: Path):
    """With synthetic anomaly-labeled data, metrics should include ground truth."""
    cfg1 = _zscore_config("gt-a")
    cfg2 = _zscore_config("gt-b")

    metrics = run_benchmark([cfg1, cfg2], output_dir=tmp_path)

    for m in metrics:
        assert m.has_ground_truth is True
        assert m.precision is not None
        assert m.recall is not None
        assert m.f1 is not None


def test_benchmark_html_report(tmp_path: Path):
    """When format=html, report file ends with .html."""
    cfg1 = PipelineConfig.model_validate({
        "name": "html-a",
        "data": {
            "source": "synthetic",
            "n_samples": 200,
            "columns": ["value"],
            "seed": 1,
        },
        "detectors": [{"type": "zscore"}],
        "split": {"enabled": False},
        "report": {"enabled": True, "format": "html"},
    })
    cfg2 = PipelineConfig.model_validate({
        "name": "html-b",
        "data": {
            "source": "synthetic",
            "n_samples": 200,
            "columns": ["value"],
            "seed": 1,
        },
        "detectors": [{"type": "zscore"}],
        "split": {"enabled": False},
        "report": {"enabled": True, "format": "html"},
    })

    run_benchmark([cfg1, cfg2], output_dir=tmp_path)

    html_reports = list(tmp_path.glob("benchmark_*.html"))
    assert len(html_reports) == 1
    content = html_reports[0].read_text(encoding="utf-8")
    assert "<!DOCTYPE html>" in content
    assert "Benchmark" in content
