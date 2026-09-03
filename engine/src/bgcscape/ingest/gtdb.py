"""GTDB (Genome Taxonomy Database) taxonomy/metadata ingestion.

Targets GTDB's metadata TSV format (`bac120_metadata.tsv` /
`ar53_metadata.tsv`), read by column **name** via `csv.DictReader` rather
than positional index, so column reordering across GTDB releases doesn't
silently corrupt parsing.

Column names below were cross-checked against real GTDB-Tk-ecosystem
tooling on GitHub (`Ecogenomics/GTDBTk`, and an nf-core pipeline that
documents the exact metadata columns it expects) — see
docs/DATA_SOURCES.md for the trail. Confirmed with reasonable confidence:
`gtdb_taxonomy`, `gtdb_genome_representative`, `checkm_completeness`,
`checkm_contamination`, `genome_size`. `gtdb_genome_representative` is
additionally confirmed against the r232 files on disk: every one of the
991 assembly accessions in this project's GTDB subset has a value there,
and every one of those values is a tip label present in `bac120.tree` or
`ar53.tree` (651 rows name themselves, 340 name another genome, 0 name
something absent from both trees). That column is what makes the tree-tip
join total — see `Genome.gtdb_tip_accession`. Lower confidence, flagged in code:
the exact GC-content and NCBI-assembly-level column names — verify against
the real downloaded header before a production run and adjust
`_GC_COLUMNS`/`_ASSEMBLY_LEVEL_COLUMN` below if needed.

GTDB's taxonomy is itself the output of a rigorous, curated phylogenomic
pipeline over GTDB's *own reference genome set* — this ingestion path is
for exactly that reference set (the metadata TSV GTDB publishes per
release), so rows get `evidence_level = OBSERVED_CURATED`, matching the
"GTDB type-strain taxonomy assignment" example already named in
`EvidenceLevel`'s own docstring (models/base.py). A *new* genome being
placed against GTDB by a user's own GTDB-Tk run is a different situation
(an automated placement of something outside the curated set) and should
be ingested as `PREDICTED` — that's a separate, not-yet-built ingestion
path (Phase 5, user uploads), not this one.

Two-stage design matching ingest/mibig.py: parse_gtdb_metadata_row() (pure)
+ load_gtdb_genome() (DB), orchestrated by ingest_gtdb_metadata().
"""
from __future__ import annotations

import csv
import gzip
import re
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy.orm import Session

from bgcscape.ingest._util import IngestReport, get_or_create_or_update
from bgcscape.ingest.accession import strip_gtdb_prefix
from bgcscape.models import EvidenceLevel, Genome, Source, Taxon, TaxonRank
from bgcscape.models.genome import AssemblyLevel
from bgcscape.schemas import GenomeCreate, TaxonCreate

_ACCESSION_COLUMNS = ("accession", "accno")
_GC_COLUMNS = ("gc_percentage", "gc_percent")  # lower confidence, see module docstring
_ASSEMBLY_LEVEL_COLUMN = "ncbi_assembly_level"  # lower confidence, see module docstring
_EMPTY_VALUES = {"", "none", "n/a", "null", "na"}

_NCBI_ASSEMBLY_LEVEL_MAP: dict[str, AssemblyLevel] = {
    "Complete Genome": AssemblyLevel.COMPLETE_GENOME,
    "Chromosome": AssemblyLevel.CHROMOSOME,
    "Scaffold": AssemblyLevel.SCAFFOLD,
    "Contig": AssemblyLevel.CONTIG,
}

#: GTDB's own NCBI-lineage column, in the same `d__;p__;...` shape as
#: `gtdb_taxonomy`. Present in the bac120/ar53 metadata TSVs; absent from a
#: hand-made subset, in which case the comparison simply is not made.
_NCBI_TAXONOMY_COLUMN = "ncbi_taxonomy"

