"""
Pipeline runner â€” orchestrates data loading, training, evaluation, and export.
Concrete implementations are added in Forge-2 through Forge-5.
"""

from __future__ import annotations

from pathlib import Path

from rich.console import Console

from forge.config import PipelineConfig

console = Console()


class Pipeline:
    def __init__(self, config: PipelineConfig) -> None:
        self.config = config

    @classmethod
    def from_yaml(cls, path: str | Path) -> Pipeline:
        return cls(PipelineConfig.from_yaml(path))

    def run(self) -> None:
        console.rule(f"[bold blue]Fovet Forge â€” {self.config.name}")
        console.print(f"[dim]{self.config.description}[/dim]\n")

        console.print("[yellow]â–º Data loading[/yellow]      [dim](Forge-2)[/dim]")
        console.print("[yellow]â–º Training detectors[/yellow] [dim](Forge-3)[/dim]")
        console.print("[yellow]â–º Evaluation[/yellow]         [dim](Forge-5)[/dim]")
        console.print("[yellow]â–º Export[/yellow]             [dim](Forge-4)[/dim]")
        console.print("[yellow]â–º Report[/yellow]             [dim](Forge-5)[/dim]")

        console.print("\n[green]âœ“ Scaffold OK â€” pipeline sessions Forge-2..5 Ã  implÃ©menter.[/green]")

