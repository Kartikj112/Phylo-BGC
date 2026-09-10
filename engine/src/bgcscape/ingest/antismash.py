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

from sqlalchemy import func
from sqlalchemy.orm import Session

from bgcscape.coverage import get_or_create_analysis_run, record_coverage
from bgcscape.ingest._util import IngestReport, get_or_create_or_update, hybrid_subtype
from bgcscape.ingest.accession import (
    GenomeMatch,
    build_genome_accession_index,
    resolve_genome,
)
from bgcscape.models import (
    BGC,
    AnalysisRun,
    AnalysisRunCoverage,
    AnalysisType,
    BGCClass,
    EvidenceLevel,
    Genome,
    Source,
)
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
    """The result is structurally invalid for Phylo-BGC's model."""


class AntismashIngestConflict(ValueError):
    """The accession the caller named contradicts what the database holds.

    Raised instead of writing, because every case this covers is a
    statement about the *caller's* input rather than about the data, and
    the wrong ones are indistinguishable from the right ones once written:

    - the accession matches no ingested genome and creating one was not
      authorised (a typo, or an antiSMASH-first ingest that should say so);
    - the accession matches more than one genome (`AMBIGUOUS`);
    - a region in this result is already recorded on a *different* genome.

    The last is the one that motivated this class. `BGC` identity is
    `(source_id, external_ref)` with `genome_id` as an ordinary mutable
    column, so before this guard existed a mistyped accession did not add
    an orphan — it MOVED every region off whatever genome held it, and left
    that genome's `AnalysisRunCoverage` row behind. The result was a genome
    reporting "examined, and its cluster count is a result — including a
    count of zero", i.e. the tool asserting a survey had found a barren
    genome, from a one-character slip. Refusing is the only outcome that
    keeps that unsayable.
    """


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
    broad category Phylo-BGC actually wants lives one level down, on each
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
    #: The tool version, taken from the result's top-level `version` field.
    #: Held here as well as per-region because a run that found NOTHING has
    #: no regions to carry it — and that run is precisely the one whose
    #: coverage matters most, since it is the only evidence that a genome
    #: with zero clusters was ever examined.
    antismash_version: str = ""


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
        antismash_version=str(version),
    )


@dataclass
class GenomeResolution:
    """Which genome this result was attached to, and on what evidence.

    Reported rather than hidden, exactly as `ingest/bigfam.py` reports its
    own `GenomeMatch`: a run attached by folding the RefSeq/GenBank
    namespaces rests on NCBI's pairing rule, and a reader is entitled to
    know that before quoting the result.
    """

    genome: Genome
    match: GenomeMatch
    created: bool

    @property
    def note(self) -> str:
        if self.created:
            return (
                f"created a new genome for {self.genome.accession!r} — no ingested genome "
                "matched it under any spelling"
            )
        return f"resolved {self.genome.accession!r} by {self.match.value} match"


def lookup_genome(session: Session, accession: str) -> tuple[Genome | None, GenomeMatch]:
    """Resolve an accession to an existing genome, WITHOUT creating one.

    Split out from `resolve_genome_for_result` so the conflict pre-flight
    can run before anything is written. It matters: the guard raises, and a
    genome created before the raise stays flushed in the caller's session,
    so a caller that catches the refusal and commits other work later would
    persist the very stub the refusal exists to prevent.
    """
    rows = [(genome_id, acc) for genome_id, acc in session.query(Genome.id, Genome.accession)]
    index = build_genome_accession_index(rows)
    genome_id, match = resolve_genome(index, accession)

    if match is GenomeMatch.AMBIGUOUS:
        raise AntismashIngestConflict(
            f"{accession!r} matches more than one ingested genome. Picking one would fabricate "
            "the association this whole module exists to record; name the exact accession as it "
            "is stored instead."
        )

    if genome_id is None:
        return None, match
    return session.query(Genome).filter_by(id=genome_id).one(), match


def resolve_genome_for_result(
    session: Session,
    source: Source,
    accession: str,
    *,
    allow_create: bool = True,
) -> GenomeResolution:
    """Find the genome an antiSMASH run belongs to, or create one for it.

    Uses `ingest/accession.py` rather than a bare equality lookup, which is
    what `ingest/gtdb.py` and `ingest/bigfam.py` already do. Two of the
    three spellings it understands were live defects here: `GCF_X.1` and
    `GCF_X` created two separate genomes for one assembly, and a GenBank
    accession never matched its RefSeq twin.

    `allow_create=False` is what makes a typo an error. It is not the
    library default, because antiSMASH-first ingestion — a genome this
    corpus has never seen from GTDB — is a supported workflow and the
    caller passing an accession has already decided. It IS the CLI default,
    because that is where a human types the string, and where a typo is
    overwhelmingly more likely than a genuinely new genome.
    """
    genome, match = lookup_genome(session, accession)

    if genome is not None:
        return GenomeResolution(genome=genome, match=match, created=False)

    if not allow_create:
        raise AntismashIngestConflict(
            f"{accession!r} matches no ingested genome under any spelling (exact, "
            "version-insensitive, or GCF/GCA-folded). If that is a typo, correct it. If this "
            "genome is genuinely new to the corpus, re-run with --create-genome to say so "
            "deliberately."
        )

    genome_create = GenomeCreate(
        accession=accession,
        assembly_level=AssemblyLevel.UNKNOWN,
        # None, matching AssemblyLevel.UNKNOWN beside it: antiSMASH's JSON
        # carries no assembly metadata at all, so neither answer is
        # available. This used to be False — the documented gap that
        # `is_mag`'s nullability closed.
        is_mag=None,
        source_id=source.id,
        evidence_level=EvidenceLevel.PREDICTED,
    )
    genome, _ = get_or_create_or_update(
        session,
        Genome,
        lookup={"accession": genome_create.accession},
        values=genome_create.model_dump(exclude={"accession"}),
        # antiSMASH's own best-effort guesses must never overwrite real data
        # an existing Genome (e.g. one already ingested from GTDB) has — only
        # apply them when actually creating a fresh stub.
        update_existing=False,
    )
    session.flush()
    return GenomeResolution(genome=genome, match=GenomeMatch.UNMATCHED, created=True)