#: Phyla the two databases spell differently but circumscribe the same way.
#: Keyed by normalised name, both directions mapping to one canonical form,
#: so a spelling difference is not reported as a disagreement about content.
#: Kept deliberately tiny: an entry belongs here only when the two names are
#: documented synonyms, never to silence a conflict that is real.
_PHYLUM_SYNONYMS: dict[str, str] = {
    # GTDB kept "Tectomicrobia"; NCBI adopted the later "Candidatus
    # Tectimicrobiota". Same clade — Entotheonella and its relatives.
    "tectomicrobia": "tectomicrobia",
    "tectimicrobiota": "tectomicrobia",
}

_RANK_PREFIXES: dict[str, TaxonRank] = {
    "d__": TaxonRank.DOMAIN,
    "p__": TaxonRank.PHYLUM,
    "c__": TaxonRank.CLASS,
    "o__": TaxonRank.ORDER,
    "f__": TaxonRank.FAMILY,
    "g__": TaxonRank.GENUS,
    "s__": TaxonRank.SPECIES,
}


class GtdbParseError(ValueError):
    """The row is structurally invalid for Phylo-BGC's model (no usable
    accession, or no gtdb_taxonomy column at all)."""


def normalize_gtdb_accession(raw_accession: str) -> str:
    """Strip GTDB's RS_/GB_ provenance prefix: "RS_GCF_000203835.1" ->
    "GCF_000203835.1", matching the bare NCBI assembly accession so it can
    be cross-referenced against other NCBI-derived data later.

    Delegates to `ingest/accession.py`, which owns every cross-source
    accession rule in this project. Kept as a named re-export because this
    is the spelling GTDB ingestion and its tests already use.
    """
    return strip_gtdb_prefix(raw_accession)


def parse_gtdb_taxonomy_string(taxonomy_string: str) -> list[tuple[TaxonRank, str]]:
    """"d__Bacteria;p__...;s__..." -> [(DOMAIN, "Bacteria"), ...]. Ranks
    left empty (e.g. no "s__" species assignment for a low-quality MAG) are
    skipped rather than producing a Taxon with an empty name."""
    result: list[tuple[TaxonRank, str]] = []
    for token in taxonomy_string.split(";"):
        token = token.strip()
        rank = _RANK_PREFIXES.get(token[:3])
        name = token[3:].strip()
        if rank and name:
            result.append((rank, name))
    return result


def phylum_of(taxonomy_string: str | None) -> str | None:
    """The `p__` token of a `d__…;p__…;…` lineage string, or None."""
    if not taxonomy_string:
        return None
    for token in taxonomy_string.split(";"):
        token = token.strip()
        if token.startswith("p__") and token[3:].strip():
            return token[3:].strip()
    return None


def _normalize_phylum(name: str) -> str:
    """Reduce a phylum name to what the two databases can be compared on.

    GTDB appends a suffix when it splits a taxon it judges polyphyletic
    (`Myxococcota_A`, `Bacillota_I`). The suffixed group is still inside the
    phylum NCBI names, so the suffix is stripped: a split is a difference of
    resolution, not of placement, and treating it as a conflict would flag
    41 perfectly correct placements in the shipped corpus alone.
    """
    cleaned = re.sub(r"_[A-Z]+$", "", name.strip())
    cleaned = re.sub(r"^Candidatus\s+", "", cleaned, flags=re.IGNORECASE).strip().lower()
    return _PHYLUM_SYNONYMS.get(cleaned, cleaned)


def taxonomies_conflict(
    gtdb_taxonomy: str | None, ncbi_taxonomy: str | None
) -> bool | None:
    """Whether GTDB and NCBI assign this assembly to different phyla.

    Returns None — not False — when either side has no phylum to compare.
    "Nobody could ask" and "asked, and they agree" are different states, and
    collapsing them would be the same mistake `is_mag` was fixed for.

    The comparison is deliberately coarse. At phylum rank a disagreement is
    never nomenclatural drift; it means one of the two databases has the
    assembly in the wrong part of the tree of life, and in practice that is
    a submitter-supplied NCBI label on a metagenome-assembled genome. Genus
    and species disagreements are routine (GTDB reclassifies constantly) and
    are correctly NOT flagged here.
    """
    gtdb_phylum = phylum_of(gtdb_taxonomy)
    ncbi_phylum = phylum_of(ncbi_taxonomy)
    if not gtdb_phylum or not ncbi_phylum:
        return None
    return _normalize_phylum(gtdb_phylum) != _normalize_phylum(ncbi_phylum)


