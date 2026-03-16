"""
Fovet Forge CLI â€” entry point.

Usage:
    forge run --config configs/demo_zscore.yaml
    forge validate --config configs/demo_zscore.yaml
    forge version
"""

from __future__ import annotations

from pathlib import Path

import typer
from pydantic import ValidationError
from rich.console import Console
from rich.table import Table

from forge import __version__
from forge.config import PipelineConfig
from forge.pipeline import Pipeline
from forge.benchmark import run_benchmark

app = typer.Typer(
    name="forge",
    help="Fovet Forge â€” AutoML pipeline for anomaly detection on embedded targets.",
    no_args_is_help=True,
)
console = Console()
err_console = Console(stderr=True, style="bold red")


@app.command()
def run(
    config: Path = typer.Option(..., "--config", "-c", help="Path to pipeline YAML config"),
) -> None:
    """Load config and run the full pipeline."""
    pipeline = _load_pipeline(config)
    if pipeline is None:
        raise typer.Exit(1)
    pipeline.run()


@app.command()
def validate(
    config: Path = typer.Option(..., "--config", "-c", help="Path to pipeline YAML config"),
) -> None:
    """Validate a pipeline YAML config without running it."""
    cfg = _load_config(config)
    if cfg is None:
        raise typer.Exit(1)

    table = Table(title=f"Config: {config}", show_header=True)
    table.add_column("Field", style="cyan")
    table.add_column("Value")
    table.add_row("name", cfg.name)
    table.add_row("data.source", cfg.data.source.value)
    table.add_row("detectors", ", ".join(d.type.value for d in cfg.detectors))
    table.add_row("export.targets", ", ".join(t.value for t in cfg.export.targets))
    table.add_row("report.format", cfg.report.format if cfg.report.enabled else "disabled")

    console.print(table)
    console.print("[green]âœ“ Config is valid.[/green]")


@app.command()
def benchmark(
    configs: list[Path] = typer.Option(
        ..., "--config", "-c", help="Config YAMLs to compare (pass multiple times)"
    ),
    output_dir: Path = typer.Option(
        Path("reports"), "--output-dir", "-o", help="Report output directory"
    ),
) -> None:
    """Compare multiple detector configs on the same dataset."""
    if len(configs) < 2:
        err_console.print("forge benchmark requires at least 2 --config options.")
        raise typer.Exit(1)

    loaded: list[PipelineConfig] = []
    for path in configs:
        cfg = _load_config(path)
        if cfg is None:
            raise typer.Exit(1)
        loaded.append(cfg)

    try:
        all_metrics = run_benchmark(loaded, output_dir=output_dir)
    except Exception as e:
        err_console.print(f"Benchmark failed: {e}")
        raise typer.Exit(1)

    # Print Rich comparison table
    table = Table(title="Benchmark Results", show_header=True, header_style="bold")
    table.add_column("Detector", style="cyan")
    table.add_column("Samples", justify="right")
    table.add_column("Anomalies", justify="right")
    table.add_column("Rate", justify="right")
    table.add_column("Precision", justify="right")
    table.add_column("Recall", justify="right")
    table.add_column("F1", justify="right")

    for m in all_metrics:
        table.add_row(
            m.detector_name,
            str(m.n_samples),
            str(m.n_anomalies_predicted),
            f"{m.anomaly_rate:.1%}",
            f"{m.precision:.2f}" if m.precision is not None else "—",
            f"{m.recall:.2f}" if m.recall is not None else "—",
            f"{m.f1:.2f}" if m.f1 is not None else "—",
        )

    console.print(table)
    console.print(f"[green]Benchmark report written to: {output_dir}[/green]")


@app.command()
def version() -> None:
    """Print Forge version."""
    console.print(f"fovet-forge {__version__}")


def _load_config(path: Path) -> PipelineConfig | None:
    if not path.exists():
        err_console.print(f"Config file not found: {path}")
        return None
    try:
        return PipelineConfig.from_yaml(path)
    except ValidationError as e:
        err_console.print(f"Invalid config:\n{e}")
        return None
    except Exception as e:
        err_console.print(f"Failed to load config: {e}")
        return None


def _load_pipeline(path: Path) -> Pipeline | None:
    cfg = _load_config(path)
    return Pipeline(cfg) if cfg else None

