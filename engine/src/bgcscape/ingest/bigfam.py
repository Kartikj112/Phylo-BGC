"""BiG-FAM Gene Cluster Family membership ingestion.

This is the source of *real* GCFs. The other grouping this project can
build is a curated chemical fact (`ingest/compound_groups.py` — clusters
MIBiG says make the same molecule, with no sequences compared at all), and
the only other route to a sequence family is a BiG-SCAPE run, which is a
compute pipeline this visualization-only tool deliberately does not
perform. BiG-FAM publishes BiG-SLiCE's precomputed families over 1.2M
BGCs, so a GCF's membership can be *read* rather than computed — which is
the only reason a GCF can be shown here at all.

## The file this reads

The per-GCF export behind "export BGC list" on a GCF detail page, i.e.
`/api/gcf/get_member_links?gcf_id=<id>`. Verified against the live
endpoint for GCF 200948 rather than assumed. It is a TSV whose header line
is prefixed with `#`::

    #BGC_ID<TAB>BGC_NAME<TAB>RADIUS<TAB>MIBIG_URL<TAB>NCBI_URL<TAB>ASDB_URL
    456046<TAB>GCF_000156695.2/NZ_ABYX02000001.region019<TAB>430<TAB>n/a<TAB>https://...<TAB>n/a
    1234<TAB>BGC0001522.1<TAB>812<TAB>https://mibig...<TAB>n/a<TAB>n/a

Only `BGC_NAME` and `RADIUS` are read. The three URL columns are
convenience links for a human and carry no identifier the name column does
not already give; `BGC_ID` is BiG-FAM's own surrogate key and means
nothing outside BiG-FAM.

## BGC_NAME is two identifiers, not one

This is the part the join turns on, and the task it exists to get right::

    GCF_000156695.2/NZ_ABYX02000001.region019
    ---------------|-------------------------
    assembly        antiSMASH region on it

Both halves are useful and neither is redundant:

* the **left** half is what joins to GTDB, and therefore to the tree. It
  is an NCBI assembly accession — exactly the namespace
  `ingest/accession.py` resolves and `Genome.accession` stores.
* the **right** half is `{record}.region{NNN:03d}`, the identical
  convention `BGC.external_ref` already holds (see ingest/antismash.py and
  ingest/bigscape.py). Where the corpus already has that region as a BGC
  row, membership attaches to the existing row instead of a duplicate.

A MIBiG member is named differently — a bare `BGC0001522.1`, no slash —
because a MIBiG entry is a deposited locus with no assembly to sit on.
Those join on `BGC.mibig_accession`.

The slash is split here, once, and both halves then go through
`ingest/accession.py` like every other cross-source identifier in this
project. Nothing in this module strips a prefix or a version itself.

## Core vs putative members

`RADIUS` is BiG-FAM's distance from the member to the GCF's model —
**lower is closer**, so it is not a similarity and must not be read as
one. BiG-FAM's own GCF pages split the member list at 900: at or below is
a core member, above is putative.

Putative members are excluded by default. A GCF's taxonomic distribution
is the claim this whole feature renders, and quietly folding the weaker
half of the membership into it would overstate that claim in a way a
reader cannot see. `include_putative=True` opts in, and the report counts
what was left out either way.

## What is created, and what is refused

Where a member's assembly is a genome the corpus already holds but the
region is not yet a BGC row, the row is created. BiG-FAM is asserting a
concrete precomputed fact — antiSMASH called this region on this genome,
and BiG-SLiCE placed it in this family — so recording it is ingestion, not
computation. Such rows are `PREDICTED`, attributed to
`"antiSMASH (via BiG-FAM)"`, and carry `BGCClass.OTHER` because the export
states no class: the same fallback `ingest/mibig.py` and
`ingest/antismash.py` already use for a source that does not say.

Where the assembly is *not* in the corpus, the member is skipped and
counted. Creating the genome instead would mean inventing its taxonomy,
putting a node on the tree that no source placed there. That skipped count
is not a footnote — for most BiG-FAM GCFs it is the majority of the
membership, and `BigfamCoverage` exists so a caller can say "42 of 318
members are on genomes in this corpus" rather than presenting a fortieth
of a distribution as the whole of it.
"""
from __future__ import annotations

