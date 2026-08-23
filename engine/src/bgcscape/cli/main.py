"""BGC-scape engine CLI."""
from __future__ import annotations

import json
from pathlib import Path

import typer

import bgcscape.models as models  # noqa: F401 - ensures all models are registered before any table op
from bgcscape import __version__
from bgcscape.db.session import get_engine, session_scope
from bgcscape.ingest._util import IngestReport
from bgcscape.ingest.gtdb import ingest_gtdb_metadata, read_gtdb_metadata_tsv
from bgcscape.ingest.mibig import ingest_mibig_entries, read_mibig_entries_from_path
from bgcscape.models import Source, SourceType

app = typer.Typer(help="BGC-scape scientific engine CLI.")
ingest_app = typer.Typer(help="Ingest curated reference datasets (MIBiG, GTDB).")
app.add_typer(ingest_app, name="ingest")


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


def _get_or_create_source(session, *, name: str, source_type: SourceType, version: str | None) -> Source:
    """Shared by both ingest subcommands: find-or-create the Source row that
    every ingested record from this run will point back to, keyed on
    (name, version) so re-running against the same release reuses one row.
    """
    query = session.query(Source).filter_by(name=name, version=version)
    source = query.one_or_none()
    if source is not None:
        return source
    source = Source(name=name, source_type=source_type, version=version)
    session.add(source)
    session.commit()
    return source


def _echo_report(report: IngestReport) -> None:
    typer.echo(f"Done: {report}")
    if report.errors:
        typer.echo("Errors:")
        for identifier, message in report.errors[:20]:
            typer.echo(f"  {identifier}: {message}")
        if len(report.errors) > 20:
            typer.echo(f"  ... and {len(report.errors) - 20} more")


@ingest_app.command("mibig")
def ingest_mibig_cmd(
    path: Path = typer.Argument(..., help="A single MIBiG entry .json file, or a directory of them."),
    version: str = typer.Option("4.0", help="MIBiG version label to record on the Source row."),
    include_non_active: bool = typer.Option(
        False, help="Also load retired/pending/embargoed entries (skipped by default)."
    ),
) -> None:
    """Ingest MIBiG BGC entries from a JSON file or directory of them."""
    with session_scope() as session:
        source = _get_or_create_source(session, name="MIBiG", source_type=SourceType.REFERENCE_DATABASE, version=version)
        entries = read_mibig_entries_from_path(path)
        report = ingest_mibig_entries(session, source, entries, include_non_active=include_non_active)
    _echo_report(report)


@ingest_app.command("gtdb")
def ingest_gtdb_cmd(
    path: Path = typer.Argument(..., help="A GTDB *_metadata.tsv file (bac120_metadata.tsv or ar53_metadata.tsv)."),
    version: str = typer.Option("R11-RS232", help="GTDB release label to record on the Source row."),
) -> None:
    """Ingest genomes + taxonomy from a GTDB metadata TSV."""
    with session_scope() as session:
        source = _get_or_create_source(session, name="GTDB", source_type=SourceType.REFERENCE_DATABASE, version=version)
        rows = read_gtdb_metadata_tsv(path)
        report = ingest_gtdb_metadata(session, source, rows)
    _echo_report(report)


@app.command("dump-openapi-schema")
def dump_openapi_schema(
    output: Path = typer.Option(Path("openapi.json"), help="Where to write the OpenAPI schema JSON."),
) -> None:
    """Dump the API's OpenAPI schema to a file, for `openapi-typescript`
    (see web/package.json's `generate-api-types` script) to regenerate the
    frontend's TypeScript types from. Requires the `api` extra
    (`pip install -e ".[api]"`) — imported lazily here, not at module
    level, so every other CLI command keeps working without it installed.
    """
    try:
        from bgcscape.api.app import app as fastapi_app
    except ImportError as exc:
        typer.echo(f"This command needs the 'api' extra: pip install -e '.[api]' ({exc})", err=True)
        raise typer.Exit(1) from exc

    output.write_text(json.dumps(fastapi_app.openapi(), indent=2))
    typer.echo(f"Wrote OpenAPI schema to {output}")


if __name__ == "__main__":
    app()
