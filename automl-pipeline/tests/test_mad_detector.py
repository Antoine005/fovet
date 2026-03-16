"""
Tests for MADDetector — Forge Python counterpart to fovet_mad C99.

Coverage:
    - Config validation
    - Fit: warm-up, threshold calibration, explicit threshold override
    - Score: warm-up zeros, normal vs anomalous samples, multi-feature
    - Predict: labels, threshold boundary
    - Export: fovet_mad_config.h content, mad_config.json
    - Registry: build_detectors() dispatch
    - Pipeline integration: PipelineConfig YAML round-trip
    - Unfitted: RuntimeError on score/predict/export
"""

from __future__ import annotations

import json
import re
import tempfile
from pathlib import Path

import numpy as np
import pytest

from forge.config import DetectorType, MADDetectorConfig, PipelineConfig
from forge.data.base import Dataset
from forge.detectors.mad import MADDetector, _mad_score, _rolling_scores
from forge.detectors.registry import build_detectors


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_dataset(values: list[list[float]], columns: list[str] | None = None) -> Dataset:
    arr = np.array(values, dtype=np.float32)
    cols = columns or [f"f{i}" for i in range(arr.shape[1])]
    return Dataset(samples=arr, columns=cols, labels=None)


def _normal_dataset(n: int = 200, seed: int = 0) -> Dataset:
    rng = np.random.default_rng(seed)
    values = rng.normal(0, 1, size=(n, 1)).tolist()
    return _make_dataset(values, ["value"])


# ---------------------------------------------------------------------------
# 1. Config validation
# ---------------------------------------------------------------------------

class TestMADDetectorConfig:
    def test_defaults(self):
        cfg = MADDetectorConfig(type=DetectorType.mad)
        assert cfg.win_size == 32
        assert cfg.threshold_mad is None
        assert cfg.threshold_percentile == 99.0

    def test_custom(self):
        cfg = MADDetectorConfig(type=DetectorType.mad, win_size=16, threshold_mad=3.5)
        assert cfg.win_size == 16
        assert cfg.threshold_mad == 3.5

    def test_win_size_bounds(self):
        with pytest.raises(Exception):
            MADDetectorConfig(type=DetectorType.mad, win_size=0)
        with pytest.raises(Exception):
            MADDetectorConfig(type=DetectorType.mad, win_size=129)

    def test_win_size_max_128(self):
        cfg = MADDetectorConfig(type=DetectorType.mad, win_size=128)
        assert cfg.win_size == 128


# ---------------------------------------------------------------------------
# 2. _mad_score helper
# ---------------------------------------------------------------------------

class TestMadScoreHelper:
    def test_zero_for_median(self):
        window = np.array([1.0, 2.0, 3.0, 4.0, 5.0])
        assert _mad_score(3.0, window) == pytest.approx(0.0, abs=1e-6)

    def test_positive_for_outlier(self):
        window = np.array([0.0] * 10 + [1.0] * 10, dtype=np.float64)
        score = _mad_score(100.0, window)
        assert score > 10.0

    def test_constant_signal_match(self):
        window = np.full(10, 5.0)
        assert _mad_score(5.0, window) == pytest.approx(0.0, abs=1e-9)

    def test_constant_signal_deviation(self):
        window = np.full(10, 5.0)
        assert _mad_score(5.1, window) == pytest.approx(1e9, rel=0.01)

    def test_consistency_constant(self):
        """1.4826 constant: score ~ z-score for Gaussian data."""
        rng = np.random.default_rng(42)
        window = rng.normal(0, 1, 100)
        # A 3-sigma outlier should score near 3.0
        score = _mad_score(3.0, window)
        assert 1.5 < score < 6.0  # loose bounds for robustness


# ---------------------------------------------------------------------------
# 3. _rolling_scores helper
# ---------------------------------------------------------------------------

class TestRollingScores:
    def test_warmup_zeros(self):
        col = np.ones(50, dtype=np.float64)
        scores = _rolling_scores(col, win_size=10)
        assert np.all(scores[:10] == 0.0)

    def test_length_preserved(self):
        col = np.arange(100, dtype=np.float64)
        scores = _rolling_scores(col, win_size=20)
        assert len(scores) == 100

    def test_seed_extends_warmup(self):
        """With a full seed, scoring starts from sample 0."""
        seed = np.zeros(10)
        col = np.ones(5, dtype=np.float64)
        scores = _rolling_scores(col, win_size=10, seed=seed)
        # seed is all-zero, col[0]=1.0 — should have a non-zero score
        assert scores[0] > 0.0


# ---------------------------------------------------------------------------
# 4. Fit
# ---------------------------------------------------------------------------