import csv
import gzip
import io
import re
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from pathlib import Path

from sqlalchemy.orm import Session

from bgcscape.ingest._util import IngestReport, get_or_create_or_update
from bgcscape.ingest.accession import (
    AccessionParseError,
    GenomeAccessionIndex,
    GenomeMatch,
    build_genome_accession_index,
    normalize_accession,
    resolve_genome,
)
from bgcscape.models import (
    BGC,
    BGCClass,
    AnalysisType,
    BGCFamily,
    BGCFamilyMembership,
    EvidenceLevel,
    FamilyKind,
    Genome,
    Source,
)
from bgcscape.coverage import get_or_create_analysis_run, record_coverage
from bgcscape.schemas import BGCCreate, BGCFamilyCreate, BGCFamilyMembershipCreate

#: The columns this loader actually reads. `BGC_ID` and the three `*_URL`
#: columns are tolerated and ignored — see module docstring.
_REQUIRED_COLUMNS = ("BGC_NAME", "RADIUS")

#: BiG-FAM's own split between core and putative members, taken from the
#: threshold its GCF detail pages use. Lower radius = closer to the model.
DEFAULT_CORE_RADIUS = 900.0

#: `n/a` is how the export spells an absent URL.
_EMPTY_VALUES = {"", "n/a", "na", "none", "null", "-"}

#: A MIBiG entry accession, with or without its version: `BGC0001522.1`.
_MIBIG_RE = re.compile(r"^(BGC\d{7})(?:\.\d+)?$", re.IGNORECASE)

#: `gcf_200948.tsv` / `200948.tsv`. Convenience only — the caller may
#: always state the id explicitly.
_GCF_ID_IN_NAME_RE = re.compile(r"(?:gcf[_-]?)?(\d{3,})", re.IGNORECASE)


class BigfamExportError(ValueError):
    """The file as a whole cannot be read as a BiG-FAM per-GCF export —
    absent, empty, or without the columns the format is defined by.

    Distinct from `BigfamParseError`, which is one bad row among good ones.
    A file-level problem is never recoverable by skipping rows, so it
    raises rather than being counted: a run that silently produced an empty
    GCF would look exactly like a GCF whose members are all outside the
    corpus, and those two are the opposite of each other.
    """


class BigfamParseError(ValueError):
    """One row is unusable. Counted, not fatal."""


@dataclass(frozen=True)
class ParsedBigfamMember:
    """One member row, with `BGC_NAME` already split into its two halves."""

    #: `BGC_NAME` verbatim — what a user recognises, and what belongs in an
    #: error message.
    name: str
    #: Assembly accession the region sits on; None for a MIBiG member.
    genome_accession: str | None
    #: antiSMASH region stem, joinable to `BGC.external_ref`; None for a
    #: MIBiG member.
    region_ref: str | None
    #: MIBiG accession, version stripped; None for a genome member.
    mibig_accession: str | None
    #: Distance to the GCF model. Lower is closer — NOT a similarity.
    radius: float | None

    def is_core(self, core_radius: float = DEFAULT_CORE_RADIUS) -> bool:
        return self.radius is not None and self.radius <= core_radius


