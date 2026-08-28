"""BGC-scape engine CLI."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import typer

import bgcscape.models as models  # noqa: F401 - ensures all models are registered before any table op
from bgcscape import __version__
from bgcscape.db.session import get_engine, session_scope
from bgcscape.ingest._util import IngestReport
from bgcscape.ingest.antismash import ingest_antismash_result, read_antismash_result
from bgcscape.ingest.bigscape import (
    ingest_bigscape_clustering,
    parse_cutoff_from_filename,
    read_bigscape_clustering_tsv,
)
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


#: Licensing/attribution metadata for the sources BGC-scape ingests, kept in
#: lockstep with docs/DATA_SOURCES.md. This is not decoration: GTDB ships
#: under CC BY-SA 4.0, a ShareAlike licence that obliges any derived view —
#: including an exported figure — to carry attribution. Leaving these null
#: (as every shipped build did until now) means the publication artifact
#: makes no attribution at all. Keyed by Source.name.
SOURCE_METADATA: dict[str, dict[str, str]] = {
    "GTDB": {
        "url": "https://gtdb.ecogenomic.org/",
        "license": "CC BY-SA 4.0",
        "citation": (
            "Parks DH et al. GTDB: an ongoing census of bacterial and archaeal diversity "
            "through a phylogenetically consistent, rank normalized and complete "
            "genome-based taxonomy. Nucleic Acids Research."
        ),
    },
    "MIBiG": {
        "url": "https://mibig.secondarymetabolites.org/",
        "license": "Open access (no restriction on academic or commercial use)",
        "citation": (
            "Terlouw BR et al. MIBiG: the Minimum Information about a Biosynthetic Gene "
            "cluster repository. Nucleic Acids Research."
        ),
    },
    "antiSMASH": {
        "url": "https://antismash.secondarymetabolites.org/",
        "license": "AGPL-3.0 (tool); predictions stored as derived output",
        "citation": "Blin K et al. antiSMASH: rapid genome-wide identification of biosynthetic gene clusters.",
    },
    "BiG-SCAPE": {
        "url": "https://bigscape-corason.secondarymetabolites.org/",
        "license": "AGPL-3.0 (tool); family assignments stored as derived output",
        "citation": "Navarro-Munoz JC et al. A computational framework for systematic exploration of biosynthetic diversity.",
    },
    "MIBiG shared compound": {
        "url": "https://mibig.secondarymetabolites.org/",
        "license": "Derived from MIBiG compound annotations (open access)",
        "citation": (
            "Derived by BGC-scape: clusters grouped by identical MIBiG compound name. "
            "Not a sequence clustering."
        ),
    },
}


def _get_or_create_source(
    session,
    *,
    name: str,
    source_type: SourceType,
    version: str | None,
    retrieved_at: datetime | None = None,
) -> Source:
    """Shared by both ingest subcommands: find-or-create the Source row that
    every ingested record from this run will point back to, keyed on
    (name, version) so re-running against the same release reuses one row.

    Also stamps licence/citation/url from `SOURCE_METADATA` and records when
    the data was retrieved, so provenance survives into exported figures.
    Existing rows are backfilled, which is what upgrades a database built
    before this metadata was populated.
    """
    metadata = SOURCE_METADATA.get(name, {})
    query = session.query(Source).filter_by(name=name, version=version)
    source = query.one_or_none()
    if source is None:
        source = Source(name=name, source_type=source_type, version=version)
        session.add(source)
    # Backfill rather than only-on-create: a database written by an older
    # build has these null, and re-ingesting is how it gets repaired.
    if source.source_type != source_type:
        source.source_type = source_type
    for attr in ("url", "license", "citation"):
        if metadata.get(attr) and not getattr(source, attr):
            setattr(source, attr, metadata[attr])
    if source.retrieved_at is None:
        source.retrieved_at = retrieved_at or datetime.now(timezone.utc)
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


@ingest_app.command("antismash")
def ingest_antismash_cmd(
    path: Path = typer.Argument(..., help="An antiSMASH result JSON file (the whole-run output)."),
    genome_accession: str = typer.Option(
        ...,
        help=(
            "The genome accession this antiSMASH run was performed on. Required, and deliberately "
            "not guessed: antiSMASH's JSON has no assembly-accession field at all (its output is "
            "organized per-run, not per-assembly), so only the caller knows this."
        ),
    ),
    version: str = typer.Option("7.1.0", help="antiSMASH version label to record on the Source row."),
) -> None:
    """Ingest predicted BGC regions from an antiSMASH result JSON."""
    with session_scope() as session:
        source = _get_or_create_source(
            session, name="antiSMASH", source_type=SourceType.TOOL_RUN, version=version
        )
        raw = read_antismash_result(path)
        report = ingest_antismash_result(session, source, raw, genome_accession=genome_accession)
    _echo_report(report)


@ingest_app.command("upload")
def ingest_upload_cmd(
    path: Path = typer.Argument(..., help="An antiSMASH result JSON for the user's own genome/MAG."),
    genome_accession: str = typer.Option(..., help="An identifier for this genome (any stable string)."),
    label: str = typer.Option("user upload", help="A label recorded on the Source row for this upload."),
    is_mag: bool = typer.Option(False, help="Mark this genome as metagenome-assembled."),
) -> None:
    """Ingest a user's own genome/MAG from its antiSMASH output (Phase 5).

    Uses SourceType.USER_UPLOAD rather than TOOL_RUN so user-contributed
    data is distinguishable from curated reference data at query time —
    the whole point of the provenance model. Everything ingested this way
    is PREDICTED, never OBSERVED_CURATED.
    """
    with session_scope() as session:
        source = _get_or_create_source(
            session, name=label, source_type=SourceType.USER_UPLOAD, version=None
        )
        raw = read_antismash_result(path)
        report = ingest_antismash_result(session, source, raw, genome_accession=genome_accession)

        if is_mag:
            from bgcscape.models import Genome

            genome = session.query(Genome).filter_by(accession=genome_accession).one_or_none()
            if genome is not None:
                genome.is_mag = True
                session.commit()

    _echo_report(report)


@ingest_app.command("bigscape")
def ingest_bigscape_cmd(
    path: Path = typer.Argument(..., help="A BiG-SCAPE *_clustering_c{cutoff}.tsv file."),
    cutoff: float = typer.Option(
        None,
        help=(
            "Similarity cutoff this clustering was run at. Inferred from the filename "
            "(BiG-SCAPE's own '..._clustering_c0.3.tsv' convention) when omitted. Required, "
            "because a family label is only meaningful within a single cutoff."
        ),
    ),
    version: str = typer.Option("2.0.0", help="BiG-SCAPE version label to record on the Source row."),
) -> None:
    """Ingest BGC family assignments from a BiG-SCAPE clustering TSV.

    Requires the referenced BGCs to already exist (via `bgcscape ingest
    antismash`) — rows that don't match a known BGC are counted as
    skipped, which is expected when the BiG-SCAPE run included MIBiG
    reference clusters for comparison.
    """
    resolved_cutoff = cutoff if cutoff is not None else parse_cutoff_from_filename(path)
    if resolved_cutoff is None:
        typer.echo(
            f"Couldn't infer a cutoff from filename '{path.name}' — pass --cutoff explicitly.",
            err=True,
        )
        raise typer.Exit(1)

    with session_scope() as session:
        source = _get_or_create_source(
            session, name="BiG-SCAPE", source_type=SourceType.TOOL_RUN, version=version
        )
        rows = read_bigscape_clustering_tsv(path)
        report = ingest_bigscape_clustering(
            session, source, rows, cutoff=resolved_cutoff, clustering_method=f"BiG-SCAPE {version}"
        )
    typer.echo(f"Cutoff: {resolved_cutoff}")
    _echo_report(report)
    if report.skipped:
        typer.echo(
            f"  ({report.skipped} row(s) referenced a BGC not in the database — expected if "
            "antiSMASH or MIBiG ingestion hasn't run for those records yet. MIBiG reference "
            "clusters DO match, via their accession.)"
        )


@app.command("group-by-compound")
def group_by_compound_cmd(
    min_members: int = typer.Option(
        2, help="Minimum clusters sharing a compound before it forms a group."
    ),
) -> None:
    """Group clusters that MIBiG records as making the same compound.

    This is NOT a BiG-SCAPE gene cluster family — no sequences are compared.
    It groups on a curated experimental fact (two clusters produce the same
    named molecule), which is enough to answer "where is this pathway across
    the tree" from MIBiG alone. Groups are labelled `CMPD_*` and carry
    clustering_method "MIBiG shared compound" so they can never be mistaken
    for a sequence-based family. Run `ingest bigscape` for real GCFs.

    Idempotent.
    """
    from bgcscape.ingest.compound_groups import CLUSTERING_METHOD, group_by_compound

    with session_scope() as session:
        source = _get_or_create_source(
            session,
            # TOOL_RUN, not REFERENCE_DATABASE: this grouping is DERIVED by
            # BGC-scape from MIBiG's compound annotations. MIBiG is the
            # reference database; this is what we computed from it. The
            # distinction is the whole point of the provenance model, and it
            # travels into every exported figure.
            name=CLUSTERING_METHOD,
            source_type=SourceType.TOOL_RUN,
            version=None,
        )
        report = group_by_compound(session, source, min_members=min_members)

    typer.echo(
        f"Created {report.groups_created} compound group(s), updated {report.groups_updated}; "
        f"{report.memberships} new membership(s) across {report.clusters_grouped} cluster(s)."
    )
    typer.echo(
        f"  ({report.singletons_skipped} compound(s) are made by a single cluster and were "
        "skipped — a group of one says nothing about distribution.)"
    )
    for example in report.examples:
        typer.echo(f"    {example}")


@app.command("link-mibig")
def link_mibig_cmd(
    mapping_path: Path = typer.Argument(
        ..., help="A mibig_accession/gtdb_accession/match_method TSV from scripts/build_gtdb_subset.py."
    ),
    keep_locus_stubs: bool = typer.Option(
        False,
        help=(
            "Keep the MIBiG locus Genome rows left empty after linking. Off by default: they "
            "carry no cluster once linked, are never drawn, and would inflate the genome counts "
            "the UI reports. The locus accession is preserved on BGC.contig either way."
        ),
    ),
) -> None:
    """Attach MIBiG clusters to the GTDB genome of the same organism.

    Run after `ingest gtdb` + `ingest mibig`. Matched on NCBI taxid (falling
    back to species name) by scripts/build_gtdb_subset.py, which writes the
    mapping this command consumes. Records how each cluster was placed, so
    an exact-taxid match is distinguishable from a name match downstream.
    Idempotent.
    """
    from bgcscape.ingest.link import link_mibig_to_gtdb, read_mapping

    mapping = read_mapping(mapping_path)
    typer.echo(f"Read {len(mapping)} mappings from {mapping_path}")
    with session_scope() as session:
        report = link_mibig_to_gtdb(session, mapping, prune_unlinked=not keep_locus_stubs)

    typer.echo(
        f"Linked {report.linked} cluster(s) to a GTDB genome "
        f"({report.already_linked} already linked)."
    )
    if report.pruned_genomes or report.pruned_taxa:
        typer.echo(
            f"  Removed {report.pruned_genomes} empty MIBiG locus row(s) and "
            f"{report.pruned_taxa} now-empty species node(s)."
        )
    if report.missing_bgc:
        typer.echo(f"  {report.missing_bgc} mapping(s) referenced a MIBiG entry not in the database.")
    if report.missing_genome:
        typer.echo(
            f"  {report.missing_genome} mapping(s) referenced a GTDB genome not in the database "
            "(is the subset TSV the one this mapping was built from?)"
        )
        for example in report.missing_examples:
            typer.echo(f"    {example}")


@app.command("graft-taxonomy")
def graft_taxonomy() -> None:
    """Attach parent-less species (typically from MIBiG) to their GTDB genus.

    MIBiG entries carry only an organism name, so they ingest as root-level
    orphan species. Run this after `ingest gtdb` + `ingest mibig` to map
    them onto the GTDB tree by genus name. Nomenclatural, not phylogenetic;
    organisms whose genus isn't in GTDB's bacterial taxonomy (fungi,
    plants) are left unparented on purpose. Idempotent.
    """
    from bgcscape.ingest.graft import graft_orphan_species

    with session_scope() as session:
        report = graft_orphan_species(session)
    typer.echo(
        f"Grafted {report.grafted} species onto a GTDB genus "
        f"({report.already_placed} already placed, {report.unmatched} unmatched)."
    )
    if report.unmatched_examples:
        typer.echo("Unmatched (left unparented — genus not in GTDB bacterial taxonomy):")
        for name in report.unmatched_examples:
            typer.echo(f"  {name}")
        if report.unmatched > len(report.unmatched_examples):
            typer.echo(f"  ... and {report.unmatched - len(report.unmatched_examples)} more")


@app.command("seed-demo")
def seed_demo(
    genomes: int = typer.Option(80, help="How many synthetic genomes to generate."),
    seed: int = typer.Option(20260825, help="RNG seed — the same seed yields an identical corpus."),
    force: bool = typer.Option(False, help="Proceed even if the database already contains data."),
) -> None:
    """Generate a synthetic corpus for evaluating the interface at scale.

    THE DATA IS FABRICATED. Taxon names are transparently fictional,
    accessions use a SYN_ prefix, and every row carries
    evidence_level=HYPOTHESIZED with a source named "SYNTHETIC DEMO DATA
    (not real)" — so it announces itself in the API, in figure captions,
    and in `bgcscape inspect-figure`. No conclusion drawn from it means
    anything.

    Intended for a database of its own, not mixed into real data.
    """
    from bgcscape.demo import generate_demo_corpus
    from bgcscape.models import Genome as GenomeModel

    with session_scope() as session:
        existing = session.query(GenomeModel).count()
        if existing and not force:
            typer.echo(
                f"This database already holds {existing} genome(s). Seeding synthetic data into a "
                "database with real data would mix fabricated rows into it. Use a separate database, "
                "or pass --force if you're sure.",
                err=True,
            )
            raise typer.Exit(1)

        counts = generate_demo_corpus(session, genome_count=genomes, seed=seed)

    typer.echo("Generated SYNTHETIC demo corpus (fabricated data — do not cite):")
    for key, value in counts.items():
        typer.echo(f"    {key}: {value}")


@app.command("prioritize")
def prioritize_cmd(
    limit: int = typer.Option(20, help="How many candidates to list."),
    show_components: bool = typer.Option(False, help="Show the per-component breakdown for each candidate."),
) -> None:
    """Rank BGCs as candidates for experimental follow-up.

    This is a PRIORITIZATION hint, not a novelty measurement. The caveats
    printed below the table are part of the output, not decoration — see
    bgcscape/scoring/prioritization.py.
    """
    from bgcscape.models import BGC
    from bgcscape.scoring import rank_bgcs

    with session_scope() as session:
        ranked = rank_bgcs(session, limit=limit)
        if not ranked:
            typer.echo("No BGCs in the database to rank.")
            return

        bgcs = {b.id: b for b in session.query(BGC).all()}
        typer.echo(f"{'rank':<6}{'score':<9}{'class':<12}{'genome':<26}components")
        typer.echo("-" * 78)
        for index, entry in enumerate(ranked, start=1):
            bgc = bgcs.get(entry.bgc_id)
            if bgc is None:
                continue
            score = "n/a" if entry.score is None else f"{entry.score:.3f}"
            note = f"{entry.available_component_count}/{len(entry.components)} available"
            typer.echo(f"{index:<6}{score:<9}{bgc.bgc_class.value:<12}{bgc.genome.accession:<26}{note}")
            if show_components:
                for component in entry.components:
                    value = "unavailable" if component.value is None else f"{component.value:.2f}"
                    typer.echo(f"        {component.name:<24}{value:<14}{component.explanation}")

        typer.echo("")
        typer.echo("How to read this:")
        for caveat in ranked[0].caveats:
            typer.echo(f"  · {caveat}")


@app.command("inspect-figure")
def inspect_figure(
    path: Path = typer.Argument(..., help="An SVG previously exported by BGC-scape."),
) -> None:
    """Report what produced a figure — the payoff for embedding the view
    config in exported SVGs. Given a figure attached to a paper, this
    answers "which data versions and filters made this?" without needing
    the original session.
    """
    from bgcscape.export import extract_view_config

    config = extract_view_config(path.read_text(encoding="utf-8"))
    if config is None:
        typer.echo(f"{path.name} carries no BGC-scape view config (not exported by this tool).", err=True)
        raise typer.Exit(1)

    typer.echo(f"Title:          {config.title or '(untitled)'}")
    typer.echo(f"View type:      {config.view_type}")
    typer.echo(f"Config version: {config.config_version}")
    typer.echo(f"Exported:       {config.dataset.exported_at.isoformat()}")
    typer.echo(f"Engine:         BGC-scape {config.dataset.engine_version}")
    typer.echo("Dataset:")
    typer.echo(f"    {config.dataset.genome_count} genomes, {config.dataset.bgc_count} BGCs, "
               f"{config.dataset.taxon_count} taxa, {config.dataset.family_count} families")
    typer.echo("Sources:")
    for source in config.dataset.sources:
        version = f" {source.version}" if source.version else ""
        license_note = f"  [{source.license}]" if source.license else ""
        typer.echo(f"    {source.name}{version} ({source.source_type}){license_note}")
    state = config.tree_state
    typer.echo("View state:")
    typer.echo(f"    BGC class filter: {', '.join(state.active_bgc_classes) or '(none — all classes shown)'}")
    typer.echo(f"    Collapsed nodes:  {len(state.collapsed_node_ids)}")
    if state.selected_family_id:
        typer.echo(f"    Highlighted family: {state.selected_family_id}")
    if state.comparison_taxon_ids:
        typer.echo(f"    Compared clades:  {len(state.comparison_taxon_ids)}")
    if state.search_query:
        typer.echo(f"    Search query:     {state.search_query!r}")


@app.command("render-figure")
def render_figure(
    svg_path: Path = typer.Argument(..., help="An SVG exported by BGC-scape (carrying its view config)."),
    output: Path = typer.Option(Path("figure.pdf"), help="Where to write the PDF."),
) -> None:
    """Re-render an exported SVG to vector PDF, headlessly.

    Uses the config already embedded in the SVG, so a figure can be
    regenerated from the file alone — no running database or browser
    session needed. Requires the `export` extra.
    """
    from bgcscape.export import SvgRenderError, extract_view_config, render_pdf

    svg = svg_path.read_text(encoding="utf-8")
    config = extract_view_config(svg)
    if config is None:
        typer.echo(f"{svg_path.name} carries no BGC-scape view config; rendering it as plain SVG.", err=True)

    try:
        output.write_bytes(render_pdf(svg))
    except SvgRenderError as exc:
        typer.echo(str(exc), err=True)
        raise typer.Exit(1) from exc
    typer.echo(f"Wrote {output} ({output.stat().st_size} bytes)")


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
