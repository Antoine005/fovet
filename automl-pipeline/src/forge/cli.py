"""
Ardent Forge CLI -- entry point.

Usage:
    forge run --config configs/demo_zscore.yaml
    forge validate --config configs/demo_zscore.yaml
    forge convert --model model.h5 --output model.tflite [--quantization int8]
    forge deploy --model model.tflite --target person_detection [--port COM4]
    forge version
"""

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
    help="Ardent Forge -- AutoML pipeline for anomaly detection on embedded targets.",
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
    console.print("[green]OK Config is valid.[/green]")


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
            f"{m.precision:.2f}" if m.precision is not None else "--",
            f"{m.recall:.2f}" if m.recall is not None else "--",
            f"{m.f1:.2f}" if m.f1 is not None else "--",
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
        None, "--calibration", help=".npy calibration data for INT8 (n_samples x *input_shape)"
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
        f"-- limit {ESP32_MAX_ARENA_BYTES // 1024} KB)",
    )
    table.add_row("Report", str(result.report_path))
    console.print(table)

    for w in result.warnings:
        console.print(f"[yellow]WARNING:[/yellow] {w}")

    if result.fits_esp32:
        console.print("[green]OK Model fits ESP32 tensor arena.[/green]")
    else:
        console.print("[red]FAIL Model exceeds ESP32 tensor arena -- optimise before deploying.[/red]")
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
    """Deploy a TFLite model to ESP32: generate model_data.cpp -> pio compile -> flash."""
    from forge.deploy import deploy as _deploy, _BUILTIN_TARGETS  # noqa: PLC0415

    console.print(f"[bold]Ardent Forge deploy[/bold] -- target: [cyan]{target}[/cyan]")
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
        console.print("[green]OK Compile successful.[/green]")
    else:
        console.print("[green]OK Flash complete.[/green]")


@app.command(name="deploy-manifest")
def deploy_manifest(
    config: Path = typer.Option(..., "--config", "-c", help="Path to pipeline YAML config"),
    project_dir: Path = typer.Option(
        ..., "--project-dir", "-p",
        help="PlatformIO project directory -- manifest will be copied to <project-dir>/src/"
    ),
) -> None:
    """Copy the generated ard_model_manifest.h to a PlatformIO project.

    Run after `forge run` to embed the Forge model metadata into firmware:

    \\b
        forge run --config configs/demo_zscore.yaml
        forge deploy-manifest --config configs/demo_zscore.yaml \\
                              --project-dir examples/esp32/zscore_demo
    """
    import shutil  # noqa: PLC0415

    cfg = _load_config(config)
    if cfg is None:
        raise typer.Exit(1)

    src = Path(cfg.export.output_dir) / "ard_model_manifest.h"
    if not src.exists():
        err_console.print(
            f"Manifest not found: {src}\n"
            f"Run `forge run --config {config}` first."
        )
        raise typer.Exit(1)

    dest_dir = project_dir / "src"
    if not dest_dir.is_dir():
        err_console.print(f"Project src/ directory not found: {dest_dir}")
        raise typer.Exit(1)

    dest = dest_dir / "ard_model_manifest.h"
    shutil.copy2(src, dest)

    console.print(f"[green]OK[/green] Copied manifest to [cyan]{dest}[/cyan]")
    console.print(f"  Pipeline : [bold]{cfg.name}[/bold]")
    console.print(f"  Unit     : {cfg.manifest.unit}")
    console.print(f"  Sensor   : {cfg.manifest.sensor}")


