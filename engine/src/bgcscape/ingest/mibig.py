"""MIBiG (Minimum Information about a Biosynthetic Gene cluster) ingestion.

Targets the **MIBiG 4.0** JSON entry format, confirmed against the
`mibig-secmet/python-mibig` reference implementation on GitHub rather than
assumed from an older MIBiG version — 4.0 restructured the schema
significantly relative to 2.0/3.0 (biosynthetic class now lives under
`biosynthesis.classes[].class` rather than a flat `biosyn_class` list;
organism info is a nested `taxonomy` object rather than flat
`organism_name`/`ncbi_tax_id` fields; compound database refs are
`"pubchem:12345"`-style strings under `databaseIds`, not a nested object).
See docs/DATA_SOURCES.md for the verification trail.

A MIBiG entry does not describe a whole genome assembly — `loci[].accession`
is a single deposited GenBank locus (often just the BGC region itself), not
a `GCA_`/`GCF_` assembly accession. Modeling that as a full `Genome` row
would be a category error (assembly-level QC fields like completeness/
contamination don't apply to a locus deposit), so this loader creates a
minimal `Genome` stub using `AssemblyLevel.LOCUS` — see ARCHITECTURE.md.

Two-stage design, deliberately kept separate:
  parse_mibig_entry()   pure function: raw dict -> ParsedMibigEntry. No DB
                         access, so it's unit-testable without a session.
  load_mibig_entry()    takes a ParsedMibigEntry + a session + the MIBiG
                         `Source` row, and upserts it (idempotent — safe to
                         re-run over a refreshed export).

`ingest_mibig_entries()` is the orchestration entry point CLI/scripts
should actually call: it loops entries, applies status filtering, and
never lets one bad entry abort the whole run.
"""
from __future__ import annotations

import json
import logging
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from bgcscape.ingest._util import IngestReport, get_or_create_or_update
from bgcscape.models import BGC, BGCClass, BGCCompoundLink, Compound, EvidenceLevel, Genome, Source, Taxon, TaxonRank
from bgcscape.models.genome import AssemblyLevel
from bgcscape.schemas import BGCCompoundLinkCreate, BGCCreate, CompoundCreate, GenomeCreate, TaxonCreate

# MIBiG 4.0's `biosynthesis.classes[].class` values -> BGC-scape's BGCClass.
# Notably, MIBiG has *no* direct "siderophore" or "alkaloid" biosynthesis
# class — "Alkaloid" only appears as a *compound* class in MIBiG's schema,
# and siderophores are typically classed under NRPS or "other" at this
# level. Those two BGCClass values are populated from antiSMASH ingestion
# instead (a later chunk), not from MIBiG.
_MIBIG_CLASS_TO_BGC_CLASS: dict[str, BGCClass] = {
    "NRPS": BGCClass.NRPS,
    "PKS": BGCClass.PKS,
    "ribosomal": BGCClass.RIPP,
    "saccharide": BGCClass.SACCHARIDE,
    "terpene": BGCClass.TERPENE,
    "other": BGCClass.OTHER,
}

ACTIVE_STATUS = "active"

logger = logging.getLogger(__name__)


class MibigParseError(ValueError):
    """The entry is structurally invalid — missing a field BGC-scape's
    model requires. Distinct from "should this be skipped" (e.g. a
    retired/pending entry parses fine; ingest_mibig_entries() decides
    whether to load it).
    """


@dataclass
class ParsedMibigCompound:
    name: str
    chemical_formula: str | None
    smiles: str | None
    compound_class: str | None
    mibig_compound_ref: str
    pubchem_cid: int | None
    link_reference: str | None


@dataclass
class ParsedMibigEntry:
    """Everything needed to load one MIBiG entry. Plain dataclasses, not
    the Pydantic *Create schemas — those need real foreign-key ids
    (source_id, genome_id, taxon_id) that only exist once the loader has
    written rows to the database, which the parser deliberately knows
    nothing about.
    """

    mibig_accession: str
    status: str
    locus_accession: str
    start_coord: int | None
    end_coord: int | None
    organism_name: str | None
    ncbi_taxid: int | None
    bgc_class: BGCClass
    subtype: str | None
    compounds: list[ParsedMibigCompound]
    raw: dict[str, Any] = field(repr=False)


def _map_bgc_class(class_names: list[str]) -> tuple[BGCClass, str | None]:
    if not class_names:
        return BGCClass.OTHER, None
    mapped = [_MIBIG_CLASS_TO_BGC_CLASS.get(name, BGCClass.OTHER) for name in class_names]
    if len(set(mapped)) == 1:
        # Either a single class, or several MIBiG sub-blocks that all
        # collapse to the same BGCClass (not a real hybrid).
        subtype = "+".join(class_names) if len(class_names) > 1 else None
        return mapped[0], subtype
    return BGCClass.HYBRID, "+".join(class_names)