@dataclass
class BigfamCoverage:
    """How much of a GCF this corpus can actually show.

    Reported so a caller never presents a fraction of a distribution as the
    whole of it. `members_total` is every row in the export; `placed` is
    the members that reached a genome in this corpus and are therefore
    visible on the tree.
    """

    gcf_label: str
    members_total: int = 0
    members_core: int = 0
    members_putative_skipped: int = 0
    placed: int = 0
    matched_existing_bgc: int = 0
    created_bgc: int = 0
    genome_not_in_corpus: int = 0
    ambiguous_accession: int = 0
    unparsable: int = 0
    #: Distinct genome accessions the placed members sit on — the tips the
    #: tree will actually highlight.
    placed_genome_accessions: set[str] = field(default_factory=set)

    @property
    def considered(self) -> int:
        """Members eligible for placement: total minus those excluded by the
        core/putative cut, which is a deliberate filter rather than a
        coverage failure."""
        return self.members_total - self.members_putative_skipped

    @property
    def coverage_fraction(self) -> float:
        return self.placed / self.considered if self.considered else 0.0

    def describe(self) -> str:
        """One line stating the limit, for the CLI and for a figure caption."""
        return (
            f"{self.gcf_label}: {self.placed} of {self.considered} member(s) "
            f"are on genomes in this corpus ({self.coverage_fraction:.0%}), "
            f"spanning {len(self.placed_genome_accessions)} genome(s). "
            f"{self.genome_not_in_corpus} member(s) sit on assemblies this corpus "
            f"does not hold and are not shown."
        )


def infer_gcf_id_from_filename(path: str | Path) -> str | None:
    """Best-effort `gcf_200948.tsv` -> `"200948"`. Returns None when the name
    carries no number, in which case the caller must be told the id rather
    than have one invented."""
    match = _GCF_ID_IN_NAME_RE.search(Path(path).stem)
    return match.group(1) if match else None


def _clean(value: str | None) -> str | None:
    if value is None:
        return None
    text = value.strip()
    return None if text.lower() in _EMPTY_VALUES else text


def parse_bigfam_member_row(row: dict[str, str]) -> ParsedBigfamMember:
    """Split one export row into the identifiers it actually contains.

    >>> m = parse_bigfam_member_row(
    ...     {"BGC_NAME": "GCF_000156695.2/NZ_ABYX02000001.region019", "RADIUS": "430"}
    ... )
    >>> (m.genome_accession, m.region_ref, m.is_core())
    ('GCF_000156695.2', 'NZ_ABYX02000001.region019', True)
    >>> parse_bigfam_member_row({"BGC_NAME": "BGC0001522.1", "RADIUS": "812"}).mibig_accession
    'BGC0001522'
    """
    name = _clean(row.get("BGC_NAME"))
    if not name:
        raise BigfamParseError(f"row has no BGC_NAME: {row!r}")

    radius_raw = _clean(row.get("RADIUS"))
    try:
        radius = float(radius_raw) if radius_raw is not None else None
    except ValueError:
        raise BigfamParseError(f"{name}: RADIUS {radius_raw!r} is not a number") from None

    if "/" in name:
        genome_part, _, region_part = name.partition("/")
        genome_accession = _clean(genome_part)
        region_ref = _clean(region_part)
        if not genome_accession or not region_ref:
            raise BigfamParseError(
                f"{name}: expected '<assembly>/<region>' with a value either side of the slash"
            )
        return ParsedBigfamMember(
            name=name,
            genome_accession=genome_accession,
            region_ref=region_ref,
            mibig_accession=None,
            radius=radius,
        )

    mibig = _MIBIG_RE.match(name)
    if mibig:
        return ParsedBigfamMember(
            name=name,
            genome_accession=None,
            region_ref=None,
            mibig_accession=mibig.group(1).upper(),
            radius=radius,
        )

    raise BigfamParseError(
        f"{name}: not a recognised BiG-FAM member name — expected "
        f"'<assembly>/<record>.regionNNN' or a MIBiG accession like 'BGC0001522.1'"
    )