def find_reassignments(
    session: Session,
    source: Source,
    genome: Genome | None,
    parsed: ParsedAntismashResult,
) -> list[tuple[str, str]]:
    """Regions already recorded on a *different* genome, as
    `(external_ref, current_genome_accession)`.

    Checked before anything is written, because the damage is done by the
    first commit and a per-region check would leave a partially moved
    result behind.

    `genome=None` means the accession resolved to nothing and a genome would
    be created for it. Every existing row for these refs is then on a
    different genome by construction — which is exactly the typo case, and
    the reason this takes an optional genome rather than requiring one to
    have been created first.
    """
    refs = [region.external_ref for region in parsed.regions]
    if not refs:
        return []
    query = (
        session.query(BGC.external_ref, Genome.accession)
        .join(Genome, Genome.id == BGC.genome_id)
        .filter(BGC.source_id == source.id, BGC.external_ref.in_(refs))
    )
    if genome is not None:
        query = query.filter(BGC.genome_id != genome.id)
    return [(ref, acc) for ref, acc in query.all()]


def load_antismash_result(
    session: Session,
    parsed: ParsedAntismashResult,
    source: Source,
    *,
    run_label: str = "",
    allow_create_genome: bool = True,
    allow_reassign: bool = False,
) -> tuple[Genome, IngestReport]:
    """Upsert a genome stub (get-or-create — reuses an existing Genome,
    e.g. one already ingested from GTDB, if the accession matches) and
    every region found for it. Each region commits individually — see
    get_or_create_or_update()'s docstring for why.

    Also records an `AnalysisRun` covering this genome. That is the whole
    point of doing it here rather than leaving it to a separate step: this
    function is the only place that knows, for certain, that antiSMASH
    looked at this exact genome. Coverage is recorded even when the run
    found NO regions — a genome examined and found empty is a real
    biological finding, and it is the finding the tool previously had no
    way to state.

    Raises `AntismashIngestConflict` rather than writing when the accession
    contradicts the database — see that class for why silence was the bug.
    Nothing is written and **no coverage is recorded** in that case: the
    coverage row is what turns a mistake into the tool claiming a genome
    was surveyed, so refusing the regions without refusing the coverage
    would leave the worst half of the damage in place.
    """
    # Ordering is load-bearing: the conflict is decided against the genome
    # this result WOULD go to, before that genome exists. Creating first and
    # checking second left a flushed stub behind on every refusal.
    existing, _ = lookup_genome(session, parsed.genome_accession)
    conflicts = find_reassignments(session, source, existing, parsed)
    if conflicts and not allow_reassign:
        listed = ", ".join(f"{ref} (currently on {acc})" for ref, acc in conflicts[:5])
        more = f", and {len(conflicts) - 5} more" if len(conflicts) > 5 else ""
        raise AntismashIngestConflict(
            f"{len(conflicts)} region(s) in this result are already recorded on a different "
            f"genome: {listed}{more}. Attaching them to {parsed.genome_accession!r} would move "
            "them, leaving the genome they came from marked as examined with nothing on it — a "
            "survey result that never happened. Check the accession; pass --reassign only if you "
            "are deliberately correcting where these regions belong."
        )

    resolution = resolve_genome_for_result(
        session, source, parsed.genome_accession, allow_create=allow_create_genome
    )
    genome = resolution.genome

    report = IngestReport()
    report.notes.append(resolution.note)
    donor_accessions = sorted({acc for _, acc in conflicts})
    if conflicts:
        report.notes.append(
            f"reassigned {len(conflicts)} region(s) from {', '.join(donor_accessions)}, "
            "as explicitly requested"
        )
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

    # Recorded after the regions, so `bgcs_recorded` reflects what actually
    # loaded rather than what the file claimed — a run that reported five
    # regions of which five failed to load examined the genome and recorded
    # nothing, which is a different fact from finding nothing.
    run = get_or_create_analysis_run(
        session,
        source=source,
        analysis_type=AnalysisType.BGC_DETECTION,
        tool="antiSMASH",
        tool_version=parsed.antismash_version or "unknown",
        label=run_label,
        parameters={"taxon": parsed.taxon_hint} if parsed.taxon_hint else None,
    )
    record_coverage(session, run, genome, bgcs_recorded=report.total_ok)

    if donor_accessions:
        withdrawn = _withdraw_emptied_coverage(session, source, donor_accessions)
        if withdrawn:
            report.notes.append(
                f"withdrew this source's coverage claim on {', '.join(withdrawn)} — the run that "
                "recorded it was the same mistaken ingest, so leaving it would say those genomes "
                "were examined and found empty"
            )

    session.commit()

    return genome, report


