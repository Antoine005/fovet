“””
Fovet Forge CLI — entry point.

Usage:
    forge run --config configs/demo_zscore.yaml
    forge validate --config configs/demo_zscore.yaml
    forge convert --model model.h5 --output model.tflite [--quantization int8]
    forge deploy --model model.tflite --target person_detection [--port COM4]
    forge version
“””

from __future__ import annotations

from pathlib import Path

import numpy as np
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
def convert(
    model: Path = typer.Option(..., "--model", "-m", help="Keras model path (.h5 or SavedModel)"),
    output: Path = typer.Option(None, "--output", "-o", help="Output .tflite path (default: <model>.tflite)"),
    quantization: str = typer.Option(
        "float32", "--quantization", "-q", help="float32 or int8"
    ),
    calibration: Path = typer.Option(
        None, "--calibration", help=".npy calibration data for INT8 (n_samples × *input_shape)"
    ),
) -> None:
    """Convert a Keras model to TFLite optimised for ESP32 (float32 or INT8)."""
    from forge.convert import convert_keras_to_tflite, ESP32_MAX_ARENA_BYTES  # noqa: PLC0415

    out = output if output is not None else model.with_suffix(".tflite")

    calib_data = None
    if calibration is not None:
        if not calibration.exists():
            err_console.print(f"Calibration file not found: {calibration}")
            raise typer.Exit(1)
        calib_data = np.load(str(calibration)).astype("float32")

    try:
        result = convert_keras_to_tflite(
            model, out,
            quantization=quantization,
            calibration_data=calib_data,
        )
    except ImportError as exc:
        err_console.print(str(exc))
        raise typer.Exit(1)
    except (FileNotFoundError, ValueError) as exc:
        err_console.print(str(exc))
        raise typer.Exit(1)

    table = Table(title="Conversion result", show_header=True)
    table.add_column("Field", style="cyan")
    table.add_column("Value")
    table.add_row("TFLite model", str(result.tflite_path))
    table.add_row("Quantization", result.quantization)
    table.add_row("Model size", f"{result.model_size_kb} KB")
    table.add_row(
        "Tensor arena",
        f"{result.arena_estimate_kb} KB  "
        f"({'[green]OK[/green]' if result.fits_esp32 else '[red]TOO LARGE[/red]'} "
        f"— limit {ESP32_MAX_ARENA_BYTES // 1024} KB)",
    )
    table.add_row("Report", str(result.report_path))
    console.print(table)

    for w in result.warnings:
        console.print(f"[yellow]WARNING:[/yellow] {w}")

    if result.fits_esp32:
        console.print("[green]✔ Model fits ESP32 tensor arena.[/green]")
    else:
        console.print("[red]✘ Model exceeds ESP32 tensor arena — optimise before deploying.[/red]")
        raise typer.Exit(1)


@app.command()
def deploy(
    model: Path = typer.Option(..., "--model", "-m", help="Path to .tflite model"),
    target: str = typer.Option(
        "person_detection", "--target", "-t",
        help="Built-in target: person_detection | fire_detection | zscore_demo",
    ),
    port: str = typer.Option("COM4", "--port", "-p", help="Upload serial port"),
    compile_only: bool = typer.Option(False, "--compile-only", help="Compile only, skip flash"),
    project_dir: Path = typer.Option(
        None, "--project-dir", help="Custom PlatformIO project directory"
    ),
) -> None:
    """Deploy a TFLite model to ESP32: generate model_data.cpp → pio compile → flash."""
    from forge.deploy import deploy as _deploy, _BUILTIN_TARGETS  # noqa: PLC0415

    console.print(f"[bold]Fovet Forge deploy[/bold] — target: [cyan]{target}[/cyan]")
    console.print(f"  Model  : {model}")
    console.print(f"  Port   : {port}")
    console.print(f"  Mode   : {'compile only' if compile_only else 'compile + flash'}")

    try:
        _deploy(
            tflite_path=model,
            target=target,
            port=port,
            compile_only=compile_only,
            custom_project_dir=project_dir,
        )
    except FileNotFoundError as exc:
        err_console.print(str(exc))
        raise typer.Exit(1)
    except ValueError as exc:
        err_console.print(str(exc))
        err_console.print(f"Built-in targets: {', '.join(sorted(_BUILTIN_TARGETS))}")
        raise typer.Exit(1)
    except RuntimeError as exc:
        err_console.print(str(exc))
        raise typer.Exit(1)

    if compile_only:
        console.print("[green]✔ Compile successful.[/green]")
    else:
        console.print("[green]✔ Flash complete.[/green]")


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

