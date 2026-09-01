"""antiSMASH region ingestion.

Targets antiSMASH's real JSON output schema (schema version 4), verified
against the `antismash/antismash` source on GitHub rather than assumed —
specifically `antismash/common/serialiser.py` (top-level structure,
`_RegionJSON` field names) and
`antismash/common/secmet/features/region/structures.py` (the per-region
GenBank filename convention, `{record_id}.region{NNN:03d}.gbk` — this
project's `BGC.external_ref` uses that same filename stem, since it's
exactly what BiG-SCAPE's output identifies regions by; see
ingest/bigscape.py). See docs/DATA_SOURCES.md for the verification trail.

**antiSMASH's JSON does not self-describe a genome/assembly accession.**
Its output is organized around "one run over a set of input sequences,"
not tied to any `GCA_`/`GCF_` accession — there is no field for it. This
isn't an oversight to work around; it's a real property of the format.
Mapping a run's output back to a specific genome accession is the
*caller's* responsibility (typically: whatever filename convention their
own pipeline used when it ran antiSMASH), so `genome_accession` is a
required, explicit argument here rather than something this module
guesses at from the JSON content.

Same two-stage shape as ingest/mibig.py and ingest/gtdb.py.
"""
from __future__ import annotations

import json
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from bgcscape.ingest._util import IngestReport, get_or_create_or_update, hybrid_subtype
from bgcscape.models import BGC, BGCClass, EvidenceLevel, Genome, Source
from bgcscape.models.genome import AssemblyLevel
from bgcscape.schemas import BGCCreate, GenomeCreate

# antiSMASH's own top-level product-category vocabulary, confirmed against
# antismash/detection/hmm_detection/data/categories.json — this is the
# *authoritative* source (antiSMASH's own rule categories), not a guess.
# Notably antiSMASH has no "siderophore" top-level category at all — those
# get classified under NRPS or "other" — so BGCClass.SIDEROPHORE is never
# populated by this ingestion path (nor by MIBiG ingestion — see
# ingest/mibig.py's mapping table). It exists in the schema for a possible
# future rule-name-level reclassification pass, not populated by anything
# yet.
_ANTISMASH_CATEGORY_TO_BGC_CLASS: dict[str, BGCClass] = {
    "NRPS": BGCClass.NRPS,
    "PKS": BGCClass.PKS,
    "RiPP": BGCClass.RIPP,
    "terpene": BGCClass.TERPENE,
    "saccharide": BGCClass.SACCHARIDE,
    "alkaloid": BGCClass.ALKALOID,
    "other": BGCClass.OTHER,
}


class AntismashParseError(ValueError):
    """The result is structurally invalid for BGC-scape's model."""


def region_external_ref(record_id: str, region_number: int) -> str:
    """The exact join key BiG-SCAPE output identifies this region by —
    antiSMASH's own per-region GenBank filename, minus the .gbk extension
    (confirmed: `f"{record.id}.region{number:03d}.gbk"` in antiSMASH's
    source). Shared with ingest/bigscape.py so both modules agree on the
    convention from one place, not two independently-typed copies of it.
    """
    return f"{record_id}.region{region_number:03d}"


def _extract_categories(area: dict[str, Any]) -> list[str]:
    """A region's `products` list holds antiSMASH's *specific rule names*
    ("T1PKS", "NRPS-like", "lanthipeptide-class-i", ...) — dozens of
    possible values, not the 7-value categories.json vocabulary. The
    broad category BGC-scape actually wants lives one level down, on each
    protocluster (`area["protoclusters"][i]["category"]`), which *is*
    guaranteed to be one of the 7 real category values. Falls back to
    `products` only if a region genuinely has no protoclusters carrying a
    category (rare, but the field isn't required to be present) — a
    best-effort path, not the normal one.
    """
    protoclusters = area.get("protoclusters") or {}
    categories = sorted({pc["category"] for pc in protoclusters.values() if "category" in pc})
    if categories:
        return categories
    return sorted(area.get("products", []))


def _map_products(products: list[str]) -> tuple[BGCClass, str | None]:
    if not products:
        return BGCClass.OTHER, None
    mapped = [_ANTISMASH_CATEGORY_TO_BGC_CLASS.get(p, BGCClass.OTHER) for p in products]
    if len(set(mapped)) == 1:
        # Not a hybrid. Several categories that all collapse to one class
        # means unrecognised category names mapping to OTHER, so keep them
        # verbatim — they are the only record of what antiSMASH actually
        # said, and nothing splits a non-hybrid subtype into classes.
        subtype = "+".join(products) if len(products) > 1 else None
        return mapped[0], subtype
    # A real hybrid. Must be antiSMASH-agnostic BGCClass values, not
    # antiSMASH's own category names: the frontend splits this on "+" to
    # decide which class filters a hybrid answers to, so "NRPS+PKS" matched
    # nothing in its lowercase vocabulary and dimmed the cluster away.
    return BGCClass.HYBRID, hybrid_subtype(mapped)


@dataclass
class ParsedAntismashRegion:
    external_ref: str
    contig: str  # the record/sequence id this region is on
    start_coord: int
    end_coord: int
    bgc_class: BGCClass
    subtype: str | None
    antismash_version: str
    raw: dict[str, Any]


@dataclass
class ParsedAntismashResult:
    genome_accession: str
    regions: list[ParsedAntismashRegion]
    taxon_hint: str  # antiSMASH's own "bacteria"/"fungi" taxon field — informational only