def parse_mibig_entry(raw: dict[str, Any]) -> ParsedMibigEntry:
    """Parse one MIBiG 4.0 JSON entry (matching `MibigEntry.to_json()`) into
    a `ParsedMibigEntry`. Raises `MibigParseError` on structurally invalid
    input.
    """
    try:
        accession = raw["accession"]
        status = raw["status"]
        loci = raw["loci"]
        taxonomy = raw["taxonomy"]
        biosynthesis = raw["biosynthesis"]
        compounds_raw = raw["compounds"]
    except KeyError as exc:
        raise MibigParseError(f"MIBiG entry missing required field: {exc}") from exc

    if not loci:
        raise MibigParseError(f"{accession}: entry has no loci")

    primary_locus = loci[0]
    try:
        locus_accession = primary_locus["accession"]
    except KeyError as exc:
        raise MibigParseError(f"{accession}: locus missing accession") from exc

    location = primary_locus.get("location")
    start_coord = location["from"] if location else None
    end_coord = location["to"] if location else None

    ncbi_taxid = taxonomy.get("ncbiTaxId")
    organism_name = taxonomy.get("name")

    class_entries = biosynthesis.get("classes", [])
    class_names = [c["class"] for c in class_entries if "class" in c]
    bgc_class, subtype = _map_bgc_class(class_names)

    compounds: list[ParsedMibigCompound] = []
    for index, compound_raw in enumerate(compounds_raw):
        name = compound_raw.get("name")
        if not name:
            continue

        pubchem_cid = None
        for db_id in compound_raw.get("databaseIds", []):
            if isinstance(db_id, str) and db_id.startswith("pubchem:"):
                try:
                    pubchem_cid = int(db_id.split(":", 1)[1])
                except ValueError:
                    pubchem_cid = None
                break

        methods = [e.get("method") for e in compound_raw.get("evidence", []) if e.get("method")]

        compounds.append(
            ParsedMibigCompound(
                name=name,
                chemical_formula=compound_raw.get("formula"),
                smiles=compound_raw.get("structure"),
                compound_class=", ".join(compound_raw.get("classes", [])) or None,
                mibig_compound_ref=f"{accession}:{index}",
                pubchem_cid=pubchem_cid,
                link_reference="; ".join(methods) or None,
            )
        )

    return ParsedMibigEntry(
        mibig_accession=accession,
        status=status,
        locus_accession=locus_accession,
        start_coord=start_coord,
        end_coord=end_coord,
        organism_name=organism_name,
        ncbi_taxid=ncbi_taxid,
        bgc_class=bgc_class,
        subtype=subtype,
        compounds=compounds,
        raw=raw,
    )


def load_mibig_entry(session: Session, parsed: ParsedMibigEntry, source: Source) -> tuple[BGC, bool]:
    """Upsert one parsed MIBiG entry. Returns `(bgc, created)`.

    Idempotency keys, chosen deliberately (see ingest/_util.py and
    ARCHITECTURE.md for why `BGC.mibig_accession` alone isn't unique
    globally — a *predicted* BGC elsewhere can legitimately reference the
    same MIBiG accession as a "resembles known cluster X" annotation):
      Taxon    (ncbi_taxid)                       — global, MIBiG-wide
      Genome   (accession)                        — global (locus accession)
      BGC      (source_id, mibig_accession)        — scoped to *this* source
      Compound (source_id, mibig_compound_ref)     — scoped to this source
      Link     (bgc_id, compound_id)                — natural join key
    """
    taxon: Taxon | None = None
    if parsed.ncbi_taxid is not None and parsed.organism_name:
        taxon_create = TaxonCreate(
            name=parsed.organism_name,
            rank=TaxonRank.SPECIES,
            ncbi_taxid=parsed.ncbi_taxid,
            source_id=source.id,
            evidence_level=EvidenceLevel.OBSERVED_CURATED,
        )
        taxon, _ = get_or_create_or_update(
            session,
            Taxon,
            lookup={"ncbi_taxid": parsed.ncbi_taxid},
            values=taxon_create.model_dump(exclude={"ncbi_taxid"}),
            # See get_or_create_or_update()'s docstring: without this, a
            # genome GTDB already classified under this exact species name
            # (which never sets ncbi_taxid) would get a duplicate Taxon
            # instead of gaining its ncbi_taxid.
            fallback_lookups=[{"rank": TaxonRank.SPECIES, "name": parsed.organism_name}],
        )
        session.flush()

    locus_length = None
    if parsed.start_coord is not None and parsed.end_coord is not None:
        locus_length = parsed.end_coord - parsed.start_coord

    genome_create = GenomeCreate(
        accession=parsed.locus_accession,
        taxon_id=taxon.id if taxon else None,
        assembly_level=AssemblyLevel.LOCUS,
        is_mag=False,
        genome_size_bp=locus_length,
        source_id=source.id,
        evidence_level=EvidenceLevel.OBSERVED_CURATED,
    )
    genome, _ = get_or_create_or_update(
        session,
        Genome,
        lookup={"accession": genome_create.accession},
        values=genome_create.model_dump(exclude={"accession"}),
    )
    session.flush()

    bgc_create = BGCCreate(
        genome_id=genome.id,
        contig=parsed.locus_accession,
        start_coord=parsed.start_coord,
        end_coord=parsed.end_coord,
        bgc_class=parsed.bgc_class,
        subtype=parsed.subtype,
        mibig_accession=parsed.mibig_accession,
        raw_annotation=parsed.raw,
        source_id=source.id,
        evidence_level=EvidenceLevel.OBSERVED_CURATED,
    )
    bgc, created = get_or_create_or_update(
        session,
        BGC,
        lookup={"source_id": source.id, "mibig_accession": parsed.mibig_accession},
        values=bgc_create.model_dump(exclude={"mibig_accession", "source_id"}),
    )
    session.flush()

    for parsed_compound in parsed.compounds:
        compound_create = CompoundCreate(
            name=parsed_compound.name,
            chemical_formula=parsed_compound.chemical_formula,
            smiles=parsed_compound.smiles,
            compound_class=parsed_compound.compound_class,
            mibig_compound_ref=parsed_compound.mibig_compound_ref,
            pubchem_cid=parsed_compound.pubchem_cid,
            source_id=source.id,
            evidence_level=EvidenceLevel.OBSERVED_CURATED,
        )
        compound, _ = get_or_create_or_update(
            session,
            Compound,
            lookup={"source_id": source.id, "mibig_compound_ref": parsed_compound.mibig_compound_ref},
            values=compound_create.model_dump(exclude={"mibig_compound_ref", "source_id"}),
        )
        session.flush()

        link_create = BGCCompoundLinkCreate(
            bgc_id=bgc.id,
            compound_id=compound.id,
            reference=parsed_compound.link_reference,
            source_id=source.id,
            evidence_level=EvidenceLevel.OBSERVED_CURATED,
        )
        get_or_create_or_update(
            session,
            BGCCompoundLink,
            lookup={"bgc_id": bgc.id, "compound_id": compound.id},
            values=link_create.model_dump(exclude={"bgc_id", "compound_id"}),
        )

    return bgc, created


