"""BiG-SCAPE family-clustering ingestion.

Targets BiG-SCAPE's real `*_clustering_c{cutoff}.tsv` output format,
verified against the `medema-group/BiG-SCAPE` source on GitHub
(`big_scape/output/legacy_output.py::write_clustering_file`) rather than
assumed. Real, verified columns: `Record`, `GBK`, `Record_Type`,
`Record_Number`, `CC`, `Family`.

`GBK` is the per-region GenBank filename *stem* BiG-SCAPE read its input
from — which is exactly antiSMASH's own per-region filename convention
(`{record_id}.region{NNN:03d}`, confirmed in antiSMASH's source — see
ingest/antismash.py). This is the real join key between the two tools'
outputs, not a convention Phylo-BGC invented: `BGC.external_ref`
(populated by antiSMASH ingestion) is matched directly against this
column, with no transformation needed.

A family label like `"FAM_00001"` is only meaningful *within one cutoff* —
re-running BiG-SCAPE at a different similarity cutoff produces materially
different groupings that can reuse the same label for unrelated families.
Family lookup is keyed on `(source_id, label, clustering_cutoff)`, never
label alone.

Rows whose `GBK` doesn't match any known `BGC.external_ref` are expected,
not errors, and are counted as `skipped` distinctly from parse errors.

Note that MIBiG reference BGCs — which real BiG-SCAPE input commonly mixes
in for comparison — DO match: MIBiG ships one GenBank per entry named
`<accession>.gbk`, so MIBiG ingestion sets `external_ref` to the accession
(see ingest/mibig.py). Capturing those rows is the point: they say which
characterized cluster a novel one groups with. Only records from neither
source remain unmatched.
"""
from __future__ import annotations

import csv
import re
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy.orm import Session

from bgcscape.ingest._util import IngestReport, get_or_create_or_update
from bgcscape.models import BGC, BGCFamily, BGCFamilyMembership, EvidenceLevel, FamilyKind, Source
from bgcscape.schemas import BGCFamilyCreate, BGCFamilyMembershipCreate

_CUTOFF_FROM_FILENAME = re.compile(r"_c(\d+\.?\d*)\.tsv$")


class BigscapeParseError(ValueError):
    pass


@dataclass
class ParsedBigscapeMembership:
    gbk_stem: str  # join key against BGC.external_ref
    family_label: str
    connected_component: str | None


def parse_cutoff_from_filename(path: str | Path) -> float | None:
    """`mix_clustering_c0.3.tsv` -> 0.3, matching BiG-SCAPE's own filename
    convention (`f"{bin_label}_clustering_c{cutoff}.tsv"`, verified in its
    source). Convenience only — returns None if the filename doesn't match
    the pattern, in which case the caller must supply cutoff explicitly.
    """
    match = _CUTOFF_FROM_FILENAME.search(Path(path).name)
    return float(match.group(1)) if match else None


def parse_bigscape_clustering_row(row: dict[str, str]) -> ParsedBigscapeMembership:
    try:
        gbk_stem = row["GBK"]
        family_label = row["Family"]
    except KeyError as exc:
        raise BigscapeParseError(f"clustering row missing required column: {exc}") from exc
    if not gbk_stem or not family_label:
        raise BigscapeParseError(f"clustering row has an empty GBK or Family value: {row}")
    return ParsedBigscapeMembership(
        gbk_stem=gbk_stem,
        family_label=family_label,
        connected_component=row.get("CC") or None,
    )


def load_bigscape_membership(
    session: Session,
    parsed: ParsedBigscapeMembership,
    source: Source,
    *,
    cutoff: float,
    clustering_method: str,
) -> tuple[BGCFamilyMembership | None, str]:
    """Upsert one family membership.

    Returns `(membership_or_None, outcome)`, outcome one of "created",
    "updated", "no_matching_bgc" (see module docstring for why the last
    one is expected, not an error).
    """
    bgc = session.query(BGC).filter_by(external_ref=parsed.gbk_stem).one_or_none()
    if bgc is None:
        return None, "no_matching_bgc"

    family_create = BGCFamilyCreate(
        label=parsed.family_label,
        # BiG-SCAPE compares sequences, so these are the real thing — the
        # only kind the prioritization scorer's similarity components read.
        kind=FamilyKind.SEQUENCE_FAMILY,
        clustering_method=clustering_method,
        clustering_cutoff=cutoff,
        source_id=source.id,
        evidence_level=EvidenceLevel.COMPUTED,
    )
    family, _ = get_or_create_or_update(
        session,
        BGCFamily,
        lookup={"source_id": source.id, "label": parsed.family_label, "clustering_cutoff": cutoff},
        values=family_create.model_dump(exclude={"label", "source_id", "clustering_cutoff"}),
    )
    session.flush()

    membership_create = BGCFamilyMembershipCreate(bgc_id=bgc.id, family_id=family.id, similarity_score=None)
    membership, created = get_or_create_or_update(
        session,
        BGCFamilyMembership,
        lookup={"bgc_id": bgc.id, "family_id": family.id},
        values=membership_create.model_dump(exclude={"bgc_id", "family_id"}),
    )
    return membership, "created" if created else "updated"


def read_bigscape_clustering_tsv(path: str | Path) -> Iterator[dict[str, str]]:
    """Yield rows from a BiG-SCAPE `*_clustering_c{cutoff}.tsv` file."""
    with open(Path(path), newline="", encoding="utf-8") as fh:
        yield from csv.DictReader(fh, delimiter="\t")


def ingest_bigscape_clustering(
    session: Session,
    source: Source,
    rows: Iterator[dict[str, str]] | list[dict[str, str]],
    *,
    cutoff: float,
    clustering_method: str = "BiG-SCAPE",
) -> IngestReport:
    """Load a batch of clustering rows. Each row commits individually —
    see get_or_create_or_update()'s docstring for why."""
    report = IngestReport()
    for row in rows:
        identifier = row.get("GBK", "<unknown>")
        try:
            parsed = parse_bigscape_clustering_row(row)
        except BigscapeParseError as exc:
            report.record_error(identifier, str(exc))
            continue

        try:
            _, outcome = load_bigscape_membership(
                session, parsed, source, cutoff=cutoff, clustering_method=clustering_method
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

    return report