def read_bigfam_export(path: str | Path) -> tuple[list[str], list[dict[str, str]]]:
    """Read a per-GCF export, returning `(columns, rows)`.

    Every way this file can be wrong raises `BigfamExportError` naming both
    the path and what was actually found, because the alternative — an
    empty result — is indistinguishable from a GCF whose members this
    corpus simply does not hold, and those two are opposite conclusions.
    Plain and gzipped files are both accepted; the rest of the reference
    data in `data/` ships gzipped and there is no reason this one may not.
    """
    file_path = Path(path)
    if not file_path.exists():
        raise BigfamExportError(
            f"BiG-FAM export not found: {file_path}\n"
            f"Download it from the GCF's detail page on bigfam.bioinformatics.nl — the "
            f"'export BGC list' link, i.e. /api/gcf/get_member_links?gcf_id=<id> — and save it "
            f"there. This file is placed by hand; nothing fetches it at runtime."
        )
    if file_path.stat().st_size == 0:
        raise BigfamExportError(f"BiG-FAM export is empty (0 bytes): {file_path}")

    opener = gzip.open if file_path.suffix == ".gz" else open
    try:
        with opener(file_path, "rt", encoding="utf-8", newline="") as fh:  # type: ignore[operator]
            text = fh.read()
    except (OSError, UnicodeDecodeError, EOFError) as exc:
        raise BigfamExportError(f"BiG-FAM export could not be read: {file_path}: {exc}") from exc

    if not text.strip():
        raise BigfamExportError(f"BiG-FAM export contains no data: {file_path}")

    reader = csv.reader(io.StringIO(text), delimiter="\t")
    try:
        header = next(reader)
    except StopIteration:  # pragma: no cover - guarded by the blank check above
        raise BigfamExportError(f"BiG-FAM export has no header line: {file_path}") from None

    # The real export prefixes its header with '#'. Stripping it here means
    # the column names used below are the ones a reader sees in the file.
    columns = [c.strip().lstrip("#").strip() for c in header]

    missing = [c for c in _REQUIRED_COLUMNS if c not in columns]
    if missing:
        raise BigfamExportError(
            f"{file_path} is not a BiG-FAM per-GCF export: missing column(s) "
            f"{', '.join(missing)}.\n"
            f"Found columns: {', '.join(columns) or '(none)'}\n"
            f"Expected the tab-separated file served by /api/gcf/get_member_links?gcf_id=<id>, "
            f"whose header is '#BGC_ID BGC_NAME RADIUS MIBIG_URL NCBI_URL ASDB_URL'."
        )

    rows = [dict(zip(columns, values)) for values in reader if any(v.strip() for v in values)]
    if not rows:
        raise BigfamExportError(
            f"{file_path} has a valid header but no member rows. A GCF with no members is not "
            f"something BiG-FAM publishes, so this is a truncated or failed download."
        )
    return columns, rows


def _find_bgc(
    session: Session,
    parsed: ParsedBigfamMember,
    genome_index: GenomeAccessionIndex,
) -> tuple[BGC | None, Genome | None, str]:
    """Resolve one member to a BGC row, in decreasing confidence.

    Returns `(bgc, genome, outcome)`. A non-None `genome` with a None `bgc`
    means "the assembly is in the corpus but this region is not a row yet",
    which is the caller's cue to create one.
    """
    if parsed.mibig_accession:
        bgc = session.query(BGC).filter_by(mibig_accession=parsed.mibig_accession).first()
        if bgc is not None:
            return bgc, bgc.genome, "mibig"
        return None, None, "genome_not_in_corpus"

    assert parsed.genome_accession is not None and parsed.region_ref is not None

    # The region stem is the same string antiSMASH and BiG-SCAPE ingestion
    # store, so an already-ingested region attaches to its existing row
    # rather than gaining a duplicate.
    bgc = session.query(BGC).filter_by(external_ref=parsed.region_ref).first()
    if bgc is not None:
        return bgc, bgc.genome, "region"

    genome_id, how = resolve_genome(genome_index, parsed.genome_accession)
    if how is GenomeMatch.AMBIGUOUS:
        return None, None, "ambiguous"
    if genome_id is None:
        return None, None, "genome_not_in_corpus"

    genome = session.get(Genome, genome_id)
    if genome is None:  # pragma: no cover - the index is built from this table
        return None, None, "genome_not_in_corpus"
    return None, genome, "genome"


def _record_accession(parsed: ParsedBigfamMember) -> str | None:
    """The nucleotide record a region sits on: `NZ_ABYX02000001` out of
    `NZ_ABYX02000001.region019`. Read through the shared normalizer, which
    already knows a region suffix from a version suffix."""
    if not parsed.region_ref:
        return None
    try:
        return normalize_accession(parsed.region_ref).value
    except AccessionParseError:  # pragma: no cover - region_ref is non-empty by construction
        return None


