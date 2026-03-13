"""
Pipeline runner -- orchestrates data loading, training, evaluation, and export.
"""

from __future__ import annotations

from pathlib import Path

from rich.console import Console

from forge.config import PipelineConfig
from forge.data import Dataset, load_data

console = Console()


class Pipeline:
    def __init__(self, config: PipelineConfig) -> None:
        self.config = config
        self.dataset: Dataset | None = None

    @classmethod
    def from_yaml(cls, path: str | Path) -> Pipeline:
        return cls(PipelineConfig.from_yaml(path))

    def run(self) -> None:
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

        # --- Detectors (Forge-3) --------------------------------------------
        console.print("\n[yellow]Training detectors[/yellow]  [dim](Forge-3)[/dim]")

        # --- Export (Forge-4) -----------------------------------------------
        console.print("[yellow]Export[/yellow]               [dim](Forge-4)[/dim]")

        # --- Report (Forge-5) -----------------------------------------------
        console.print("[yellow]Report[/yellow]               [dim](Forge-5)[/dim]")

        console.print("\n[green]Forge-2 OK -- data layer operational.[/green]")
