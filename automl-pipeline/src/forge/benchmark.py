"""
Forge benchmark -- run multiple pipeline configs against the same dataset
and produce a combined benchmark report.

Usage:
    from forge.benchmark import run_benchmark
    metrics = run_benchmark(configs, output_dir=Path("reports"))
"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

from forge.config import PipelineConfig
from forge.data import Dataset, load_data
from forge.detectors import build_detectors
from forge.evaluation import BenchmarkSummary, EvaluationMetrics, compute_metrics


def run_benchmark(
    configs: list[PipelineConfig],
    output_dir: Path = Path("reports"),
) -> list[EvaluationMetrics]:
    """Run multiple detector configs on the same dataset and write a combined report.

    Data is loaded using the first config's data section.  All configs share the
    same train/test split (derived from config[0].split settings).

    Args:
        configs:    At least 2 ``PipelineConfig`` objects to compare.
        output_dir: Directory to write the benchmark report (created if absent).

    Returns:
        Flat list of ``EvaluationMetrics`` — one entry per detector across all configs.

    Raises:
        ValueError: When fewer than 2 configs are supplied.
    """
    if len(configs) < 2:
        raise ValueError(
            f"forge benchmark requires at least 2 configs, got {len(configs)}"
        )

    # --- Load data from first config ----------------------------------------
    dataset: Dataset = load_data(configs[0].data)

    # --- Train / test split (first config drives the split) -----------------
    split_cfg = configs[0].split
    if split_cfg.enabled:
        train_ds, test_ds = dataset.split(
            test_ratio=split_cfg.test_ratio,
            random_state=split_cfg.random_state,
        )
    else:
        train_ds = dataset
        test_ds = dataset

    # --- Run each config's detectors ----------------------------------------
    all_metrics: list[EvaluationMetrics] = []

    for cfg in configs:
        detectors = build_detectors(cfg.detectors)
        for detector in detectors:
            detector.fit(train_ds)
            result = detector.predict(test_ds)
            m = compute_metrics(result, ground_truth=test_ds.labels)
            all_metrics.append(m)

    # --- Write combined report ----------------------------------------------
    fmt = configs[0].report.format if configs[0].report.enabled else "json"
    output_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    stem = f"benchmark_{timestamp}"

    if fmt == "html":
        report_path = output_dir / f"{stem}.html"
        report_path.write_text(
            _render_benchmark_html(configs, all_metrics, train_ds.n_samples, test_ds.n_samples),
            encoding="utf-8",
        )
    else:
        report_path = output_dir / f"{stem}.json"
        report_path.write_text(
            _render_benchmark_json(configs, all_metrics, train_ds.n_samples, test_ds.n_samples),
            encoding="utf-8",
        )

    return all_metrics


# ---------------------------------------------------------------------------
# JSON renderer
# ---------------------------------------------------------------------------

def _render_benchmark_json(
    configs: list[PipelineConfig],
    metrics: list[EvaluationMetrics],
    train_n: int,
    test_n: int,
) -> str:
    payload: dict = {
        "benchmark": True,
        "generated_at": datetime.now().isoformat(),
        "configs": [cfg.name for cfg in configs],
        "split": {
            "enabled": configs[0].split.enabled,
            "train_n": train_n,
            "test_n": test_n,
            "test_ratio": configs[0].split.test_ratio if configs[0].split.enabled else None,
        },
        "detectors": [m.as_dict() for m in metrics],
    }
    if metrics:
        payload["summary"] = BenchmarkSummary.from_metrics(metrics).as_dict()
    return json.dumps(payload, indent=2, ensure_ascii=False)


# ---------------------------------------------------------------------------
# HTML renderer
# ---------------------------------------------------------------------------

def _render_benchmark_html(
    configs: list[PipelineConfig],
    metrics: list[EvaluationMetrics],
    train_n: int,
    test_n: int,
) -> str:
    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    config_names = ", ".join(cfg.name for cfg in configs)
    split_cfg = configs[0].split
    split_info = (
        f"Train : {train_n} samples &nbsp;|&nbsp; Test : {test_n} samples "
        f"({split_cfg.test_ratio:.0%})"
        if split_cfg.enabled
        else f"No split — {train_n} samples (fit + predict on same data)"
    )

    summary = BenchmarkSummary.from_metrics(metrics)
    has_gt = any(m.has_ground_truth for m in metrics)

    # Comparison table rows
    rows = ""
    for m in metrics:
        def _cell(value: float | None, best: str | None) -> str:
            if value is None:
                return "<td>—</td>"
            txt = f"{value:.2%}"
            cls = ' class="best"' if m.detector_name == best else ""
            return f"<td{cls}>{txt}</td>"

        rows += (
            f"<tr>"
            f"<td>{m.detector_name}</td>"
            f"<td>{m.n_samples}</td>"
            f"<td>{m.n_anomalies_predicted} ({m.anomaly_rate:.1%})</td>"
        )
        if has_gt:
            rows += (
                f"{_cell(m.precision, summary.best_by_precision)}"
                f"{_cell(m.recall, summary.best_by_recall)}"
                f"{_cell(m.f1, summary.best_by_f1)}"
                f"<td>{m.tp if m.tp is not None else '—'}</td>"
                f"<td>{m.fp if m.fp is not None else '—'}</td>"
                f"<td>{m.fn if m.fn is not None else '—'}</td>"
            )
        rows += "</tr>\n"

    gt_headers = (
        "<th>Précision</th><th>Rappel</th><th>F1</th><th>TP</th><th>FP</th><th>FN</th>"
        if has_gt else ""
    )

    best_line = ""
    if summary.best_by_f1:
        best_line = (
            f'<p>Meilleur F1 : <strong>{summary.best_by_f1}</strong> &nbsp;|&nbsp; '
            f'Meilleur rappel : <strong>{summary.best_by_recall}</strong> &nbsp;|&nbsp; '
            f'Meilleure précision : <strong>{summary.best_by_precision}</strong></p>'
        )

    return f"""<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Fovet Forge — Benchmark</title>
  <style>
    body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            max-width: 960px; margin: 40px auto; padding: 0 20px;
            background: #f8f9fa; color: #212529; }}
    h1 {{ color: #0d6efd; border-bottom: 2px solid #0d6efd; padding-bottom: 8px; }}
    h2 {{ color: #495057; margin-top: 32px; }}
    .meta {{ background: #fff; border: 1px solid #dee2e6; border-radius: 8px;
             padding: 16px; margin: 16px 0; }}
    .meta p {{ margin: 4px 0; }}
    table {{ width: 100%; border-collapse: collapse; background: #fff;
             border-radius: 8px; overflow: hidden;
             box-shadow: 0 1px 3px rgba(0,0,0,.1); }}
    th {{ background: #495057; color: #fff; padding: 10px 14px; text-align: left; }}
    td {{ padding: 9px 14px; border-bottom: 1px solid #dee2e6; text-align: right; }}
    td:first-child {{ text-align: left; font-weight: 600; }}
    tr:last-child td {{ border-bottom: none; }}
    tr:hover td {{ background: #f1f3f5; }}
    .best {{ font-weight: 700; color: #0f5132; }}
    .footer {{ margin-top: 40px; font-size: 0.8em; color: #868e96; text-align: center; }}
  </style>
</head>
<body>
  <h1>Fovet Forge — Benchmark comparatif</h1>

  <div class="meta">
    <p><strong>Configs :</strong> {config_names}</p>
    <p><strong>Généré le :</strong> {now}</p>
    <p><strong>Données :</strong> {split_info}</p>
  </div>

  <h2>Résultats comparatifs</h2>
  {best_line}
  <table>
    <tr>
      <th>Détecteur</th>
      <th>Samples</th>
      <th>Anomalies</th>
      {gt_headers}
    </tr>
    {rows}
  </table>

  <div class="footer">
    Fovet Forge &nbsp;·&nbsp; fovet.eu &nbsp;·&nbsp; contact@fovet.eu
  </div>
</body>
</html>"""