def load_bigfam_membership(
    session: Session,
    parsed: ParsedBigfamMember,
    family: BGCFamily | Callable[[], BGCFamily],
    source: Source,
    genome_index: GenomeAccessionIndex,
    coverage: BigfamCoverage,
) -> str:
    """Attach one member to `family`, creating its BGC row if the genome is
    held but the region is not. Returns the outcome for the report.

    `family` may be a callable, resolved only once a member has actually
    been placed. That is what keeps a GCF whose every member is outside
    this corpus from leaving an empty family row behind — one that would
    sit in the family browser reading "0 members" and invite a click that
    shows nothing.
    """
    bgc, genome, outcome = _find_bgc(session, parsed, genome_index)

    if bgc is None and genome is None:
        if outcome == "ambiguous":
            coverage.ambiguous_accession += 1
        else:
            coverage.genome_not_in_corpus += 1
        return outcome

    if bgc is None:
        assert genome is not None
        bgc_create = BGCCreate(
            genome_id=genome.id,
            contig=_record_accession(parsed),
            # The export states no class. OTHER is this project's existing
            # answer for a source that does not say (ingest/mibig.py,
            # ingest/antismash.py) — not a guess at the real class.
            bgc_class=BGCClass.OTHER,
            subtype=None,
            predicted_by_tool="antiSMASH (via BiG-FAM)",
            external_ref=parsed.region_ref,
            # The member name is kept verbatim so the row can always be
            # traced back to the export line that created it.
            raw_annotation={"bigfam_member_name": parsed.name, "bigfam_radius": parsed.radius},
            source_id=source.id,
            evidence_level=EvidenceLevel.PREDICTED,
        )
        bgc, _ = get_or_create_or_update(
            session,
            BGC,
            lookup={"genome_id": genome.id, "external_ref": parsed.region_ref},
            values=bgc_create.model_dump(exclude={"genome_id", "external_ref"}),
        )
        session.flush()
        coverage.created_bgc += 1
    else:
        coverage.matched_existing_bgc += 1

    resolved_family = family() if callable(family) else family
    membership_create = BGCFamilyMembershipCreate(
        bgc_id=bgc.id,
        family_id=resolved_family.id,
        # BiG-FAM's radius is a DISTANCE to the family model: lower is
        # closer. Stored as published rather than inverted into a
        # similarity, because inventing a scale conversion would misreport
        # the number the source actually gave.
        similarity_score=parsed.radius,
    )
    _, created = get_or_create_or_update(
        session,
        BGCFamilyMembership,
        lookup={"bgc_id": bgc.id, "family_id": resolved_family.id},
        values=membership_create.model_dump(exclude={"bgc_id", "family_id"}),
    )

    coverage.placed += 1
    target_genome = genome if genome is not None else bgc.genome
    if target_genome is not None:
        coverage.placed_genome_accessions.add(target_genome.accession)
    return "created" if created else "updated"


def get_or_create_bigfam_family(
    session: Session,
    source: Source,
    gcf_label: str,
    *,
    clustering_method: str = "BiG-SLiCE (BiG-FAM)",
    core_radius: float = DEFAULT_CORE_RADIUS,
) -> BGCFamily:
    """The `BGCFamily` row for one GCF.

    `kind` is `SEQUENCE_FAMILY`, and that is the point of this whole
    module: BiG-SLiCE groups clusters by gene content and domain
    architecture, so these are the real thing — the only kind the
    prioritization scorer's similarity components are defined over. Keyed
    on `(source_id, label, clustering_cutoff)` for the same reason
    `ingest/bigscape.py` is: a family label means nothing outside the run
    and threshold that produced it.
    """
    family_create = BGCFamilyCreate(
        label=gcf_label,
        kind=FamilyKind.SEQUENCE_FAMILY,
        clustering_method=clustering_method,
        clustering_cutoff=core_radius,
        source_id=source.id,
        evidence_level=EvidenceLevel.COMPUTED,
    )
    family, _ = get_or_create_or_update(
        session,
        BGCFamily,
        lookup={"source_id": source.id, "label": gcf_label, "clustering_cutoff": core_radius},
        values=family_create.model_dump(exclude={"label", "source_id", "clustering_cutoff"}),
    )
    session.flush()
    return family