class TestMADDetectorFit:
    def test_fit_calibrates_threshold(self):
        cfg = MADDetectorConfig(type=DetectorType.mad, win_size=10)
        det = MADDetector(cfg)
        det.fit(_normal_dataset(200))
        assert det._threshold is not None
        assert det._threshold > 0

    def test_explicit_threshold_used(self):
        cfg = MADDetectorConfig(type=DetectorType.mad, win_size=10, threshold_mad=5.0)
        det = MADDetector(cfg)
        det.fit(_normal_dataset(200))
        assert det._threshold == pytest.approx(5.0)

    def test_seed_window_saved(self):
        cfg = MADDetectorConfig(type=DetectorType.mad, win_size=10)
        det = MADDetector(cfg)
        det.fit(_normal_dataset(200))
        assert det._seed_window is not None
        assert det._seed_window.shape[0] == 10

    def test_columns_saved(self):
        cfg = MADDetectorConfig(type=DetectorType.mad, win_size=10)
        det = MADDetector(cfg)
        det.fit(_make_dataset([[1.0, 2.0]] * 50, ["temp", "hr"]))
        assert det._columns == ["temp", "hr"]

    def test_constant_signal_threshold_fallback(self):
        """Constant signal → auto-threshold falls back to 3.5."""
        cfg = MADDetectorConfig(type=DetectorType.mad, win_size=5)
        det = MADDetector(cfg)
        det.fit(_make_dataset([[1.0]] * 50, ["x"]))
        assert det._threshold == pytest.approx(3.5)


# ---------------------------------------------------------------------------
# 5. Score
# ---------------------------------------------------------------------------

class TestMADDetectorScore:
    def test_score_shape(self):
        cfg = MADDetectorConfig(type=DetectorType.mad, win_size=10)
        det = MADDetector(cfg)
        ds = _normal_dataset(200)
        det.fit(ds)
        test_ds = _normal_dataset(50, seed=1)
        scores = det.score(test_ds)
        assert scores.shape == (50,)
        assert scores.dtype == np.float32

    def test_anomaly_scores_higher(self):
        """Injected spike should score higher than normal samples."""
        rng = np.random.default_rng(42)
        normal = rng.normal(0, 1, (200, 1))
        cfg = MADDetectorConfig(type=DetectorType.mad, win_size=20)
        det = MADDetector(cfg)
        det.fit(_make_dataset(normal.tolist(), ["v"]))

        normal_test = rng.normal(0, 1, (10, 1))
        spike_test = np.array([[50.0]])  # clear anomaly

        score_normal = det.score(_make_dataset(normal_test.tolist(), ["v"])).mean()
        score_spike = det.score(_make_dataset(spike_test.tolist(), ["v"])).mean()
        assert score_spike > score_normal * 5

    def test_unfitted_raises(self):
        cfg = MADDetectorConfig(type=DetectorType.mad)
        det = MADDetector(cfg)
        with pytest.raises(RuntimeError, match="fitted"):
            det.score(_normal_dataset(10))

    def test_multifeature_max(self):
        """Score should be max across features."""
        rng = np.random.default_rng(0)
        train = rng.normal(0, 1, (200, 2)).tolist()
        cfg = MADDetectorConfig(type=DetectorType.mad, win_size=20)
        det = MADDetector(cfg)
        det.fit(_make_dataset(train, ["a", "b"]))

        # Anomaly only in feature "b"
        test_vals = [[0.0, 100.0]]
        scores = det.score(_make_dataset(test_vals, ["a", "b"]))
        assert scores[0] > 5.0


# ---------------------------------------------------------------------------
# 6. Predict
# ---------------------------------------------------------------------------

class TestMADDetectorPredict:
    def test_predict_returns_detection_result(self):
        from forge.detectors.base import DetectionResult
        cfg = MADDetectorConfig(type=DetectorType.mad, win_size=10, threshold_mad=3.5)
        det = MADDetector(cfg)
        det.fit(_normal_dataset(200))
        result = det.predict(_normal_dataset(50, seed=2))
        assert isinstance(result, DetectionResult)
        assert result.detector_name == "mad"
        assert result.threshold == pytest.approx(3.5)

    def test_labels_match_threshold(self):
        cfg = MADDetectorConfig(type=DetectorType.mad, win_size=10, threshold_mad=3.5)
        det = MADDetector(cfg)
        det.fit(_normal_dataset(200))
        test_ds = _normal_dataset(50, seed=3)
        result = det.predict(test_ds)
        scores = det.score(test_ds)
        expected_labels = (scores >= 3.5).astype(np.int8)
        np.testing.assert_array_equal(result.labels, expected_labels)

    def test_spike_detected(self):
        rng = np.random.default_rng(7)
        train = rng.normal(0, 1, (200, 1)).tolist()
        cfg = MADDetectorConfig(type=DetectorType.mad, win_size=20, threshold_mad=3.5)
        det = MADDetector(cfg)
        det.fit(_make_dataset(train, ["v"]))
        # Clear anomaly
        result = det.predict(_make_dataset([[50.0]], ["v"]))
        assert result.labels[0] == 1