def read_mibig_entries_from_path(path: str | Path) -> Iterator[dict[str, Any]]:
    """Yield raw entry dicts from a path: a single `.json` file, or a
    directory of them (MIBiG's own bulk download is one file per entry).

    Directory mode globs `*.json` indiscriminately, so a directory holding
    *other* tools' JSON alongside MIBiG entries will feed those in too —
    they'll then fail `parse_mibig_entry` with a confusing "missing
    required field: 'accession'" rather than anything pointing at the real
    problem. This project hit exactly that when an antiSMASH result
    fixture was added to a shared test-fixture directory. Files lacking
    MIBiG's two mandatory top-level keys are therefore skipped with a
    warning rather than yielded, so a mixed directory degrades to "ignored
    the irrelevant files" instead of "reported spurious parse errors."
    """
    path = Path(path)
    files = sorted(path.glob("*.json")) if path.is_dir() else [path]
    for file_path in files:
        with open(file_path, encoding="utf-8") as fh:
            raw = json.load(fh)
        if not isinstance(raw, dict) or "accession" not in raw or "biosynthesis" not in raw:
            logger.warning("Skipping %s: does not look like a MIBiG entry JSON", file_path)
            continue
        yield raw


def ingest_mibig_entries(
    session: Session,
    source: Source,
    entries: Iterator[dict[str, Any]] | list[dict[str, Any]],
    *,
    include_non_active: bool = False,
) -> IngestReport:
    """Load a batch of raw MIBiG entry dicts. Never aborts on a single bad
    entry — records it in the returned `IngestReport` and moves on, because
    ingesting thousands of entries shouldn't die on entry #4,812.

    By default only `status == "active"` entries are loaded (see MIBiG's
    `StatusLevel`); retired/pending/embargoed entries are counted as
    skipped, not errors, since they parsed fine — they're just not meant to
    be treated as current data. Pass `include_non_active=True` to load them
    anyway (e.g. to study why entries were retired).

    Each entry is committed individually (not the whole batch in one
    transaction) — see get_or_create_or_update()'s docstring for why.
    """
    report = IngestReport()
    for raw in entries:
        accession = raw.get("accession", "<unknown>")
        try:
            parsed = parse_mibig_entry(raw)
        except MibigParseError as exc:
            report.record_error(accession, str(exc))
            continue

        if parsed.status != ACTIVE_STATUS and not include_non_active:
            report.skipped += 1
            continue

        try:
            _, created = load_mibig_entry(session, parsed, source)
            session.commit()
        except Exception as exc:  # noqa: BLE001 - deliberately broad, see docstring
            report.record_error(accession, f"{type(exc).__name__}: {exc}")
            session.rollback()
            continue

        if created:
            report.created += 1
        else:
            report.updated += 1

    return report
