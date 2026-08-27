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

# MIBiG 3.x used a different vocabulary AND a different JSON shape. Both
# are live in the wild: the mibig-secmet/mibig-json repository publishes
# 3.x, while the website serves 4.0. Ingesting the real repository turned
# up 2,745 entries in this older format, so supporting it is not
# backwards-compatibility housekeeping — it is the format most bulk MIBiG
# data is actually distributed in today.
#
# Note "NRP" (not NRPS) and "Polyketide" (not PKS): the 3.x names describe
# the *product*, the 4.0 names describe the *machinery*.
_MIBIG_V3_CLASS_TO_BGC_CLASS: dict[str, BGCClass] = {
    "NRP": BGCClass.NRPS,
    "Polyketide": BGCClass.PKS,
    "RiPP": BGCClass.RIPP,
    "Terpene": BGCClass.TERPENE,
    "Saccharide": BGCClass.SACCHARIDE,
    "Alkaloid": BGCClass.ALKALOID,
    "Other": BGCClass.OTHER,
}

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


def _hybrid_subtype(mapped: list[BGCClass]) -> str:
    """Canonical `nrps+pks`-style subtype for a hybrid — the frontend
    splits `subtype` on `+` and expects BGCClass *values*, not MIBiG's
    product vocabulary ("NRP", "Polyketide").

    De-duped and **sorted**: MIBiG records the same hybrid in whichever
    order the curator listed the classes, so the real 4.0 release contains
    both `nrps+pks` (358 entries) and `pks+nrps` (36). Unsorted, those read
    as two different subtypes in the class filter, the donut and the clade
    comparison — the same cluster type counted twice under different names.
    """
    return "+".join(sorted({cls.value for cls in mapped}))


def _map_bgc_class(class_names: list[str]) -> tuple[BGCClass, str | None]:
    if not class_names:
        return BGCClass.OTHER, None
    mapped = [_MIBIG_CLASS_TO_BGC_CLASS.get(name, BGCClass.OTHER) for name in class_names]
    if len(set(mapped)) == 1:
        # Either a single class, or several MIBiG sub-blocks that all
        # collapse to the same BGCClass (not a real hybrid).
        return mapped[0], None
    return BGCClass.HYBRID, _hybrid_subtype(mapped)


def detect_mibig_schema(raw: dict[str, Any]) -> str:
    """Return "v3" or "v4" for a raw MIBiG entry.

    Detected from structure rather than a version field, because 3.x
    entries carry no usable top-level version marker — the `changelog`
    holds per-release history, not the schema version. The 3.x wrapper
    (`{"changelog": ..., "cluster": {...}}`) is unambiguous, so that's
    what's keyed on.
    """
    if "cluster" in raw and isinstance(raw.get("cluster"), dict):
        return "v3"
    return "v4"


