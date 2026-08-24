from __future__ import annotations

from pathlib import Path

import pytest

from bgcscape.ingest.antismash import ingest_antismash_result, read_antismash_result
from bgcscape.ingest.bigscape import (
    BigscapeParseError,
    ingest_bigscape_clustering,
    load_bigscape_membership,
    parse_bigscape_clustering_row,
    parse_cutoff_from_filename,
    read_bigscape_clustering_tsv,
)
from bgcscape.models import BGC, BGCFamily, BGCFamilyMembership
from bgcscape.models.base import EvidenceLevel

FIXTURES = Path(__file__).parent / "fixtures"
CLUSTERING_TSV = FIXTURES / "mix_clustering_c0.3.tsv"
ANTISMASH_RESULT = FIXTURES / "antismash_test_result.json"


@pytest.fixture()
def ingested_bgcs(session, antismash_tool_source):
    """Real prerequisite state: BGCs with external_ref values already
    populated by antiSMASH ingestion, exactly as a real pipeline would
    have them before BiG-SCAPE ingestion runs."""
    raw = read_antismash_result(ANTISMASH_RESULT)
    ingest_antismash_result(session, antismash_tool_source, raw, genome_accession="GCF_TEST900001.1")
    return session.query(BGC).all()


# --- parser tests (pure, no DB) -------------------------------------------------


def test_parse_cutoff_from_real_bigscape_filename_convention():
    # Confirmed against BiG-SCAPE's own source:
    # f"{bin_label}_clustering_c{cutoff}.tsv"
    assert parse_cutoff_from_filename("mix_clustering_c0.3.tsv") == pytest.approx(0.3)
    assert parse_cutoff_from_filename("/some/path/NRPS_clustering_c0.75.tsv") == pytest.approx(0.75)
    assert parse_cutoff_from_filename("not_a_matching_name.tsv") is None


def test_parse_clustering_row():
    rows = list(read_bigscape_clustering_tsv(CLUSTERING_TSV))
    parsed = parse_bigscape_clustering_row(rows[0])
    assert parsed.gbk_stem == "NZ_TEST0000001.1.region001"
    assert parsed.family_label == "FAM_00001"
    assert parsed.connected_component == "1"


def test_parse_row_missing_gbk_raises():
    with pytest.raises(BigscapeParseError):
        parse_bigscape_clustering_row({"Family": "FAM_00001"})


def test_parse_row_empty_family_raises():
    with pytest.raises(BigscapeParseError):
        parse_bigscape_clustering_row({"GBK": "some.region001", "Family": ""})


# --- loader tests (DB), using real antiSMASH-ingested BGCs as prerequisite state ----


def test_membership_links_to_the_correct_antismash_bgc(session, ingested_bgcs, bigscape_tool_source):
    rows = list(read_bigscape_clustering_tsv(CLUSTERING_TSV))
    parsed = parse_bigscape_clustering_row(rows[0])  # NZ_TEST0000001.1.region001 -> FAM_00001

    membership, outcome = load_bigscape_membership(
        session, parsed, bigscape_tool_source, cutoff=0.3, clustering_method="BiG-SCAPE 2.0"
    )
    session.commit()

    assert outcome == "created"
    target_bgc = session.query(BGC).filter_by(external_ref="NZ_TEST0000001.1.region001").one()
    assert membership.bgc_id == target_bgc.id
    assert membership.family.label == "FAM_00001"
    assert membership.family.clustering_cutoff == pytest.approx(0.3)
    assert membership.family.evidence_level is EvidenceLevel.COMPUTED


def test_two_regions_in_the_same_family_share_one_family_row(session, ingested_bgcs, bigscape_tool_source):
    rows = list(read_bigscape_clustering_tsv(CLUSTERING_TSV))
    # Rows 0 and 1 are both FAM_00001 in the fixture.
    for row in rows[:2]:
        parsed = parse_bigscape_clustering_row(row)
        load_bigscape_membership(session, parsed, bigscape_tool_source, cutoff=0.3, clustering_method="BiG-SCAPE")
        session.commit()

    assert session.query(BGCFamily).count() == 1
    family = session.query(BGCFamily).one()
    assert len(family.memberships) == 2


def test_row_with_no_matching_bgc_is_reported_not_errored(session, ingested_bgcs, bigscape_tool_source):
    # Row 3 in the fixture ("BGC-TEST0000001") simulates a MIBiG reference
    # entry mixed into the BiG-SCAPE run -- MIBiG ingestion never sets
    # external_ref, so this deliberately can't match anything.
    rows = list(read_bigscape_clustering_tsv(CLUSTERING_TSV))
    parsed = parse_bigscape_clustering_row(rows[3])
    assert parsed.gbk_stem == "BGC-TEST0000001"

    membership, outcome = load_bigscape_membership(
        session, parsed, bigscape_tool_source, cutoff=0.3, clustering_method="BiG-SCAPE"
    )
    assert membership is None
    assert outcome == "no_matching_bgc"


def test_same_label_at_different_cutoffs_are_different_families(session, ingested_bgcs, bigscape_tool_source):
    rows = list(read_bigscape_clustering_tsv(CLUSTERING_TSV))
    parsed = parse_bigscape_clustering_row(rows[0])  # FAM_00001

    load_bigscape_membership(session, parsed, bigscape_tool_source, cutoff=0.3, clustering_method="BiG-SCAPE")
    session.commit()
    load_bigscape_membership(session, parsed, bigscape_tool_source, cutoff=0.7, clustering_method="BiG-SCAPE")
    session.commit()

    families = session.query(BGCFamily).filter_by(label="FAM_00001").all()
    assert len(families) == 2
    cutoffs = sorted(f.clustering_cutoff for f in families)
    assert cutoffs == pytest.approx([0.3, 0.7])


def test_membership_upsert_is_idempotent(session, ingested_bgcs, bigscape_tool_source):
    rows = list(read_bigscape_clustering_tsv(CLUSTERING_TSV))
    parsed = parse_bigscape_clustering_row(rows[0])

    load_bigscape_membership(session, parsed, bigscape_tool_source, cutoff=0.3, clustering_method="BiG-SCAPE")
    session.commit()
    m2, outcome2 = load_bigscape_membership(
        session, parsed, bigscape_tool_source, cutoff=0.3, clustering_method="BiG-SCAPE"
    )
    session.commit()

    assert outcome2 == "updated"
    assert session.query(BGCFamilyMembership).count() == 1
    assert session.query(BGCFamily).count() == 1


# --- orchestration tests -----------------------------------------------------------


def test_ingest_full_clustering_file_end_to_end(session, ingested_bgcs, bigscape_tool_source):
    rows = read_bigscape_clustering_tsv(CLUSTERING_TSV)
    report = ingest_bigscape_clustering(
        session, bigscape_tool_source, rows, cutoff=0.3, clustering_method="BiG-SCAPE 2.0"
    )

    assert report.created == 3  # 3 rows matched a real BGC
    assert report.skipped == 1  # the MIBiG-reference-style unmatched row
    assert report.errors == []
    assert session.query(BGCFamily).count() == 2  # FAM_00001 (2 members) + FAM_00002 (1 member)
    assert session.query(BGCFamilyMembership).count() == 3