def _first_present(row: dict[str, str], *names: str) -> str | None:
    for name in names:
        value = row.get(name)
        if value is not None and value.strip().lower() not in _EMPTY_VALUES:
            return value.strip()
    return None


def _parse_float(value: str | None) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except ValueError:
        return None


def _parse_int(value: str | None) -> int | None:
    if value is None:
        return None
    try:
        return int(float(value))
    except ValueError:
        return None


@dataclass
class ParsedGtdbGenome:
    accession: str
    #: GTDB's `gtdb_genome_representative`, kept verbatim (prefix and all) —
    #: it is a tip label in `bac120.tree`/`ar53.tree`, and those files spell
    #: their tips `RS_GCF_...`. See `Genome.gtdb_tip_accession`.
    tip_accession: str | None
    taxonomy_string: str
    taxonomy_chain: list[tuple[TaxonRank, str]]
    genome_size_bp: int | None
    gc_content_pct: float | None
    completeness_pct: float | None
    contamination_pct: float | None
    assembly_level: AssemblyLevel
    #: True when this assembly's NCBI and GTDB lineages name different
    #: phyla, False when they agree, None when the TSV carries no
    #: `ncbi_taxonomy` column to compare against.
    ncbi_taxonomy_conflict: bool | None


def parse_gtdb_metadata_row(row: dict[str, str]) -> ParsedGtdbGenome:
    accession_raw = _first_present(row, *_ACCESSION_COLUMNS)
    if not accession_raw:
        raise GtdbParseError(f"row has no recognizable accession column (tried {_ACCESSION_COLUMNS})")

    taxonomy_string = _first_present(row, "gtdb_taxonomy")
    if not taxonomy_string:
        raise GtdbParseError(f"{accession_raw}: missing gtdb_taxonomy column")

    ncbi_level_raw = row.get(_ASSEMBLY_LEVEL_COLUMN, "")
    # SCAFFOLD is a deliberately conservative default (not COMPLETE_GENOME)
    # when the assembly-level column is absent/unrecognized.
    assembly_level = _NCBI_ASSEMBLY_LEVEL_MAP.get(ncbi_level_raw, AssemblyLevel.SCAFFOLD)

    # A representative genome's own row names *itself* here, so the column
    # is the answer for both cases and needs no is-representative branch.
    # It is absent only from a release that predates the column, in which
    # case the genome simply has no resolved tip rather than a wrong one.
    tip_accession = _first_present(row, "gtdb_genome_representative")

    return ParsedGtdbGenome(
        accession=normalize_gtdb_accession(accession_raw),
        tip_accession=tip_accession,
        taxonomy_string=taxonomy_string,
        taxonomy_chain=parse_gtdb_taxonomy_string(taxonomy_string),
        genome_size_bp=_parse_int(row.get("genome_size")),
        gc_content_pct=_parse_float(_first_present(row, *_GC_COLUMNS)),
        completeness_pct=_parse_float(row.get("checkm_completeness")),
        contamination_pct=_parse_float(row.get("checkm_contamination")),
        assembly_level=assembly_level,
        ncbi_taxonomy_conflict=taxonomies_conflict(
            taxonomy_string, row.get(_NCBI_TAXONOMY_COLUMN)
        ),
    )