# ---------------------------------------------------------------------------
# 7. Export
# ---------------------------------------------------------------------------

class TestMADDetectorExport:
    def _fitted_detector(self, win_size: int = 16) -> MADDetector:
        rng = np.random.default_rng(42)
        train = rng.normal(0, 1, (200, 1)).tolist()
        cfg = MADDetectorConfig(type=DetectorType.mad, win_size=win_size, threshold_mad=3.5)
        det = MADDetector(cfg)
        det.fit(_make_dataset(train, ["value"]))
        return det

    def test_export_creates_files(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            det = self._fitted_detector()
            paths = det.export(Path(tmpdir), stem="test_pipeline")
            names = {p.name for p in paths}
            assert "fovet_mad_config.h" in names
            assert "mad_config.json" in names

    def test_c_header_guard(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            det = self._fitted_detector()
            det.export(Path(tmpdir), stem="test_pipeline")
            header = (Path(tmpdir) / "fovet_mad_config.h").read_text()
            assert "#ifndef FOVET_MAD_CONFIG_H" in header
            assert "#define FOVET_MAD_CONFIG_H" in header
            assert "#endif /* FOVET_MAD_CONFIG_H */" in header

    def test_c_header_includes_mad_h(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            det = self._fitted_detector()
            det.export(Path(tmpdir), stem="p")
            header = (Path(tmpdir) / "fovet_mad_config.h").read_text()
            assert '#include "fovet/mad.h"' in header

    def test_c_header_struct_threshold(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            det = self._fitted_detector()
            det.export(Path(tmpdir), stem="p")
            header = (Path(tmpdir) / "fovet_mad_config.h").read_text()
            assert "fovet_mad_value" in header
            assert ".threshold_mad = 3.500000f" in header

    def test_c_header_window_size_128(self):
        """Window array must always have 128 entries (FOVET_MAD_MAX_WINDOW)."""
        with tempfile.TemporaryDirectory() as tmpdir:
            det = self._fitted_detector(win_size=16)
            det.export(Path(tmpdir), stem="p")
            header = (Path(tmpdir) / "fovet_mad_config.h").read_text()
            # Count the float literal entries (ending in 'f') in .window = {...}
            m = re.search(r"\.window\s*=\s*\{([^}]+)\}", header, re.DOTALL)
            assert m is not None
            entries = [e.strip() for e in m.group(1).split(",") if e.strip()]
            assert len(entries) == 128

    def test_json_config_content(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            det = self._fitted_detector(win_size=16)
            det.export(Path(tmpdir), stem="my_pipeline")
            data = json.loads((Path(tmpdir) / "mad_config.json").read_text())
            assert data["detector"] == "mad"
            assert data["win_size"] == 16
            assert data["threshold_mad"] == pytest.approx(3.5)
            assert data["pipeline"] == "my_pipeline"
            assert data["features"] == ["value"]

    def test_unfitted_export_raises(self):
        cfg = MADDetectorConfig(type=DetectorType.mad)
        det = MADDetector(cfg)
        with tempfile.TemporaryDirectory() as tmpdir:
            with pytest.raises(RuntimeError, match="fitted"):
                det.export(Path(tmpdir), stem="x")

    def test_multifeature_export(self):
        """Multi-feature dataset should produce one struct per column."""
        rng = np.random.default_rng(5)
        train = rng.normal(0, 1, (200, 2)).tolist()
        cfg = MADDetectorConfig(type=DetectorType.mad, win_size=10, threshold_mad=3.5)
        det = MADDetector(cfg)
        det.fit(_make_dataset(train, ["temp", "hr"]))
        with tempfile.TemporaryDirectory() as tmpdir:
            det.export(Path(tmpdir), stem="p")
            header = (Path(tmpdir) / "fovet_mad_config.h").read_text()
            assert "fovet_mad_temp" in header
            assert "fovet_mad_hr" in header


# ---------------------------------------------------------------------------
# 8. Registry
# ---------------------------------------------------------------------------

class TestRegistry:
    def test_build_mad_detector(self):
        cfg = MADDetectorConfig(type=DetectorType.mad)
        detectors = build_detectors([cfg])
        assert len(detectors) == 1
        assert isinstance(detectors[0], MADDetector)


# ---------------------------------------------------------------------------
# 9. PipelineConfig YAML round-trip
# ---------------------------------------------------------------------------

class TestPipelineConfigRoundTrip:
    def test_yaml_with_mad(self, tmp_path):
        yaml_content = """\
name: test_mad_pipeline
data:
  source: synthetic
  signal: sine
  n_samples: 500
  columns: [value]
detectors:
  - type: mad
    win_size: 32
    threshold_percentile: 99.0
"""
        p = tmp_path / "config.yaml"
        p.write_text(yaml_content, encoding="utf-8")
        config = PipelineConfig.from_yaml(p)
        assert config.detectors[0].type == DetectorType.mad
        assert config.detectors[0].win_size == 32
