"""BGC-scape engine CLI.

Deliberately small in this chunk — `bgcscape ingest mibig`, `bgcscape
ingest gtdb`, etc. land in Phase 1b alongside the ingestion code they front.
"""
from __future__ import annotations

import typer

import bgcscape.models as models  # noqa: F401 - ensures all models are registered before any table op
from bgcscape import __version__
from bgcscape.db.session import get_engine

app = typer.Typer(help="BGC-scape scientific engine CLI.")


@app.callback(invoke_without_command=True)
def main(
    version: bool = typer.Option(False, "--version", help="Show the BGC-scape engine version and exit."),
) -> None:
    # invoke_without_command=True so `bgcscape --version` works standalone,
    # without also requiring a subcommand on the same invocation.
    if version:
        typer.echo(f"bgcscape {__version__}")
        raise typer.Exit()


@app.command("init-db")
def init_db() -> None:
    """Create all tables for the configured database.

    Convenience for local dev/test setup only — production schema changes
    should go through Alembic migrations (`alembic upgrade head`) instead,
    so they're tracked, reviewable, and reversible.
    """
    engine = get_engine()
    models.Base.metadata.create_all(engine)
    typer.echo(f"Initialized schema at {engine.url}")


if __name__ == "__main__":
    app()