def parse_antismash_result(raw: dict[str, Any], genome_accession: str) -> ParsedAntismashResult:
    """Parse one antiSMASH result JSON (the whole-run output, potentially
    covering multiple records/contigs) into every region found across all
    of them. Raises `AntismashParseError` on structurally invalid input.
    """
    try:
        version = raw["version"]
        records = raw["records"]
    except KeyError as exc:
        raise AntismashParseError(f"antiSMASH result missing required field: {exc}") from exc

    regions: list[ParsedAntismashRegion] = []
    for record in records:
        try:
            record_id = record["id"]
            areas = record["areas"]
        except KeyError as exc:
            raise AntismashParseError(f"antiSMASH record missing required field: {exc}") from exc

        for index, area in enumerate(areas, start=1):
            try:
                start = area["start"]
                end = area["end"]
            except KeyError as exc:
                raise AntismashParseError(f"{record_id} region {index} missing required field: {exc}") from exc

            bgc_class, subtype = _map_products(_extract_categories(area))
            regions.append(
                ParsedAntismashRegion(
                    external_ref=region_external_ref(record_id, index),
                    contig=record_id,
                    start_coord=start,
                    end_coord=end,
                    bgc_class=bgc_class,
                    subtype=subtype,
                    antismash_version=version,
                    raw={"record_id": record_id, "region_number": index, "area": area},
                )
            )

    return ParsedAntismashResult(
        genome_accession=genome_accession,
        regions=regions,
        taxon_hint=raw.get("taxon", "bacteria"),
    )


def load_antismash_result(session: Session, parsed: ParsedAntismashResult, source: Source) -> tuple[Genome, IngestReport]:
    """Upsert a genome stub (get-or-create — reuses an existing Genome,
    e.g. one already ingested from GTDB, if the accession matches) and
    every region found for it. Each region commits individually — see
    get_or_create_or_update()'s docstring for why.
    """
    genome_create = GenomeCreate(
        accession=parsed.genome_accession,
        assembly_level=AssemblyLevel.UNKNOWN,
        # Not knowable from antiSMASH's JSON alone if this genome doesn't
        # already exist from another source — False is a *default*, not a
        # verified fact. See AssemblyLevel.UNKNOWN's docstring for the
        # same reasoning applied to assembly_level; is_mag doesn't have an
        # equivalent tri-state option in the current schema (a documented
        # gap, not silently ignored — see ARCHITECTURE.md).
        is_mag=False,
        source_id=source.id,
        evidence_level=EvidenceLevel.PREDICTED,
    )
    genome, _ = get_or_create_or_update(
        session,
        Genome,
        lookup={"accession": genome_create.accession},
        values=genome_create.model_dump(exclude={"accession"}),
        # antiSMASH's own best-effort guesses (UNKNOWN assembly level,
        # is_mag=False) must never overwrite real data an existing Genome
        # (e.g. one already ingested from GTDB) has — only apply them when
        # actually creating a fresh stub. update_existing=False expresses
        # this directly, rather than a separate existence pre-check.
        update_existing=False,
    )
    session.flush()

    report = IngestReport()
    for region in parsed.regions:
        bgc_create = BGCCreate(
            genome_id=genome.id,
            contig=region.contig,
            start_coord=region.start_coord,
            end_coord=region.end_coord,
            bgc_class=region.bgc_class,
            subtype=region.subtype,
            predicted_by_tool=f"antiSMASH {region.antismash_version}",
            external_ref=region.external_ref,
            raw_annotation=region.raw,
            source_id=source.id,
            evidence_level=EvidenceLevel.PREDICTED,
        )
        try:
            _, created = get_or_create_or_update(
                session,
                BGC,
                lookup={"source_id": source.id, "external_ref": region.external_ref},
                values=bgc_create.model_dump(exclude={"external_ref", "source_id"}),
            )
            session.commit()
        except Exception as exc:  # noqa: BLE001 - one bad region shouldn't abort the whole result
            report.record_error(region.external_ref, f"{type(exc).__name__}: {exc}")
            session.rollback()
            continue

        if created:
            report.created += 1
        else:
            report.updated += 1

    return genome, report


def read_antismash_result(path: str | Path) -> dict[str, Any]:
    """Read one antiSMASH result JSON file (one run's full output)."""
    with open(Path(path), encoding="utf-8") as fh:
        return json.load(fh)


def ingest_antismash_result(
    session: Session,
    source: Source,
    raw: dict[str, Any],
    genome_accession: str,
) -> IngestReport:
    """Parse and load one antiSMASH result. The genome upsert itself isn't
    counted in the returned report's created/updated (that would double-
    count against ingest_gtdb_metadata's own reporting when the same
    genome is ingested from both sources) — the report reflects region
    (BGC) outcomes only.
    """
    try:
        parsed = parse_antismash_result(raw, genome_accession)
    except AntismashParseError as exc:
        report = IngestReport()
        report.record_error(genome_accession, str(exc))
        return report

    _, report = load_antismash_result(session, parsed, source)
    return report


def ingest_antismash_results(
    session: Session,
    source: Source,
    results: Iterator[tuple[dict[str, Any], str]] | list[tuple[dict[str, Any], str]],
) -> IngestReport:
    """Batch entry point: an iterable of (raw_result, genome_accession)
    pairs — the explicit pairing is the point, since antiSMASH's own JSON
    can't supply the accession half (see module docstring)."""
    combined = IngestReport()
    for raw, genome_accession in results:
        single = ingest_antismash_result(session, source, raw, genome_accession)
        combined.created += single.created
        combined.updated += single.updated
        combined.skipped += single.skipped
        combined.errors.extend(single.errors)
    return combined