def parse_mibig_entry_v3(raw: dict[str, Any]) -> ParsedMibigEntry:
    """Parse one MIBiG 3.x entry.

    Differences from 4.0 that actually bite, all found by ingesting the
    real 2,745-entry repository:
      - the payload is nested under `cluster`
      - `mibig_accession`, not `accession`
      - `biosyn_class` is a flat list of product names, not
        `biosynthesis.classes[].class`
      - `loci` is a single object, not a list
      - `ncbi_tax_id` is a STRING, not an int
      - coordinates are optional and can be half-present: 1,408 entries
        carry `start_coord` and only 1,407 carry `end_coord`
      - compounds use `compound`/`chem_struct`/`molecular_formula`
    """
    cluster = raw.get("cluster")
    if not isinstance(cluster, dict):
        raise MibigParseError("MIBiG 3.x entry has no 'cluster' object")

    try:
        accession = cluster["mibig_accession"]
        loci = cluster["loci"]
    except KeyError as exc:
        raise MibigParseError(f"MIBiG 3.x entry missing required field: {exc}") from exc

    if not isinstance(loci, dict) or "accession" not in loci:
        raise MibigParseError(f"{accession}: loci is not a usable object")

    start = loci.get("start_coord")
    end = loci.get("end_coord")
    # Half-present coordinates are real in this dataset. A cluster with a
    # start and no end has no meaningful span, so both are dropped rather
    # than storing a boundary that implies a length it doesn't have.
    if start is None or end is None:
        start = end = None

    raw_taxid = cluster.get("ncbi_tax_id")
    try:
        ncbi_taxid = int(raw_taxid) if raw_taxid not in (None, "") else None
    except (TypeError, ValueError):
        ncbi_taxid = None

    class_names = [c for c in cluster.get("biosyn_class", []) if c]
    mapped = [_MIBIG_V3_CLASS_TO_BGC_CLASS.get(name, BGCClass.OTHER) for name in class_names]
    if not mapped:
        bgc_class, subtype = BGCClass.OTHER, None
    elif len(set(mapped)) == 1:
        bgc_class, subtype = mapped[0], None
    else:
        # Canonical nrps+pks-style, not MIBiG 3.x's "NRP+Polyketide": the
        # frontend splits this on "+" and needs BGCClass values.
        bgc_class, subtype = BGCClass.HYBRID, _hybrid_subtype(mapped)

    compounds: list[ParsedMibigCompound] = []
    for index, compound_raw in enumerate(cluster.get("compounds", [])):
        name = compound_raw.get("compound")
        if not name:
            continue
        pubchem_cid = None
        for db_id in compound_raw.get("database_id", []) or []:
            if isinstance(db_id, str) and db_id.startswith("pubchem:"):
                try:
                    pubchem_cid = int(db_id.split(":", 1)[1])
                except ValueError:
                    pubchem_cid = None
                break
        methods = [e for e in compound_raw.get("evidence", []) if isinstance(e, str)]
        compounds.append(
            ParsedMibigCompound(
                name=name,
                chemical_formula=compound_raw.get("molecular_formula"),
                smiles=compound_raw.get("chem_struct"),
                compound_class=", ".join(
                    m.get("moiety", "") for m in compound_raw.get("chem_moieties", []) if m.get("moiety")
                )
                or None,
                mibig_compound_ref=f"{accession}:{index}",
                pubchem_cid=pubchem_cid,
                link_reference="; ".join(methods) or None,
            )
        )

    return ParsedMibigEntry(
        mibig_accession=accession,
        status=cluster.get("status", ACTIVE_STATUS),
        locus_accession=loci["accession"],
        start_coord=start,
        end_coord=end,
        organism_name=cluster.get("organism_name"),
        ncbi_taxid=ncbi_taxid,
        bgc_class=bgc_class,
        subtype=subtype,
        compounds=compounds,
        raw=raw,
    )


def parse_mibig_entry(raw: dict[str, Any]) -> ParsedMibigEntry:
    """Parse one MIBiG entry, auto-detecting 3.x vs 4.0 format.

    Raises `MibigParseError` on structurally invalid input.
    """
    if detect_mibig_schema(raw) == "v3":
        return parse_mibig_entry_v3(raw)
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

    # MIBiG 4.0 writes `{"from": 0, "to": 0}` when the cluster's position
    # within the deposited locus isn't recorded — 1,361 of 3,013 entries in
    # the 4.0 release. Stored literally that would be a real zero-length
    # span at the start of the contig, so it is read as "unknown" instead.
    # Same reasoning as the 3.x half-present-coordinate rule above.
    location = primary_locus.get("location")
    start_coord = location.get("from") if location else None
    end_coord = location.get("to") if location else None
    if start_coord in (None, 0) and end_coord in (None, 0):
        start_coord = end_coord = None

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
        # MIBiG distributes one GenBank file per entry, named
        # "<accession>.gbk", and BiG-SCAPE identifies every input record by
        # that filename stem in its clustering output's GBK column. Setting
        # external_ref to the accession therefore makes a BiG-SCAPE run over
        # MIBiG's own GenBank files joinable by `bgcscape ingest bigscape`
        # with no extra mapping — the same cross-tool join key antiSMASH
        # ingestion populates (see ingest/antismash.py's
        # region_external_ref). Without it those rows are reported as
        # skipped, which is what used to happen to MIBiG reference clusters
        # mixed into a BiG-SCAPE run.
        external_ref=parsed.mibig_accession,
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
        # Accept either schema. The v4 check alone rejected every file in
        # the real mibig-json repository, which publishes 3.x.
        looks_like_v4 = isinstance(raw, dict) and "accession" in raw and "biosynthesis" in raw
        looks_like_v3 = (
            isinstance(raw, dict)
            and isinstance(raw.get("cluster"), dict)
            and "mibig_accession" in raw["cluster"]
        )
        if not (looks_like_v4 or looks_like_v3):
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