@app.command(name="new-usecase")
def new_usecase(
    name: str = typer.Option(..., "--name", "-n", help="Use-case slug, e.g. vibration-monitor"),
    sensor: str = typer.Option("synthetic", "--sensor", "-s",
                               help="synthetic | imu | temperature | hr | camera | custom"),
    detector: str = typer.Option("zscore", "--detector", "-d",
                                 help="zscore | mad | drift | autoencoder | lstm_autoencoder"),
    data: Path = typer.Option(None, "--data", help="Path to CSV dataset (omit for synthetic)"),
    column: str = typer.Option("value", "--column", help="CSV column name to use as signal"),
    port: str = typer.Option("COM4", "--port", "-p", help="Serial port for PlatformIO flash"),
    sigma: float = typer.Option(3.0, "--sigma", help="Detection threshold (sigma for zscore/mad)"),
) -> None:
    """Scaffold a complete use-case: Forge config + ESP32 PlatformIO project.

    \\b
    Example — vibration anomaly from Kaggle CSV:

        forge new-usecase --name vibration-monitor \\
                          --sensor imu \\
                          --detector zscore \\
                          --data data/vibration.csv \\
                          --column acceleration_x

    Then run the pipeline and deploy in one command:

        forge run --config configs/vibration-monitor.yaml
        forge deploy-full --config configs/vibration-monitor.yaml \\
                          --project-dir edge-core/examples/esp32/vibration-monitor
    """
    from forge.scaffolding import scaffold_usecase, _DETECTOR_IS_STATS, _DETECTOR_IS_ML  # noqa: PLC0415

    valid_detectors = _DETECTOR_IS_STATS | _DETECTOR_IS_ML
    if detector not in valid_detectors:
        err_console.print(f"Unknown detector: {detector}. Choose from: {', '.join(sorted(valid_detectors))}")
        raise typer.Exit(1)

    if data is not None and not data.exists():
        err_console.print(f"CSV file not found: {data}")
        raise typer.Exit(1)

    # Auto-detect repo root (go up from cli.py until we find edge-core/)
    root = Path(__file__).resolve()
    for _ in range(10):
        root = root.parent
        if (root / "edge-core").is_dir():
            break
    else:
        err_console.print("Could not find repo root (no edge-core/ directory found).")
        raise typer.Exit(1)

    console.print(f"[bold]Ardent Forge new-usecase[/bold]")
    console.print(f"  Name     : [cyan]{name}[/cyan]")
    console.print(f"  Sensor   : {sensor}")
    console.print(f"  Detector : {detector}")
    console.print(f"  Data     : {data if data else 'synthetic (sine wave)'}")
    console.print(f"  Port     : {port}")
    console.print()

    try:
        from forge.scaffolding import scaffold_usecase  # noqa: PLC0415
        result = scaffold_usecase(
            name=name,
            sensor=sensor,
            detector=detector,
            data_path=str(data) if data else None,
            column=column,
            port=port,
            threshold_sigma=sigma,
            root_dir=root,
        )
    except Exception as e:
        err_console.print(f"Scaffolding failed: {e}")
        raise typer.Exit(1)

    slug = name.replace(" ", "-").lower()
    console.print("[green]OK[/green] Files created:")
    for f in result.files_created:
        console.print(f"  [cyan]{f}[/cyan]")

    console.print()
    console.print("[bold]Next steps:[/bold]")
    console.print(f"  1. Copy [cyan]{result.project_dir}/src/config.h.example[/cyan] -> [cyan]config.h[/cyan] and fill in WiFi/MQTT credentials")
    console.print(f"  2. [cyan]uv run forge run --config configs/{slug}.yaml[/cyan]")
    console.print(f"  3. [cyan]uv run forge deploy-full --config configs/{slug}.yaml --project-dir {result.project_dir}[/cyan]")
    console.print(f"  4. Open Watch and register the device: POST /api/devices {{\"mqttClientId\": \"esp32-{slug[:16]}\"}}")


