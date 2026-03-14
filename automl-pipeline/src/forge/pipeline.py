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
from forge.evaluation import compute_metrics, EvaluationMetrics
from forge.report import generate_report

console = Console()


class Pipeline:
    def __init__(self, config: PipelineConfig) -> None:
        self.config = config
        self.dataset: Dataset | None = None
        self.train_dataset: Dataset | None = None
        self.test_dataset: Dataset | None = None
        self.detectors: list[Detector] = []
        self.results: list[DetectionResult] = []
        self.metrics: list[EvaluationMetrics] = []

    @classmethod
    def from_yaml(cls, path: str | Path) -> "Pipeline":
        """Load a pipeline from a YAML config file."""
        return cls(PipelineConfig.from_yaml(path))

    def run(self) -> None:
        """Execute the full pipeline: load data → split → fit → predict → export → report."""
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

        # --- Train / test split ---------------------------------------------
        split_cfg = self.config.split
        if split_cfg.enabled:
            self.train_dataset, self.test_dataset = self.dataset.split(
                test_ratio=split_cfg.test_ratio,
                random_state=split_cfg.random_state,
            )
            console.print(
                f"\n[cyan]Train/test split[/cyan]  "
                f"train={self.train_dataset.n_samples}  "
                f"test={self.test_dataset.n_samples}  "
                f"(test_ratio={split_cfg.test_ratio:.0%})"
            )
        else:
            self.train_dataset = self.dataset
            self.test_dataset = self.dataset

        # --- Detectors ------------------------------------------------------
        console.print("\n[cyan]Training detectors...[/cyan]")
        self.detectors = build_detectors(self.config.detectors)
        self.results = []
        self.metrics = []

        for detector in self.detectors:
            detector.fit(self.train_dataset)
            result = detector.predict(self.test_dataset)
            self.results.append(result)

            m = compute_metrics(result, ground_truth=self.test_dataset.labels)
            self.metrics.append(m)
            self._print_result(result, m)

        # --- Export ---------------------------------------------------------
        if self.results:
            console.print("\n[cyan]Exporting...[/cyan]")
            self._run_export()

        # --- Report ---------------------------------------------------------
        if self.config.report.enabled and self.metrics:
            console.print("\n[cyan]Report...[/cyan]")
            report_path = generate_report(
                config=self.config,
                metrics=self.metrics,
                train_n=self.train_dataset.n_samples,
                test_n=self.test_dataset.n_samples,
                output_dir=Path(self.config.report.output_dir),
            )
            console.print(f"  Wrote: {report_path}")

        console.print("\n[green]Done.[/green]")

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _print_result(self, result: DetectionResult, m: EvaluationMetrics) -> None:
        """Print a Rich table summarising one detector's results."""
        table = Table(show_header=True, header_style="bold")
        table.add_column("Detector")
        table.add_column("Anomalies")
        table.add_column("Rate")
        table.add_column("Threshold")
        table.add_row(
            result.detector_name,
            str(result.n_anomalies),
            f"{result.anomaly_rate:.1%}",
            f"{result.threshold:.4f}",
        )
        console.print(table)

        if m.has_ground_truth:
            console.print(
                f"  precision={m.precision:.2f}  recall={m.recall:.2f}  "
                f"f1={m.f1:.2f}  TP={m.tp}  FP={m.fp}  FN={m.fn}"
            )

    def _run_export(self) -> None:
        """Write detector artifacts to the configured output directory."""
        output_dir = self.config.export.output_dir
        targets = set(self.config.export.targets)

        for detector in self.detectors:
            if targets & {ExportTarget.c_header, ExportTarget.json_config, ExportTarget.tflite_micro}:
                written = detector.export(
                    Path(output_dir),
                    stem=self.config.name,
                    quantization=self.config.export.quantization,
                )
                for p in written:
                    console.print(f"  Wrote: {p}")