def _withdraw_emptied_coverage(
    session: Session, source: Source, donor_accessions: list[str]
) -> list[str]:
    """Drop this source's coverage rows for genomes a reassignment emptied.

    A reassignment says the regions never belonged to the donor. The
    coverage row on that donor was written by the same ingest that
    misattributed them, so it is not independent evidence of anything — and
    left in place it makes the donor read "examined ... a count of zero,
    which means none were found rather than that nobody looked". That is
    the exact false claim the reassignment guard exists to prevent, and an
    authorised correction must not reintroduce it.

    Scoped to this `source`: coverage recorded by a *different* run over the
    same genome is somebody else's evidence and is left alone.
    """
    withdrawn: list[str] = []
    run_ids = [row[0] for row in session.query(AnalysisRun.id).filter(AnalysisRun.source_id == source.id)]
    if not run_ids:
        return withdrawn

    for accession in donor_accessions:
        donor = session.query(Genome).filter_by(accession=accession).one_or_none()
        if donor is None:
            continue
        remaining = (
            session.query(func.count(BGC.id))
            .filter(BGC.genome_id == donor.id, BGC.source_id == source.id)
            .scalar()
        )
        if remaining:
            continue
        deleted = (
            session.query(AnalysisRunCoverage)
            .filter(
                AnalysisRunCoverage.genome_id == donor.id,
                AnalysisRunCoverage.analysis_run_id.in_(run_ids),
            )
            .delete(synchronize_session=False)
        )
        if deleted:
            withdrawn.append(accession)
    return withdrawn


def read_antismash_result(path: str | Path) -> dict[str, Any]:
    """Read one antiSMASH result JSON file (one run's full output)."""
    with open(Path(path), encoding="utf-8") as fh:
        return json.load(fh)


def ingest_antismash_result(
    session: Session,
    source: Source,
    raw: dict[str, Any],
    genome_accession: str,
    *,
    run_label: str = "",
    allow_create_genome: bool = True,
    allow_reassign: bool = False,
) -> IngestReport:
    """Parse and load one antiSMASH result. The genome upsert itself isn't
    counted in the returned report's created/updated (that would double-
    count against ingest_gtdb_metadata's own reporting when the same
    genome is ingested from both sources) — the report reflects region
    (BGC) outcomes only.

    A malformed file is recorded as an error and returned, because one bad
    file among many should not abort a run. `AntismashIngestConflict` is
    deliberately NOT caught here: it means the caller's accession is wrong,
    and continuing past it is what used to corrupt the corpus. Callers that
    process many results catch it per item — see `ingest_antismash_results`.
    """
    try:
        parsed = parse_antismash_result(raw, genome_accession)
    except AntismashParseError as exc:
        report = IngestReport()
        report.record_error(genome_accession, str(exc))
        return report

    _, report = load_antismash_result(
        session,
        parsed,
        source,
        run_label=run_label,
        allow_create_genome=allow_create_genome,
        allow_reassign=allow_reassign,
    )
    return report


def ingest_antismash_results(
    session: Session,
    source: Source,
    results: Iterator[tuple[dict[str, Any], str]] | list[tuple[dict[str, Any], str]],
    *,
    run_label: str = "",
    allow_create_genome: bool = True,
    allow_reassign: bool = False,
) -> IngestReport:
    """Batch entry point: an iterable of (raw_result, genome_accession)
    pairs — the explicit pairing is the point, since antiSMASH's own JSON
    can't supply the accession half (see module docstring).

    One `run_label` across the batch, so every genome in it lands under a
    single `AnalysisRun` — which is what a batch actually was."""
    combined = IngestReport()
    for raw, genome_accession in results:
        try:
            single = ingest_antismash_result(
                session,
                source,
                raw,
                genome_accession,
                run_label=run_label,
                allow_create_genome=allow_create_genome,
                allow_reassign=allow_reassign,
            )
        except AntismashIngestConflict as exc:
            # Recorded and skipped rather than raised: one wrong accession in
            # a batch of hundreds should not discard the genomes that were
            # right. It is still a refusal — nothing was written for this one.
            combined.record_error(genome_accession, str(exc))
            session.rollback()
            continue
        combined.created += single.created
        combined.updated += single.updated
        combined.skipped += single.skipped
        combined.errors.extend(single.errors)
        combined.notes.extend(single.notes)
    return combined