@app.command(name="deploy-full")
def deploy_full(
    config: Path = typer.Option(..., "--config", "-c", help="Path to pipeline YAML config"),
    project_dir: Path = typer.Option(..., "--project-dir", "-p", help="PlatformIO project directory"),
    port: str = typer.Option("COM4", "--port", help="Serial upload port"),
    compile_only: bool = typer.Option(False, "--compile-only", help="Compile only, skip flash"),
) -> None:
    """Run the full Forge -> Pulse pipeline in one command.

    Chains: forge run -> forge deploy-manifest -> pio compile -> pio flash.

    \\b
        forge deploy-full --config configs/vibration-monitor.yaml \\
                          --project-dir edge-core/examples/esp32/vibration-monitor
    """
    import subprocess  # noqa: PLC0415
    import shutil      # noqa: PLC0415

    cfg = _load_config(config)
    if cfg is None:
        raise typer.Exit(1)

    slug = cfg.name
    src_dir = project_dir / "src"
    if not src_dir.is_dir():
        err_console.print(f"PlatformIO src/ not found: {src_dir}\nRun forge new-usecase first.")
        raise typer.Exit(1)

    # Step 1 — forge run
    console.print(f"\n[bold cyan]Step 1/4[/bold cyan] — Training pipeline: [bold]{slug}[/bold]")
    pipeline = _load_pipeline(config)
    if pipeline is None:
        raise typer.Exit(1)
    try:
        pipeline.run()
    except Exception as e:
        err_console.print(f"Pipeline failed: {e}")
        raise typer.Exit(1)
    console.print("[green]OK[/green] Pipeline complete.")

    # Step 2 — deploy manifest
    console.print(f"\n[bold cyan]Step 2/4[/bold cyan] — Deploying manifest to [cyan]{src_dir}[/cyan]")
    manifest_src = Path(cfg.export.output_dir) / "ard_model_manifest.h"
    if not manifest_src.exists():
        err_console.print(f"Manifest not found: {manifest_src}")
        raise typer.Exit(1)
    manifest_dest = src_dir / "ard_model_manifest.h"
    shutil.copy2(manifest_src, manifest_dest)
    console.print(f"[green]OK[/green] Manifest -> [cyan]{manifest_dest}[/cyan]")

    # Step 3 — for ML detectors, copy model_data.h / model_data.cpp
    from forge.config import DetectorType  # noqa: PLC0415
    ml_detectors = {DetectorType.autoencoder, DetectorType.lstm_autoencoder}
    has_ml = any(d.type in ml_detectors for d in cfg.detectors)

    if has_ml:
        console.print(f"\n[bold cyan]Step 3/4[/bold cyan] — Copying TFLite model to firmware")
        # Find the first tflite file in output_dir
        output_dir = Path(cfg.export.output_dir)
        tflite_files = list(output_dir.glob("*.tflite"))
        if not tflite_files:
            err_console.print(f"No .tflite file found in {output_dir}. Run forge run first.")
            raise typer.Exit(1)
        tflite_path = tflite_files[0]
        # Generate model_data.cpp
        try:
            from forge.deploy import generate_model_cpp  # noqa: PLC0415
            model_cpp = generate_model_cpp(tflite_path, array_name="g_model_data")
            cpp_dest = src_dir / "model_data.cpp"
            cpp_dest.write_text(model_cpp, encoding="utf-8")
            console.print(f"[green]OK[/green] model_data.cpp -> [cyan]{cpp_dest}[/cyan]")
        except Exception as e:
            err_console.print(f"Model copy failed: {e}")
            raise typer.Exit(1)
    else:
        console.print(f"\n[bold cyan]Step 3/4[/bold cyan] — Statistical detector: no TFLite needed")
        # Copy C header config (ard_zscore_config.h / ard_mad_config.h / ard_drift_config.h)
        output_dir = Path(cfg.export.output_dir)
        for h_file in output_dir.glob("ard_*_config.h"):
            dest = src_dir / h_file.name
            shutil.copy2(h_file, dest)
            console.print(f"[green]OK[/green] {h_file.name} -> [cyan]{dest}[/cyan]")

    # Step 4 — pio compile (+ upload)
    console.print(f"\n[bold cyan]Step 4/4[/bold cyan] — PlatformIO {'compile' if compile_only else 'compile + flash'}")

    pio_cmd_base = ["pio", "run", "--project-dir", str(project_dir)]
    try:
        result = subprocess.run(pio_cmd_base, check=True, capture_output=False)
    except FileNotFoundError:
        err_console.print("pio not found. Install PlatformIO: https://platformio.org/install/cli")
        raise typer.Exit(1)
    except subprocess.CalledProcessError:
        err_console.print("PlatformIO compile failed.")
        raise typer.Exit(1)

    if not compile_only:
        pio_upload = pio_cmd_base + ["--target", "upload", "--upload-port", port]
        try:
            subprocess.run(pio_upload, check=True, capture_output=False)
        except subprocess.CalledProcessError:
            err_console.print("PlatformIO upload failed. Check that the ESP32 is connected.")
            raise typer.Exit(1)

    console.print()
    if compile_only:
        console.print("[green]OK[/green] Compile successful.")
    else:
        console.print("[green]OK[/green] Flash complete. Open Watch to monitor your device.")


@app.command()
def version() -> None:
    """Print Forge version."""
    console.print(f"ardent-forge {__version__}")


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

