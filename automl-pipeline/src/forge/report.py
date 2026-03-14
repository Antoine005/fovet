"""
Report generation -- produces HTML or JSON evaluation reports.

Reports summarise pipeline metadata, train/test split info, and per-detector
evaluation metrics.  HTML reports are fully self-contained (inline CSS,
no external dependencies).

Usage:
    from forge.report import generate_report
    path = generate_report(config, metrics_list, output_dir=Path("reports"))
"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

from forge.config import PipelineConfig
from forge.evaluation import EvaluationMetrics


def generate_report(
    config: PipelineConfig,
    metrics: list[EvaluationMetrics],
    train_n: int,
    test_n: int,
    output_dir: Path,
) -> Path:
    """Write an evaluation report to disk.

    Dispatches to HTML or JSON based on ``config.report.format``.

    Args:
        config:     Pipeline configuration (name, description, split settings).
        metrics:    List of ``EvaluationMetrics`` — one per detector.
        train_n:    Number of training samples used.
        test_n:     Number of test samples evaluated (0 if no split).
        output_dir: Directory to write the report (created if absent).

    Returns:
        Path to the written report file.
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    stem = f"report_{config.name}_{timestamp}"

    if config.report.format == "html":
        path = output_dir / f"{stem}.html"
        path.write_text(_render_html(config, metrics, train_n, test_n), encoding="utf-8")
    else:
        path = output_dir / f"{stem}.json"
        path.write_text(_render_json(config, metrics, train_n, test_n), encoding="utf-8")

    return path


# ---------------------------------------------------------------------------
# JSON renderer
# ---------------------------------------------------------------------------

def _render_json(
    config: PipelineConfig,
    metrics: list[EvaluationMetrics],
    train_n: int,
    test_n: int,
) -> str:
    payload = {
        "pipeline": config.name,
        "description": config.description,
        "generated_at": datetime.now().isoformat(),
        "split": {
            "enabled": config.split.enabled,
            "train_n": train_n,
            "test_n": test_n,
            "test_ratio": config.split.test_ratio if config.split.enabled else None,
        },
        "detectors": [m.as_dict() for m in metrics],
    }
    return json.dumps(payload, indent=2, ensure_ascii=False)


# ---------------------------------------------------------------------------
# HTML renderer
# ---------------------------------------------------------------------------

def _render_html(
    config: PipelineConfig,
    metrics: list[EvaluationMetrics],
    train_n: int,
    test_n: int,
) -> str:
    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    split_info = (
        f"Train : {train_n} samples &nbsp;|&nbsp; Test : {test_n} samples "
        f"({config.split.test_ratio:.0%})"
        if config.split.enabled
        else f"No split — {train_n} samples (fit + predict on same data)"
    )

    detector_sections = "\n".join(_detector_section(m) for m in metrics)

    return f"""<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Fovet Forge — {config.name}</title>
  <style>
    body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            max-width: 900px; margin: 40px auto; padding: 0 20px;
            background: #f8f9fa; color: #212529; }}
    h1 {{ color: #0d6efd; border-bottom: 2px solid #0d6efd; padding-bottom: 8px; }}
    h2 {{ color: #495057; margin-top: 32px; }}
    .meta {{ background: #fff; border: 1px solid #dee2e6; border-radius: 8px;
             padding: 16px; margin: 16px 0; }}
    .meta p {{ margin: 4px 0; }}
    .badge {{ display: inline-block; padding: 2px 8px; border-radius: 12px;
              font-size: 0.85em; font-weight: 600; }}
    .badge-ok   {{ background: #d1e7dd; color: #0f5132; }}
    .badge-warn {{ background: #fff3cd; color: #664d03; }}
    .badge-na   {{ background: #e9ecef; color: #495057; }}
    table {{ width: 100%; border-collapse: collapse; background: #fff;
             border-radius: 8px; overflow: hidden;
             box-shadow: 0 1px 3px rgba(0,0,0,.1); }}
    th {{ background: #0d6efd; color: #fff; padding: 10px 14px; text-align: left; }}
    td {{ padding: 9px 14px; border-bottom: 1px solid #dee2e6; }}
    tr:last-child td {{ border-bottom: none; }}
    tr:hover td {{ background: #f1f3f5; }}
    .footer {{ margin-top: 40px; font-size: 0.8em; color: #868e96; text-align: center; }}
  </style>
</head>
<body>
  <h1>Fovet Forge — Rapport d'évaluation</h1>

  <div class="meta">
    <p><strong>Pipeline :</strong> {config.name}</p>
    <p><strong>Description :</strong> {config.description or "—"}</p>
    <p><strong>Généré le :</strong> {now}</p>
    <p><strong>Données :</strong> {split_info}</p>
  </div>

  {detector_sections}

  <div class="footer">
    Fovet Forge &nbsp;·&nbsp; fovet.eu &nbsp;·&nbsp; contact@fovet.eu
  </div>
</body>
</html>"""


def _detector_section(m: EvaluationMetrics) -> str:
    if m.has_ground_truth:
        prec_badge = _badge(m.precision, good=0.8)
        rec_badge  = _badge(m.recall,    good=0.7)
        f1_badge   = _badge(m.f1,        good=0.75)
        rows = f"""
        <tr><th>Précision</th><td>{prec_badge} {m.precision:.2%}</td></tr>
        <tr><th>Rappel</th>   <td>{rec_badge}  {m.recall:.2%}</td></tr>
        <tr><th>F1</th>       <td>{f1_badge}   {m.f1:.2%}</td></tr>
        <tr><th>TP / FP / FN / TN</th>
            <td>{m.tp} / {m.fp} / {m.fn} / {m.tn}</td></tr>"""
    else:
        rows = """
        <tr><td colspan="2">
          <span class="badge badge-na">Pas de vérité terrain</span>
          — métriques precision/recall non disponibles.
        </td></tr>"""

    return f"""
  <h2>{m.detector_name}</h2>
  <table>
    <tr><th colspan="2">Résultats</th></tr>
    <tr><th>Samples évalués</th><td>{m.n_samples}</td></tr>
    <tr><th>Anomalies prédites</th><td>{m.n_anomalies_predicted}
        ({m.anomaly_rate:.1%})</td></tr>
    {rows}
  </table>"""


def _badge(value: float | None, good: float) -> str:
    if value is None:
        return '<span class="badge badge-na">N/A</span>'
    cls = "badge-ok" if value >= good else "badge-warn"
    return f'<span class="badge {cls}">{"OK" if value >= good else "faible"}</span>'
