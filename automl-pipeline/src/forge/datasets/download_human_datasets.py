"""
Fovet SDK — Sentinelle
Copyright (C) 2026 Antoine Porte. All rights reserved.
LGPL v3 for non-commercial use.
Commercial licensing: contact@fovet.eu

-------------------------------------------------------------------------
download_human_datasets.py — Biosignal dataset manager for Fovet Forge

Handles:
  - UP-Fall Detection (accelerometer, fall detection)
  - KFall (accelerometer, fall detection — fallback)
  - WESAD (wrist/chest HR + ACC + TEMP, stress/fatigue)
  - DROZY (optional: drowsiness)

All datasets are parsed into a standard Fovet CSV format:
  timestamp_ms, sensor_type, value_1, value_2, value_3, label

Since most datasets require manual registration/download, this module:
  1. Checks for already-downloaded raw files (SHA256 cache)
  2. Provides download instructions when files are missing
  3. Parses available files into standard format
  4. Generates quality reports (sample counts, class ratios, basic stats)
  5. Exports to <output_dir>/human/<dataset_name>/

Standalone synthetic utility (no raw data required):
  inject_anomaly(series, anomaly_type, intensity) → np.ndarray

Usage:
  uv run python -m forge.datasets.download_human_datasets list
  uv run python -m forge.datasets.download_human_datasets info up_fall
  uv run python -m forge.datasets.download_human_datasets parse wesad \\
      --raw-dir /data/WESAD --output-dir datasets/human
  uv run python -m forge.datasets.download_human_datasets inject \\
      --input signal.npy --type spike --intensity 0.5
-------------------------------------------------------------------------
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import sys
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Literal

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Standard output directory (relative to repo root)
# ---------------------------------------------------------------------------
_DEFAULT_OUTPUT = Path(__file__).parents[4] / "datasets" / "human"

# ---------------------------------------------------------------------------
# Dataset manifest
# ---------------------------------------------------------------------------

@dataclass
class DatasetManifest:
    """Metadata for a biosignal dataset."""

    name: str
    description: str
    sensor_types: list[str]
    download_url: str
    download_notes: str
    expected_sha256: dict[str, str]   # filename → sha256 hex; empty = not enforced
    license: str
    format: str                        # "csv" | "pickle" | "mat"
    label_map: dict[int, str]          # {0: "normal", 1: "fall", ...}
    optional: bool = False

    def is_available(self, raw_dir: Path) -> bool:
        """Return True if at least one expected file is present."""
        if not raw_dir.is_dir():
            return False
        return any(raw_dir.rglob("*"))

    def verify_sha256(self, raw_dir: Path) -> dict[str, bool]:
        """Verify SHA256 of each listed file.  Returns {filename: ok}."""
        results: dict[str, bool] = {}
        for fname, expected in self.expected_sha256.items():
            path = raw_dir / fname
            if not path.exists():
                results[fname] = False
                continue
            sha = hashlib.sha256(path.read_bytes()).hexdigest()
            results[fname] = sha == expected
        return results


# ---------------------------------------------------------------------------
# Dataset registry
# ---------------------------------------------------------------------------

DATASETS: dict[str, DatasetManifest] = {
    "up_fall": DatasetManifest(
        name="up_fall",
        description="UP-Fall Detection Dataset — accelerometer + gyroscope + barometer, "
                    "17 subjects, 11 activities (5 fall types, 6 ADLs)",
        sensor_types=["imu"],
        download_url="https://sites.google.com/up.edu.mx/har-up/",
        download_notes=(
            "1. Open the URL above and fill the access form.\n"
            "2. Download all CSV files into <raw_dir>/up_fall/.\n"
            "   File pattern: CompleteDataSet.csv (single file) or per-subject CSVs.\n"
            "3. Run: forge datasets parse up_fall --raw-dir <raw_dir>/up_fall"
        ),
        expected_sha256={},  # varies by download mirror
        license="CC BY 4.0",
        format="csv",
        label_map={
            0: "normal",
            1: "fall_forward",
            2: "fall_backward",
            3: "fall_left",
            4: "fall_right",
            5: "fall_sitting_chair",
            6: "walking",
            7: "standing",
            8: "sitting",
            9: "picking_up",
            10: "jumping",
            11: "laying",
        },
    ),
    "kfall": DatasetManifest(
        name="kfall",
        description="KFall Dataset — wrist/waist/ankle IMU, 38 subjects, 20 fall + 10 ADL",
        sensor_types=["imu"],
        download_url="https://github.com/Sensors-Journal/KFall",
        download_notes=(
            "1. Clone or download the repository.\n"
            "2. Place all CSV files (per subject) into <raw_dir>/kfall/.\n"
            "3. Run: forge datasets parse kfall --raw-dir <raw_dir>/kfall"
        ),
        expected_sha256={},
        license="MIT",
        format="csv",
        label_map={0: "normal", 1: "fall"},
    ),
    "wesad": DatasetManifest(
        name="wesad",
        description="WESAD — Wrist and Chest multimodal (ACC + BVP + EDA + TEMP + RESP), "
                    "15 subjects, 3 conditions (baseline=1, stress=2, amusement=3)",
        sensor_types=["hr", "imu", "temp"],
        download_url="https://ubicomp.ifi.lmu.de/pub/datasets/WESAD/",
        download_notes=(
            "1. Request access via the URL above (academic licence).\n"
            "2. Download WESAD.zip and extract into <raw_dir>/wesad/.\n"
            "   Expected structure: <raw_dir>/wesad/S2/S2.pkl, etc.\n"
            "3. Run: forge datasets parse wesad --raw-dir <raw_dir>/wesad"
        ),
        expected_sha256={},
        license="CC BY-NC 4.0 (academic use)",
        format="pickle",
        label_map={0: "undefined", 1: "baseline", 2: "stress", 3: "amusement", 4: "meditation"},
    ),
    "drozy": DatasetManifest(
        name="drozy",
        description="DROZY — Driver drowsiness: EEG + Eog + ECG, 14 subjects (optional)",
        sensor_types=["ecg"],
        download_url="http://www.drozy.ulg.ac.be/",
        download_notes=(
            "1. Request access from the lab (drozy.ulg.ac.be).\n"
            "2. Place .mat files into <raw_dir>/drozy/.\n"
            "3. Run: forge datasets parse drozy --raw-dir <raw_dir>/drozy"
        ),
        expected_sha256={},
        license="Academic use only",
        format="mat",
        label_map={0: "alert", 1: "drowsy"},
        optional=True,
    ),
}

# ---------------------------------------------------------------------------
# Quality report
# ---------------------------------------------------------------------------

@dataclass
class DatasetQualityReport:
    dataset_name: str
    n_samples: int
    n_features: int
    class_counts: dict[str, int]
    class_ratios: dict[str, float]
    feature_stats: dict[str, dict[str, float]]  # col → {mean, std, min, max}
    anomaly_ratio: float
    warnings: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return asdict(self)

    def __str__(self) -> str:
        lines = [
            f"Dataset          : {self.dataset_name}",
            f"Samples          : {self.n_samples:,}",
            f"Features         : {self.n_features}",
            f"Anomaly ratio    : {self.anomaly_ratio:.1%}",
            "Class distribution:",
        ]
        for cls, cnt in self.class_counts.items():
            lines.append(f"  {cls:<20} {cnt:>8,}  ({self.class_ratios[cls]:.1%})")
        if self.warnings:
            lines.append("Warnings:")
            for w in self.warnings:
                lines.append(f"  ⚠ {w}")
        return "\n".join(lines)


def quality_report(df: pd.DataFrame, dataset_name: str = "unknown") -> DatasetQualityReport:
    """Compute quality report from a parsed Fovet-format DataFrame."""
    warnings: list[str] = []

    label_col = "label" if "label" in df.columns else None
    feature_cols = [c for c in df.columns if c not in ("timestamp_ms", "sensor_type", "label")]

    class_counts: dict[str, int] = {}
    class_ratios: dict[str, float] = {}
    anomaly_ratio = 0.0

    if label_col and df[label_col].nunique() > 0:
        vc = df[label_col].value_counts()
        total = len(df)
        for k, v in vc.items():
            class_counts[str(k)] = int(v)
            class_ratios[str(k)] = v / total
        # anomaly = any label != 0 / "normal"
        normal_keys = {"0", "normal", "baseline", "alert"}
        anomaly_n = sum(v for k, v in class_counts.items() if k.lower() not in normal_keys)
        anomaly_ratio = anomaly_n / total if total else 0.0
    else:
        warnings.append("No label column found — anomaly ratio undetermined")

    feature_stats: dict[str, dict[str, float]] = {}
    for col in feature_cols:
        if pd.api.types.is_numeric_dtype(df[col]):
            s = df[col].dropna()
            feature_stats[col] = {
                "mean": float(s.mean()),
                "std":  float(s.std()),
                "min":  float(s.min()),
                "max":  float(s.max()),
            }
            if s.isna().sum() > 0:
                warnings.append(f"Column '{col}' has {s.isna().sum()} NaN values")

    n_dup = df.duplicated().sum()
    if n_dup > 0:
        warnings.append(f"{n_dup} duplicate rows detected")

    return DatasetQualityReport(
        dataset_name=dataset_name,
        n_samples=len(df),
        n_features=len(feature_cols),
        class_counts=class_counts,
        class_ratios=class_ratios,
        feature_stats=feature_stats,
        anomaly_ratio=anomaly_ratio,
        warnings=warnings,
    )


# ---------------------------------------------------------------------------
# Standard CSV schema
# timestamp_ms, sensor_type, value_1, value_2, value_3, label
# ---------------------------------------------------------------------------

_STANDARD_COLUMNS = ["timestamp_ms", "sensor_type", "value_1", "value_2", "value_3", "label"]


def _make_standard_df(
    timestamps_ms: np.ndarray,
    sensor_type: str,
    values: np.ndarray,          # shape (N,) or (N, M) — up to 3 columns
    labels: np.ndarray,
) -> pd.DataFrame:
    """Build a standard Fovet CSV DataFrame."""
    n = len(timestamps_ms)
    if values.ndim == 1:
        values = values.reshape(n, 1)
    # Pad to 3 value columns
    ncols = values.shape[1]
    padded = np.zeros((n, 3), dtype=float)
    padded[:, :min(ncols, 3)] = values[:, :3]

    return pd.DataFrame({
        "timestamp_ms": timestamps_ms.astype(np.int64),
        "sensor_type":  sensor_type,
        "value_1":      padded[:, 0],
        "value_2":      padded[:, 1],
        "value_3":      padded[:, 2],
        "label":        labels.astype(np.int32),
    })


# ---------------------------------------------------------------------------
# Parsers — one per dataset
# ---------------------------------------------------------------------------

def parse_upfall(raw_dir: Path) -> pd.DataFrame:
    """Parse UP-Fall Detection dataset.

    Expects one of:
    - A single CompleteDataSet.csv with columns:
        SubjectID, ActivityID, Trial, time, acc_x, acc_y, acc_z, ...
    - OR per-subject CSV files with the same column structure.

    Returns a standard Fovet CSV DataFrame.
    Raises FileNotFoundError if no suitable file is found.
    """
    csv_files = sorted(raw_dir.rglob("*.csv"))
    if not csv_files:
        raise FileNotFoundError(
            f"No CSV files found in {raw_dir}.\n"
            f"{DATASETS['up_fall'].download_notes}"
        )

    frames: list[pd.DataFrame] = []
    for f in csv_files:
        try:
            raw = pd.read_csv(f, low_memory=False)
        except Exception as exc:
            logger.warning("Skipping %s: %s", f, exc)
            continue

        # Normalize column names
        raw.columns = [c.strip().lower().replace(" ", "_") for c in raw.columns]

        # Detect time column
        time_col = next((c for c in raw.columns if "time" in c), None)
        # Detect acceleration columns
        acc_x = next((c for c in raw.columns if "acc_x" in c or "x_acc" in c), None)
        acc_y = next((c for c in raw.columns if "acc_y" in c or "y_acc" in c), None)
        acc_z = next((c for c in raw.columns if "acc_z" in c or "z_acc" in c), None)
        # Detect label column
        label_col = next(
            (c for c in raw.columns if "activity" in c or "label" in c or "class" in c),
            None,
        )

        if not all([time_col, acc_x, acc_y, acc_z]):
            logger.warning("Skipping %s: cannot identify time/acc columns", f)
            continue

        n = len(raw)
        # Convert time to ms if needed (assume seconds if values < 1e6)
        times = raw[time_col].to_numpy(dtype=float)
        if times.max() < 1e6:
            times = (times * 1000).astype(np.int64)

        labels = raw[label_col].to_numpy(dtype=np.int32) if label_col else np.zeros(n, dtype=np.int32)
        # Binarize: 0=normal(ADL), 1=fall
        binary_labels = np.where(labels <= 5, labels, 0).astype(np.int32)

        values = np.column_stack([
            raw[acc_x].to_numpy(dtype=float),
            raw[acc_y].to_numpy(dtype=float),
            raw[acc_z].to_numpy(dtype=float),
        ])
        frames.append(_make_standard_df(times, "imu", values, binary_labels))

    if not frames:
        raise ValueError(f"No parseable CSV files found in {raw_dir}")

    return pd.concat(frames, ignore_index=True)


def parse_kfall(raw_dir: Path) -> pd.DataFrame:
    """Parse KFall dataset.

    Expects per-task CSV files with columns:
    TimeStamp(ms), Acc_X, Acc_Y, Acc_Z, Gyr_X, Gyr_Y, Gyr_Z, Label

    Returns a standard Fovet CSV DataFrame.
    """
    csv_files = sorted(raw_dir.rglob("*.csv"))
    if not csv_files:
        raise FileNotFoundError(
            f"No CSV files found in {raw_dir}.\n"
            f"{DATASETS['kfall'].download_notes}"
        )

    frames: list[pd.DataFrame] = []
    for f in csv_files:
        try:
            raw = pd.read_csv(f, low_memory=False)
        except Exception as exc:
            logger.warning("Skipping %s: %s", f, exc)
            continue

        raw.columns = [c.strip().lower().replace(" ", "_").replace("(ms)", "") for c in raw.columns]

        time_col  = next((c for c in raw.columns if "timestamp" in c or "time" in c), None)
        acc_x_col = next((c for c in raw.columns if c.startswith("acc_x")), None)
        acc_y_col = next((c for c in raw.columns if c.startswith("acc_y")), None)
        acc_z_col = next((c for c in raw.columns if c.startswith("acc_z")), None)
        label_col = next((c for c in raw.columns if "label" in c or "activity" in c), None)

        if not all([time_col, acc_x_col, acc_y_col, acc_z_col]):
            logger.warning("Skipping %s: cannot identify required columns", f)
            continue

        times  = raw[time_col].to_numpy(dtype=np.int64)
        labels = raw[label_col].to_numpy(dtype=np.int32) if label_col else np.zeros(len(raw), np.int32)
        values = np.column_stack([
            raw[acc_x_col].to_numpy(dtype=float),
            raw[acc_y_col].to_numpy(dtype=float),
            raw[acc_z_col].to_numpy(dtype=float),
        ])
        frames.append(_make_standard_df(times, "imu", values, labels))

    if not frames:
        raise ValueError(f"No parseable CSV files found in {raw_dir}")

    return pd.concat(frames, ignore_index=True)


def parse_wesad(raw_dir: Path) -> pd.DataFrame:
    """Parse WESAD dataset (pickle format).

    Expects per-subject directories: <raw_dir>/S<N>/S<N>.pkl
    Each pickle contains dict with keys 'signal' → 'wrist' → 'ACC', 'BVP', 'TEMP'
    and 'label' with per-sample labels (64 Hz for labels, 64 Hz for wrist).

    Returns a standard Fovet CSV DataFrame using wrist ACC (sensor_type='imu')
    and BVP (sensor_type='hr').
    Raises FileNotFoundError if no suitable pickle files are found.
    """
    import pickle

    pkl_files = sorted(raw_dir.rglob("S*.pkl"))
    if not pkl_files:
        raise FileNotFoundError(
            f"No WESAD pickle files found in {raw_dir}.\n"
            f"{DATASETS['wesad'].download_notes}"
        )

    fs_wrist = 64  # Hz — wrist sensor sampling rate in WESAD

    frames: list[pd.DataFrame] = []
    for pkl_path in pkl_files:
        try:
            with open(pkl_path, "rb") as fh:
                data = pickle.load(fh, encoding="latin1")
        except Exception as exc:
            logger.warning("Skipping %s: %s", pkl_path, exc)
            continue

        try:
            wrist  = data["signal"]["wrist"]
            labels = data["label"]          # shape (N_chest,) at higher rate
        except (KeyError, TypeError) as exc:
            logger.warning("Skipping %s: unexpected structure — %s", pkl_path, exc)
            continue

        # Wrist ACC: shape (N_wrist, 3) — 32 Hz in WESAD wrist
        acc = wrist.get("ACC")   # g units, 3-axis
        bvp = wrist.get("BVP")   # Blood Volume Pulse (64 Hz)

        n_labels = len(labels)

        # Align wrist ACC to label length (resample if needed)
        if acc is not None:
            n_acc = len(acc)
            # Resample label to acc length
            indices = np.linspace(0, n_labels - 1, n_acc).astype(int)
            acc_labels = labels[indices].astype(np.int32)
            ts_ms = (np.arange(n_acc) * 1000.0 / 32).astype(np.int64)
            frames.append(_make_standard_df(ts_ms, "imu", acc.astype(float), acc_labels))

        if bvp is not None:
            n_bvp = len(bvp)
            indices = np.linspace(0, n_labels - 1, n_bvp).astype(int)
            bvp_labels = labels[indices].astype(np.int32)
            ts_ms = (np.arange(n_bvp) * 1000.0 / fs_wrist).astype(np.int64)
            bvp_vals = bvp.ravel().astype(float)
            frames.append(_make_standard_df(ts_ms, "hr", bvp_vals, bvp_labels))

    if not frames:
        raise ValueError(f"No parseable pickle files found in {raw_dir}")

    return pd.concat(frames, ignore_index=True)


# ---------------------------------------------------------------------------
# Load parsed CSV
# ---------------------------------------------------------------------------

def load_parsed(output_dir: Path, dataset_name: str) -> pd.DataFrame:
    """Load a previously parsed Fovet CSV.

    Args:
        output_dir: Base output directory (e.g. datasets/human).
        dataset_name: Dataset key (e.g. "wesad").

    Returns:
        DataFrame in standard Fovet format.

    Raises:
        FileNotFoundError if no parsed CSV is found.
    """
    csv_path = output_dir / dataset_name / f"{dataset_name}.csv"
    if not csv_path.exists():
        raise FileNotFoundError(
            f"Parsed dataset not found: {csv_path}\n"
            f"Run: forge datasets parse {dataset_name} first."
        )
    return pd.read_csv(csv_path)


# ---------------------------------------------------------------------------
# inject_anomaly — synthetic augmentation
# ---------------------------------------------------------------------------

AnomalyType = Literal["spike", "flatline", "drift", "fall_impact"]


def inject_anomaly(
    series: np.ndarray,
    anomaly_type: AnomalyType,
    intensity: float,
    *,
    start: int | None = None,
    length: int | None = None,
    rng: np.random.Generator | None = None,
) -> np.ndarray:
    """Inject a synthetic anomaly into a 1-D time series.

    Args:
        series:       Input 1-D array (modified copy is returned).
        anomaly_type: One of 'spike' | 'flatline' | 'drift' | 'fall_impact'.
        intensity:    Anomaly amplitude relative to the signal's std deviation.
                      0.0 = no effect, 1.0 = 1σ, 3.0 = 3σ, etc.
        start:        Index where the anomaly begins. Random if None.
        length:       Length of the anomaly window (samples).
                      Defaults: spike=1, flatline=N//10, drift=N//5, fall_impact=N//8.
        rng:          NumPy random Generator for reproducibility.

    Returns:
        Modified copy of the input array.

    Raises:
        ValueError: If series is not 1-D, or anomaly_type is unknown.
    """
    if series.ndim != 1:
        raise ValueError(f"inject_anomaly expects a 1-D array, got shape {series.shape}")

    known = {"spike", "flatline", "drift", "fall_impact"}
    if anomaly_type not in known:
        raise ValueError(f"Unknown anomaly_type '{anomaly_type}'. Choose from {known}")

    n = len(series)
    if n < 4:
        raise ValueError(f"Series too short (length={n}); minimum is 4 samples")

    if rng is None:
        rng = np.random.default_rng()

    sigma = float(np.std(series)) or 1.0
    out = series.copy().astype(float)

    # ---- spike -----------------------------------------------------------
    if anomaly_type == "spike":
        _len = length if length is not None else 1
        _len = max(1, _len)
        _start = start if start is not None else int(rng.integers(0, n - _len))
        _start = max(0, min(_start, n - _len))
        sign = rng.choice([-1.0, 1.0])
        out[_start : _start + _len] += sign * intensity * sigma * 5.0
        return out

    # ---- flatline --------------------------------------------------------
    if anomaly_type == "flatline":
        _len   = length if length is not None else max(1, n // 10)
        _start = start if start is not None else int(rng.integers(0, n - _len))
        _start = max(0, min(_start, n - _len))
        flat_value = float(np.mean(out[_start : _start + _len]))
        out[_start : _start + _len] = flat_value
        return out

    # ---- drift -----------------------------------------------------------
    if anomaly_type == "drift":
        _len   = length if length is not None else max(1, n // 5)
        _start = start if start is not None else int(rng.integers(0, n - _len))
        _start = max(0, min(_start, n - _len))
        slope = intensity * sigma / max(_len, 1)
        out[_start : _start + _len] += np.arange(_len) * slope
        return out

    # ---- fall_impact -----------------------------------------------------
    # Simulate: pre-fall activity → sharp impact (high amplitude) → post-fall stillness
    if anomaly_type == "fall_impact":
        _len   = length if length is not None else max(4, n // 8)
        _start = start if start is not None else int(rng.integers(0, n - _len))
        _start = max(0, min(_start, n - _len))

        phase_pre    = max(1, _len // 4)
        phase_impact = max(1, _len // 8)
        phase_still  = _len - phase_pre - phase_impact

        # Pre-fall: slightly elevated activity
        out[_start : _start + phase_pre] += (
            rng.uniform(0.5, 1.0, phase_pre) * intensity * sigma
        )
        # Impact: single sharp spike (positive only, representing impact force)
        impact_start = _start + phase_pre
        impact_end   = impact_start + phase_impact
        out[impact_start:impact_end] += intensity * sigma * 8.0 * np.exp(
            -np.linspace(0, 3, phase_impact)
        )
        # Post-fall: stillness (near zero)
        still_start = impact_end
        still_end   = still_start + phase_still
        if still_end > still_start:
            out[still_start:still_end] = (
                np.mean(out) + rng.normal(0, sigma * 0.05, still_end - still_start)
            )
        return out

    # Should not reach here
    raise ValueError(f"Unhandled anomaly_type '{anomaly_type}'")  # pragma: no cover


# ---------------------------------------------------------------------------
# Auto-generated README
# ---------------------------------------------------------------------------

def _write_readme(output_dir: Path, dataset_name: str, report: DatasetQualityReport) -> None:
    manifest = DATASETS.get(dataset_name)
    lines = [
        f"# Fovet Forge — {dataset_name} (parsed)",
        "",
        f"**Description:** {manifest.description if manifest else dataset_name}",
        f"**License:** {manifest.license if manifest else 'unknown'}",
        f"**Source:** {manifest.download_url if manifest else 'unknown'}",
        "",
        "## Quality report",
        f"- Samples : {report.n_samples:,}",
        f"- Features : {report.n_features}",
        f"- Anomaly ratio : {report.anomaly_ratio:.1%}",
        "",
        "## Class distribution",
        "| Label | Count | Ratio |",
        "|-------|------:|------:|",
    ]
    for cls, cnt in report.class_counts.items():
        lines.append(f"| {cls} | {cnt:,} | {report.class_ratios[cls]:.1%} |")
    if report.warnings:
        lines += ["", "## Warnings"]
        for w in report.warnings:
            lines.append(f"- {w}")
    lines += [
        "",
        "---",
        "*Auto-generated by Fovet Forge download_human_datasets.py*",
    ]
    (output_dir / "README.md").write_text("\n".join(lines), encoding="utf-8")


# ---------------------------------------------------------------------------
# High-level parse + save
# ---------------------------------------------------------------------------

_PARSERS = {
    "up_fall": parse_upfall,
    "kfall": parse_kfall,
    "wesad": parse_wesad,
}


def parse_and_save(
    dataset_name: str,
    raw_dir: Path,
    output_dir: Path = _DEFAULT_OUTPUT,
) -> DatasetQualityReport:
    """Parse a raw dataset and save standard CSV + quality report + README.

    Args:
        dataset_name: Key from DATASETS registry.
        raw_dir:      Directory containing raw dataset files.
        output_dir:   Base output directory. Files land in output_dir/dataset_name/.

    Returns:
        DatasetQualityReport for the parsed dataset.

    Raises:
        KeyError: If dataset_name is not in DATASETS.
        FileNotFoundError: If no parseable raw files are found.
    """
    if dataset_name not in DATASETS:
        raise KeyError(
            f"Unknown dataset '{dataset_name}'. "
            f"Available: {list(DATASETS)}"
        )
    if dataset_name not in _PARSERS:
        raise NotImplementedError(
            f"Parser for '{dataset_name}' is not yet implemented. "
            "Contributions welcome!"
        )

    parser = _PARSERS[dataset_name]
    logger.info("Parsing %s from %s …", dataset_name, raw_dir)
    df = parser(raw_dir)

    dest = output_dir / dataset_name
    dest.mkdir(parents=True, exist_ok=True)

    csv_path = dest / f"{dataset_name}.csv"
    df.to_csv(csv_path, index=False)
    logger.info("Saved %d rows → %s", len(df), csv_path)

    report = quality_report(df, dataset_name)
    json_path = dest / f"{dataset_name}_quality.json"
    json_path.write_text(json.dumps(report.as_dict(), indent=2), encoding="utf-8")

    _write_readme(dest, dataset_name, report)

    return report


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _cli_list(_args: argparse.Namespace) -> None:
    print(f"{'Dataset':<12} {'Optional':<10} {'Format':<8} Description")
    print("-" * 72)
    for name, m in DATASETS.items():
        opt = "yes" if m.optional else "no"
        print(f"{name:<12} {opt:<10} {m.format:<8} {m.description[:45]}")


def _cli_info(args: argparse.Namespace) -> None:
    name = args.dataset
    if name not in DATASETS:
        print(f"Error: unknown dataset '{name}'. Run 'list' for available datasets.", file=sys.stderr)
        sys.exit(1)
    m = DATASETS[name]
    print(f"Dataset    : {m.name}")
    print(f"Description: {m.description}")
    print(f"Sensors    : {', '.join(m.sensor_types)}")
    print(f"Format     : {m.format}")
    print(f"License    : {m.license}")
    print(f"URL        : {m.download_url}")
    print()
    print("Download instructions:")
    for line in m.download_notes.split("\n"):
        print(f"  {line}")


def _cli_parse(args: argparse.Namespace) -> None:
    name = args.dataset
    raw_dir = Path(args.raw_dir)
    output_dir = Path(args.output_dir)

    try:
        report = parse_and_save(name, raw_dir, output_dir)
        print(report)
    except (FileNotFoundError, ValueError, KeyError, NotImplementedError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)


def _cli_inject(args: argparse.Namespace) -> None:
    """Inject anomaly into a .npy or single-column .csv file."""
    input_path = Path(args.input)
    if input_path.suffix == ".npy":
        series = np.load(input_path)
    elif input_path.suffix == ".csv":
        df = pd.read_csv(input_path)
        series = df.iloc[:, 0].to_numpy(dtype=float)
    else:
        print("Error: --input must be a .npy or .csv file.", file=sys.stderr)
        sys.exit(1)

    rng = np.random.default_rng(args.seed if args.seed is not None else None)
    result = inject_anomaly(
        series,
        anomaly_type=args.type,
        intensity=args.intensity,
        start=args.start,
        length=args.length,
        rng=rng,
    )

    out_path = Path(args.output) if args.output else input_path.with_stem(input_path.stem + "_anomaly")
    if out_path.suffix == ".npy":
        np.save(out_path, result)
    else:
        pd.DataFrame({"value": result}).to_csv(out_path, index=False)
    print(f"Saved → {out_path}")


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="python -m forge.datasets.download_human_datasets",
        description="Fovet Forge — Human biosignal dataset manager",
    )
    sub = p.add_subparsers(dest="command", required=True)

    sub.add_parser("list", help="List available datasets")

    info_p = sub.add_parser("info", help="Show download instructions for a dataset")
    info_p.add_argument("dataset", choices=list(DATASETS))

    parse_p = sub.add_parser("parse", help="Parse raw dataset files into standard Fovet CSV")
    parse_p.add_argument("dataset", choices=list(_PARSERS))
    parse_p.add_argument("--raw-dir",    required=True, help="Directory with raw dataset files")
    parse_p.add_argument("--output-dir", default=str(_DEFAULT_OUTPUT),
                         help="Base output directory (default: datasets/human/)")

    inj_p = sub.add_parser("inject", help="Inject a synthetic anomaly into a signal file")
    inj_p.add_argument("--input",     required=True, help=".npy or single-column .csv")
    inj_p.add_argument("--type",      required=True,
                        choices=["spike", "flatline", "drift", "fall_impact"])
    inj_p.add_argument("--intensity", type=float, default=1.0)
    inj_p.add_argument("--start",     type=int,   default=None)
    inj_p.add_argument("--length",    type=int,   default=None)
    inj_p.add_argument("--seed",      type=int,   default=None)
    inj_p.add_argument("--output",    default=None, help="Output file path")

    return p


def main(argv: list[str] | None = None) -> None:
    parser = _build_parser()
    args   = parser.parse_args(argv)

    dispatch = {
        "list":   _cli_list,
        "info":   _cli_info,
        "parse":  _cli_parse,
        "inject": _cli_inject,
    }
    dispatch[args.command](args)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    main()