def ingest_bigfam_gcf(
    session: Session,
    source: Source,
    rows: Iterator[dict[str, str]] | list[dict[str, str]],
    *,
    gcf_label: str,
    include_putative: bool = False,
    core_radius: float = DEFAULT_CORE_RADIUS,
    clustering_method: str = "BiG-SLiCE (BiG-FAM)",
    tool_version: str = "unknown",
) -> tuple[IngestReport, BigfamCoverage]:
    """Load one GCF's membership. Each row commits individually — see
    `get_or_create_or_update`'s docstring for why.

    Returns the usual `IngestReport` plus a `BigfamCoverage`, which is the
    number a caller must not omit: it says how much of the family this
    corpus is able to show.
    """
    report = IngestReport()
    coverage = BigfamCoverage(gcf_label=gcf_label)

    genome_index = build_genome_accession_index(
        [(gid, accession) for gid, accession in session.query(Genome.id, Genome.accession).all()]
    )

    # Created on first placement, not up front: a GCF whose members are all
    # outside this corpus is a normal outcome for BiG-FAM (its families are
    # defined over 1.2M BGCs), and it should leave no trace rather than an
    # empty family sitting in the browser.
    created_family: BGCFamily | None = None

    def family_factory() -> BGCFamily:
        nonlocal created_family
        if created_family is None:
            created_family = get_or_create_bigfam_family(
                session,
                source,
                gcf_label,
                clustering_method=clustering_method,
                core_radius=core_radius,
            )
        return created_family

    for row in rows:
        coverage.members_total += 1
        identifier = row.get("BGC_NAME") or "<unknown>"
        try:
            parsed = parse_bigfam_member_row(row)
        except BigfamParseError as exc:
            coverage.unparsable += 1
            report.record_error(identifier, str(exc))
            continue

        if parsed.is_core(core_radius):
            coverage.members_core += 1
        elif not include_putative:
            # Excluded on purpose, not a failure — counted so the caller can
            # say the distribution is the core membership only.
            coverage.members_putative_skipped += 1
            report.skipped += 1
            continue

        try:
            outcome = load_bigfam_membership(
                session, parsed, family_factory, source, genome_index, coverage
            )
            session.commit()
        except Exception as exc:  # noqa: BLE001 - one bad row shouldn't abort a bulk load
            report.record_error(identifier, f"{type(exc).__name__}: {exc}")
            session.rollback()
            continue

        if outcome == "created":
            report.created += 1
        elif outcome == "updated":
            report.updated += 1
        else:
            report.skipped += 1

    # Coverage over the genomes this GCF actually reached IN THIS CORPUS.
    # Deliberately not the whole family: BiG-FAM's GCFs are defined over
    # 1.2M BGCs, and claiming coverage of members whose assemblies are not
    # here would assert a comparison this database cannot show — the same
    # thing `BigfamCoverage` already exists to stop a caller doing in prose.
    if coverage.placed_genome_accessions:
        run = get_or_create_analysis_run(
            session,
            source=source,
            analysis_type=AnalysisType.SEQUENCE_CLUSTERING,
            tool="BiG-SLiCE (BiG-FAM)",
            tool_version=tool_version,
            label=gcf_label,
            parameters={"core_radius": core_radius, "include_putative": include_putative},
        )
        placed = (
            session.query(Genome)
            .filter(Genome.accession.in_(coverage.placed_genome_accessions))
            .all()
        )
        for genome in placed:
            record_coverage(
                session,
                run,
                genome,
                bgcs_recorded=sum(
                    1 for _ in session.query(BGC.id).filter(BGC.genome_id == genome.id)
                ),
            )
        session.commit()

    return report, coverage
