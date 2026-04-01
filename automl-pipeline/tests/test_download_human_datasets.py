"""
Tests for forge.datasets.download_human_datasets

All tests run offline (no network, no real dataset files).
  - inject_anomaly is fully self-contained — tested exhaustively.
  - quality_report is tested with synthetic DataFrames.
  - Parsers are tested with minimal synthetic CSV/pickle data.
  - CLI is tested via _build_parser() + main().
"""

import json
import pickle
import tempfile
from io import StringIO
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from forge.datasets.download_human_datasets import (
    DATASETS,
    DatasetManifest,
    DatasetQualityReport,
    _DEFAULT_OUTPUT,
    _make_standard_df,
    inject_anomaly,
    load_parsed,
    main,
    parse_and_save,
    parse_kfall,
    parse_upfall,
    parse_wesad,
    quality_report,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

RNG = np.random.default_rng(42)

def _sine_signal(n: int = 200, amplitude: float = 1.0) -> np.ndarray:
    t = np.linspace(0, 4 * np.pi, n)
    return amplitude * np.sin(t)


def _make_binary_df(n: int = 100) -> pd.DataFrame:
    """Standard Fovet CSV DataFrame with binary labels."""
    ts = np.arange(n, dtype=np.int64) * 10
    vals = np.column_stack([np.ones(n), np.zeros(n), np.zeros(n)])
    labels = np.zeros(n, dtype=np.int32)
    labels[n // 2 :] = 1
    return _make_standard_df(ts, "imu", vals, labels)


# ---------------------------------------------------------------------------
# DatasetManifest
# ---------------------------------------------------------------------------

class TestDatasetManifest:
    def test_registry_has_four_datasets(self):
        assert set(DATASETS) == {"up_fall", "kfall", "wesad", "drozy"}

    def test_wesad_is_not_optional(self):
        assert DATASETS["wesad"].optional is False

    def test_drozy_is_optional(self):
        assert DATASETS["drozy"].optional is True

    def test_is_available_false_when_dir_missing(self, tmp_path):
        m = DATASETS["up_fall"]
        assert m.is_available(tmp_path / "nonexistent") is False

    def test_is_available_true_when_dir_has_files(self, tmp_path):
        d = tmp_path / "up_fall"
        d.mkdir()
        (d / "data.csv").write_text("a,b\n1,2\n")
        assert DATASETS["up_fall"].is_available(d) is True

    def test_verify_sha256_empty_manifest_returns_empty(self, tmp_path):
        m = DATASETS["up_fall"]  # expected_sha256 == {}
        assert m.verify_sha256(tmp_path) == {}


# ---------------------------------------------------------------------------
# _make_standard_df
# ---------------------------------------------------------------------------

class TestMakeStandardDf:
    def test_shape_1d(self):
        ts = np.arange(10, dtype=np.int64)
        vals = np.ones(10)
        df = _make_standard_df(ts, "imu", vals, np.zeros(10, np.int32))
        assert df.shape == (10, 6)

    def test_shape_3d(self):
        ts = np.arange(10, dtype=np.int64)
        vals = np.ones((10, 3))
        df = _make_standard_df(ts, "hr", vals, np.zeros(10, np.int32))
        assert list(df.columns) == ["timestamp_ms", "sensor_type", "value_1", "value_2", "value_3", "label"]

    def test_sensor_type_propagated(self):
        ts = np.arange(5, dtype=np.int64)
        vals = np.zeros(5)
        df = _make_standard_df(ts, "ecg", vals, np.zeros(5, np.int32))
        assert (df["sensor_type"] == "ecg").all()


# ---------------------------------------------------------------------------
# quality_report
# ---------------------------------------------------------------------------

class TestQualityReport:
    def test_n_samples(self):
        df = _make_binary_df(80)
        r = quality_report(df, "test")
        assert r.n_samples == 80

    def test_n_features(self):
        df = _make_binary_df(50)
        r = quality_report(df, "test")
        # value_1, value_2, value_3
        assert r.n_features == 3

    def test_class_counts_binary(self):
        df = _make_binary_df(100)
        r = quality_report(df, "test")
        assert r.class_counts["0"] == 50
        assert r.class_counts["1"] == 50

    def test_anomaly_ratio(self):
        df = _make_binary_df(100)
        r = quality_report(df, "test")
        assert pytest.approx(r.anomaly_ratio, abs=0.01) == 0.5

    def test_no_label_column_warns(self):
        df = pd.DataFrame({"value_1": [1.0, 2.0]})
        r = quality_report(df, "nolabel")
        assert any("No label" in w for w in r.warnings)

    def test_as_dict_has_expected_keys(self):
        r = quality_report(_make_binary_df(), "test")
        d = r.as_dict()
        assert "n_samples" in d
        assert "class_counts" in d
        assert "anomaly_ratio" in d

    def test_str_contains_dataset_name(self):
        r = quality_report(_make_binary_df(), "my_ds")
        assert "my_ds" in str(r)

    def test_duplicate_rows_warned(self):
        df = pd.concat([_make_binary_df(10), _make_binary_df(10)], ignore_index=True)
        r = quality_report(df, "dup")
        assert any("duplicate" in w.lower() for w in r.warnings)


# ---------------------------------------------------------------------------
# inject_anomaly
# ---------------------------------------------------------------------------

class TestInjectAnomaly:
    sig = _sine_signal(300)

    def test_returns_copy(self):
        out = inject_anomaly(self.sig, "spike", 1.0, rng=RNG)
        assert out is not self.sig

    def test_same_length(self):
        for atype in ["spike", "flatline", "drift", "fall_impact"]:
            out = inject_anomaly(self.sig, atype, 1.0, rng=RNG)
            assert len(out) == len(self.sig), f"failed for {atype}"

    def test_spike_changes_signal(self):
        out = inject_anomaly(self.sig, "spike", 3.0, start=50, rng=RNG)
        assert not np.allclose(out, self.sig)

    def test_spike_intensity_zero_no_change(self):
        out = inject_anomaly(self.sig, "spike", 0.0, start=50, rng=RNG)
        # With intensity=0, spike amplitude = 0*sigma*5 = 0 → identical
        assert np.allclose(out, self.sig)

    def test_flatline_segment_is_constant(self):
        out = inject_anomaly(self.sig, "flatline", 1.0, start=100, length=20, rng=RNG)
        segment = out[100:120]
        assert np.allclose(segment, segment[0])

    def test_drift_is_monotone(self):
        flat = np.zeros(200)
        out = inject_anomaly(flat, "drift", 1.0, start=0, length=200, rng=RNG)
        diffs = np.diff(out[:200])
        assert np.all(diffs >= 0)

    def test_fall_impact_peak_in_middle(self):
        out = inject_anomaly(self.sig, "fall_impact", 5.0, start=50, length=80, rng=RNG)
        # Impact region should have higher values than post-fall stillness
        impact_region = out[50 + 20 : 50 + 30]
        still_region  = out[50 + 60 : 50 + 80]
        assert np.max(np.abs(impact_region)) > np.max(np.abs(still_region))

    def test_unknown_type_raises(self):
        with pytest.raises(ValueError, match="Unknown anomaly_type"):
            inject_anomaly(self.sig, "unknown", 1.0)  # type: ignore[arg-type]

    def test_non_1d_raises(self):
        arr2d = np.ones((10, 3))
        with pytest.raises(ValueError, match="1-D"):
            inject_anomaly(arr2d, "spike", 1.0)  # type: ignore[arg-type]

    def test_too_short_raises(self):
        with pytest.raises(ValueError, match="too short"):
            inject_anomaly(np.array([1.0, 2.0]), "spike", 1.0)

    def test_reproducible_with_seed(self):
        rng1 = np.random.default_rng(0)
        rng2 = np.random.default_rng(0)
        out1 = inject_anomaly(self.sig, "spike", 2.0, rng=rng1)
        out2 = inject_anomaly(self.sig, "spike", 2.0, rng=rng2)
        assert np.allclose(out1, out2)

    def test_start_clipped_to_valid_range(self):
        """start=-999 should be clipped to 0 without raising."""
        out = inject_anomaly(self.sig, "flatline", 1.0, start=-999, length=5, rng=RNG)
        assert len(out) == len(self.sig)

    def test_all_types_run(self):
        for atype in ["spike", "flatline", "drift", "fall_impact"]:
            out = inject_anomaly(self.sig, atype, 1.0, rng=np.random.default_rng(1))
            assert out.shape == self.sig.shape


# ---------------------------------------------------------------------------
# Parsers — offline with synthetic data
# ---------------------------------------------------------------------------

def _write_upfall_csv(path: Path) -> None:
    """Write a minimal UP-Fall-style CSV."""
    path.parent.mkdir(parents=True, exist_ok=True)
    df = pd.DataFrame({
        "time":       np.linspace(0, 10, 50),
        "acc_x":      np.random.randn(50),
        "acc_y":      np.random.randn(50),
        "acc_z":      np.random.randn(50) + 9.8,
        "activity_id": [0] * 40 + [1] * 10,
    })
    df.to_csv(path, index=False)


def _write_kfall_csv(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    df = pd.DataFrame({
        "Timestamp(ms)": np.arange(50) * 10,
        "Acc_X":         np.random.randn(50),
        "Acc_Y":         np.random.randn(50),
        "Acc_Z":         np.random.randn(50),
        "Label":         [0] * 45 + [1] * 5,
    })
    df.to_csv(path, index=False)


def _write_wesad_pkl(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    n_chest = 700 * 1   # simplified
    n_wrist_acc = 32 * 10  # 32 Hz, 10 s
    n_wrist_bvp = 64 * 10  # 64 Hz, 10 s
    data = {
        "signal": {
            "wrist": {
                "ACC": np.random.randn(n_wrist_acc, 3).astype(np.float32),
                "BVP": np.random.randn(n_wrist_bvp, 1).astype(np.float32),
            },
        },
        "label": np.array([1] * (n_chest // 2) + [2] * (n_chest // 2), dtype=np.int32),
    }
    with open(path, "wb") as f:
        pickle.dump(data, f)


class TestParseUpfall:
    def test_returns_dataframe(self, tmp_path):
        _write_upfall_csv(tmp_path / "data.csv")
        df = parse_upfall(tmp_path)
        assert isinstance(df, pd.DataFrame)
        assert len(df) == 50

    def test_has_standard_columns(self, tmp_path):
        _write_upfall_csv(tmp_path / "data.csv")
        df = parse_upfall(tmp_path)
        for col in ["timestamp_ms", "sensor_type", "value_1", "label"]:
            assert col in df.columns

    def test_sensor_type_is_imu(self, tmp_path):
        _write_upfall_csv(tmp_path / "data.csv")
        df = parse_upfall(tmp_path)
        assert (df["sensor_type"] == "imu").all()

    def test_no_csv_raises(self, tmp_path):
        with pytest.raises(FileNotFoundError):
            parse_upfall(tmp_path)


class TestParseKfall:
    def test_returns_dataframe(self, tmp_path):
        _write_kfall_csv(tmp_path / "s1.csv")
        df = parse_kfall(tmp_path)
        assert isinstance(df, pd.DataFrame)
        assert len(df) == 50

    def test_label_column_preserved(self, tmp_path):
        _write_kfall_csv(tmp_path / "s1.csv")
        df = parse_kfall(tmp_path)
        assert df["label"].max() == 1

    def test_no_csv_raises(self, tmp_path):
        with pytest.raises(FileNotFoundError):
            parse_kfall(tmp_path)


class TestParseWesad:
    def test_returns_dataframe(self, tmp_path):
        _write_wesad_pkl(tmp_path / "S2" / "S2.pkl")
        df = parse_wesad(tmp_path)
        assert isinstance(df, pd.DataFrame)
        assert len(df) > 0

    def test_has_imu_and_hr_rows(self, tmp_path):
        _write_wesad_pkl(tmp_path / "S2" / "S2.pkl")
        df = parse_wesad(tmp_path)
        assert "imu" in df["sensor_type"].values
        assert "hr" in df["sensor_type"].values

    def test_no_pkl_raises(self, tmp_path):
        with pytest.raises(FileNotFoundError):
            parse_wesad(tmp_path)


# ---------------------------------------------------------------------------
# parse_and_save
# ---------------------------------------------------------------------------

class TestParseAndSave:
    def test_saves_csv(self, tmp_path):
        raw_dir = tmp_path / "raw"
        _write_upfall_csv(raw_dir / "data.csv")
        out_dir = tmp_path / "out"
        parse_and_save("up_fall", raw_dir, out_dir)
        assert (out_dir / "up_fall" / "up_fall.csv").exists()

    def test_saves_quality_json(self, tmp_path):
        raw_dir = tmp_path / "raw"
        _write_upfall_csv(raw_dir / "data.csv")
        out_dir = tmp_path / "out"
        parse_and_save("up_fall", raw_dir, out_dir)
        j = json.loads((out_dir / "up_fall" / "up_fall_quality.json").read_text())
        assert "n_samples" in j

    def test_saves_readme(self, tmp_path):
        raw_dir = tmp_path / "raw"
        _write_upfall_csv(raw_dir / "data.csv")
        out_dir = tmp_path / "out"
        parse_and_save("up_fall", raw_dir, out_dir)
        readme = (out_dir / "up_fall" / "README.md").read_text()
        assert "up_fall" in readme.lower()

    def test_unknown_dataset_raises_key_error(self, tmp_path):
        with pytest.raises(KeyError):
            parse_and_save("nonexistent", tmp_path, tmp_path)

    def test_drozy_not_implemented(self, tmp_path):
        with pytest.raises(NotImplementedError):
            parse_and_save("drozy", tmp_path, tmp_path)


# ---------------------------------------------------------------------------
# load_parsed
# ---------------------------------------------------------------------------

class TestLoadParsed:
    def test_loads_saved_csv(self, tmp_path):
        raw_dir = tmp_path / "raw"
        _write_upfall_csv(raw_dir / "data.csv")
        out_dir = tmp_path / "out"
        parse_and_save("up_fall", raw_dir, out_dir)
        df = load_parsed(out_dir, "up_fall")
        assert len(df) == 50

    def test_missing_csv_raises(self, tmp_path):
        with pytest.raises(FileNotFoundError):
            load_parsed(tmp_path, "up_fall")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

class TestCLI:
    def test_list_runs(self, capsys):
        main(["list"])
        out = capsys.readouterr().out
        assert "up_fall" in out
        assert "wesad" in out

    def test_info_up_fall(self, capsys):
        main(["info", "up_fall"])
        out = capsys.readouterr().out
        assert "UP-Fall" in out or "up_fall" in out

    def test_info_wesad_shows_url(self, capsys):
        main(["info", "wesad"])
        out = capsys.readouterr().out
        assert "ubicomp" in out or "WESAD" in out

    def test_parse_cli_creates_output(self, tmp_path, capsys):
        raw_dir = tmp_path / "raw"
        _write_upfall_csv(raw_dir / "data.csv")
        out_dir = tmp_path / "out"
        main(["parse", "up_fall", "--raw-dir", str(raw_dir), "--output-dir", str(out_dir)])
        assert (out_dir / "up_fall" / "up_fall.csv").exists()

    def test_inject_cli_creates_output(self, tmp_path):
        sig = _sine_signal(100)
        in_path = tmp_path / "signal.npy"
        np.save(in_path, sig)
        out_path = tmp_path / "out.npy"
        main(["inject", "--input", str(in_path), "--type", "spike",
              "--intensity", "2.0", "--output", str(out_path), "--seed", "0"])
        assert out_path.exists()
        result = np.load(out_path)
        assert result.shape == sig.shape
        assert not np.allclose(result, sig)
