"""
Pipeline runner -- orchestrates data loading, training, evaluation, and export.
"""

from __future__ import annotations

from pathlib import Path

from rich.console import Console
from rich.table import Table

from forge.config import PipelineConfig, ExportTarget
from forge.data import Dataset, load_data
from forge.detectors import DetectionResult, build_detectors
from forge.detectors.base import Detector

console = Console()


class Pipeline:
    def __init__(self, config: PipelineConfig) -> None:
        self.config = config
        self.dataset: Dataset | None = None
        self.detectors: list[Detector] = []
        self.results: list[DetectionResult] = []

    @classmethod
    def from_yaml(cls, path: str | Path) -> Pipeline:
        return cls(PipelineConfig.from_yaml(path))

    def run(self) -> None:
        """Execute the full pipeline: load data → fit detectors → predict → export."""
        console.rule(f"[bold blue]Fovet Forge -- {self.config.name}")
        console.print(f"[dim]{self.config.description}[/dim]\n")

        # --- Data loading ---------------------------------------------------
        console.print("[cyan]Data loading...[/cyan]")
        self.dataset = load_data(self.config.data)
        console.print(f"  {self.dataset}")
        if self.dataset.labels is not None:
            console.print(
                f"  Ground truth: {self.dataset.anomaly_count} anomalies "
                f"({self.dataset.anomaly_rate:.1%})"
            )

        # --- Detectors ------------------------------------------------------
        console.print("\n[cyan]Training detectors...[/cyan]")
        self.detectors = build_detectors(self.config.detectors)
        self.results = []

        for detector in self.detectors:
            detector.fit(self.dataset)
            result = detector.predict(self.dataset)
            self.results.append(result)
            self._print_result(result)

        # --- Export ---------------------------------------------------------
        if self.results:
            console.print("\n[cyan]Exporting...[/cyan]")
            self._run_export()

        # --- Report (Forge-5) -----------------------------------------------
        console.print("\n[yellow]Report[/yellow]  [dim](Forge-5)[/dim]")

        console.print("\n[green]Done.[/green]")

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _print_result(self, result: DetectionResult) -> None:
        table = Table(show_header=True, header_style="bold")
        table.add_column("Detector")
        table.add_column("Detected anomalies")
        table.add_column("Anomaly rate")
        table.add_column("Threshold")
        table.add_row(
            result.detector_name,
            str(result.n_anomalies),
            f"{result.anomaly_rate:.1%}",
            f"{result.threshold:.2f}",
        )
        console.print(table)

        # Precision / recall if ground truth available
        if self.dataset and self.dataset.labels is not None:
            gt = self.dataset.labels
            pred = result.labels
            tp = int(((pred == 1) & (gt == 1)).sum())
            fp = int(((pred == 1) & (gt == 0)).sum())
            fn = int(((pred == 0) & (gt == 1)).sum())
            precision = tp / (tp + fp) if (tp + fp) > 0 else 0.0
            recall = tp / (tp + fn) if (tp + fn) > 0 else 0.0
            console.print(
                f"  vs ground truth: precision={precision:.2f}  "
                f"recall={recall:.2f}  "
                f"TP={tp} FP={fp} FN={fn}"
            )

    def _run_export(self) -> None:
        output_dir = self.config.export.output_dir
        targets = set(self.config.export.targets)

        for detector, result in zip(self.detectors, self.results):
            if targets & {ExportTarget.c_header, ExportTarget.json_config, ExportTarget.tflite_micro}:
                written = detector.export(
                    Path(output_dir),
                    stem=self.config.name,
                    quantization=self.config.export.quantization,
                )
                for p in written:
                    console.print(f"  Wrote: {p}")