def load_gtdb_genome(session: Session, parsed: ParsedGtdbGenome, source: Source) -> tuple[Genome, bool]:
    """Upsert one parsed GTDB genome, walking its taxonomy chain
    root-to-leaf and get-or-creating each rank along the way.

    Idempotency keys:
      Taxon  (rank, name) — safe *for GTDB specifically*: the taxonomy is
             explicitly rank-normalized with no cross-clade homonyms by
             design. This would NOT be a safe key for raw NCBI taxonomy,
             which does have occasional homonyms across kingdoms.
      Genome (accession)  — global, matches the Phase 1a unique constraint.
    """
    parent: Taxon | None = None
    leaf_taxon: Taxon | None = None
    for rank, name in parsed.taxonomy_chain:
        taxon_create = TaxonCreate(
            name=name,
            rank=rank,
            parent_id=parent.id if parent else None,
            source_id=source.id,
            evidence_level=EvidenceLevel.OBSERVED_CURATED,
        )
        taxon, _ = get_or_create_or_update(
            session,
            Taxon,
            lookup={"rank": rank, "name": name},
            values=taxon_create.model_dump(exclude={"rank", "name"}),
        )
        session.flush()
        parent = taxon
        leaf_taxon = taxon

    if leaf_taxon is not None and leaf_taxon.rank == TaxonRank.SPECIES:
        leaf_taxon.gtdb_taxonomy_string = parsed.taxonomy_string

    genome_create = GenomeCreate(
        accession=parsed.accession,
        gtdb_tip_accession=parsed.tip_accession,
        taxon_id=leaf_taxon.id if leaf_taxon else None,
        assembly_level=parsed.assembly_level,
        # None, not False. GTDB's metadata has no verified MAG-detection
        # column, so this loader has never had grounds for either answer —
        # and writing False turned that gap into a claim. `assembly_level`
        # is parsed from the TSV and is the real signal.
        is_mag=None,
        # Established from GTDB's own two lineage columns, so unlike
        # `is_mag` this loader genuinely has grounds for the answer it
        # writes — including None, when the TSV has no NCBI lineage.
        ncbi_taxonomy_conflict=parsed.ncbi_taxonomy_conflict,
        genome_size_bp=parsed.genome_size_bp,
        gc_content_pct=parsed.gc_content_pct,
        completeness_pct=parsed.completeness_pct,
        contamination_pct=parsed.contamination_pct,
        source_id=source.id,
        evidence_level=EvidenceLevel.OBSERVED_CURATED,
    )
    genome, created = get_or_create_or_update(
        session,
        Genome,
        lookup={"accession": genome_create.accession},
        values=genome_create.model_dump(exclude={"accession"}),
    )
    return genome, created


def read_gtdb_metadata_tsv(path: str | Path) -> Iterator[dict[str, str]]:
    """Yield rows from a GTDB `*_metadata.tsv` file as column-name-keyed dicts.

    Reads `.tsv.gz` directly, because that is how GTDB publishes these files
    and bac120_metadata is ~2 GB decompressed — making the caller expand it
    first would be a real cost for no gain.
    """
    path = Path(path)
    opener = gzip.open if path.suffix == ".gz" else open
    with opener(path, mode="rt", newline="", encoding="utf-8") as fh:
        yield from csv.DictReader(fh, delimiter="\t")


def ingest_gtdb_metadata(
    session: Session,
    source: Source,
    rows: Iterator[dict[str, str]] | list[dict[str, str]],
) -> IngestReport:
    """Load a batch of GTDB metadata rows. Never aborts on one bad row —
    each row is committed individually, see get_or_create_or_update()'s
    docstring for why."""
    report = IngestReport()
    for row in rows:
        identifier = row.get("accession") or row.get("accno") or "<unknown>"
        try:
            parsed = parse_gtdb_metadata_row(row)
        except GtdbParseError as exc:
            report.record_error(identifier, str(exc))
            continue

        try:
            _, created = load_gtdb_genome(session, parsed, source)
            session.commit()
        except Exception as exc:  # noqa: BLE001 - one bad row shouldn't abort a bulk load
            report.record_error(identifier, f"{type(exc).__name__}: {exc}")
            session.rollback()
            continue

        if created:
            report.created += 1
        else:
            report.updated += 1

    return report
