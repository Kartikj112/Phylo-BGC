from __future__ import annotations

import json
from pathlib import Path

import pytest

from bgcscape.ingest.antismash import (
    AntismashParseError,
    ingest_antismash_result,
    load_antismash_result,
    parse_antismash_result,
    read_antismash_result,
    region_external_ref,
)
from bgcscape.models import BGC, BGCClass, Genome
from bgcscape.models.base import EvidenceLevel
from bgcscape.models.genome import AssemblyLevel

FIXTURES = Path(__file__).parent / "fixtures"
RESULT_PATH = FIXTURES / "antismash_test_result.json"


def _load_fixture() -> dict:
    return json.loads(RESULT_PATH.read_text())


# --- parser tests (pure, no DB) -------------------------------------------------


def test_region_external_ref_matches_real_antismash_filename_convention():
    # Confirmed against antiSMASH's own source:
    # f"{record.id}.region{number:03d}.gbk" — this is that, minus ".gbk".
    assert region_external_ref("NZ_TEST0000001.1", 1) == "NZ_TEST0000001.1.region001"
    assert region_external_ref("NZ_TEST0000001.1", 12) == "NZ_TEST0000001.1.region012"


def test_parse_result_finds_every_region_across_every_record():
    parsed = parse_antismash_result(_load_fixture(), genome_accession="GCF_TEST900001.1")
    assert parsed.genome_accession == "GCF_TEST900001.1"
    assert len(parsed.regions) == 3
    assert {r.contig for r in parsed.regions} == {"NZ_TEST0000001.1", "NZ_TEST0000002.1"}


def test_parse_single_class_region():
    parsed = parse_antismash_result(_load_fixture(), genome_accession="GCF_TEST900001.1")
    region = next(r for r in parsed.regions if r.external_ref == "NZ_TEST0000001.1.region001")
    assert region.bgc_class is BGCClass.NRPS
    assert region.subtype is None
    assert region.start_coord == 104200
    assert region.end_coord == 128650
    assert region.antismash_version == "7.1.0-test"


def test_parse_hybrid_region_maps_to_hybrid_with_joined_subtype():
    parsed = parse_antismash_result(_load_fixture(), genome_accession="GCF_TEST900001.1")
    region = next(r for r in parsed.regions if r.external_ref == "NZ_TEST0000001.1.region002")
    assert region.bgc_class is BGCClass.HYBRID
    # BGCClass values, not antiSMASH's own category names: the frontend
    # splits this on "+" against its lowercase class vocabulary, so
    # "NRPS+PKS" here made an uploaded hybrid match no class filter at all
    # and vanish from the tree. Same contract MIBiG ingestion follows.
    assert region.subtype == "nrps+pks"


def test_parse_terpene_region_on_second_record():
    parsed = parse_antismash_result(_load_fixture(), genome_accession="GCF_TEST900001.1")
    region = next(r for r in parsed.regions if r.external_ref == "NZ_TEST0000002.1.region001")
    assert region.bgc_class is BGCClass.TERPENE
    assert region.contig == "NZ_TEST0000002.1"


def test_parse_missing_required_field_raises():
    broken = _load_fixture()
    del broken["records"][0]["areas"]
    with pytest.raises(AntismashParseError, match="areas"):
        parse_antismash_result(broken, genome_accession="GCF_TEST900001.1")


def test_parse_missing_version_raises():
    broken = _load_fixture()
    del broken["version"]
    with pytest.raises(AntismashParseError, match="version"):
        parse_antismash_result(broken, genome_accession="GCF_TEST900001.1")


def test_read_antismash_result_from_file():
    raw = read_antismash_result(RESULT_PATH)
    assert raw["version"] == "7.1.0-test"
    assert len(raw["records"]) == 2


# --- loader tests (DB) -----------------------------------------------------------


def test_load_creates_genome_stub_when_none_exists(session, antismash_tool_source):
    parsed = parse_antismash_result(_load_fixture(), genome_accession="GCF_TEST900001.1")
    genome, report = load_antismash_result(session, parsed, antismash_tool_source)
    session.commit()

    assert genome.accession == "GCF_TEST900001.1"
    assert genome.assembly_level is AssemblyLevel.UNKNOWN
    assert genome.evidence_level is EvidenceLevel.PREDICTED
    assert report.created == 3
    assert session.query(BGC).count() == 3


def test_load_reuses_existing_genome_without_overwriting_real_data(session, antismash_tool_source, gtdb_source):
    # A genome already ingested from GTDB, with real assembly-level data.
    real_genome = Genome(
        accession="GCF_TEST900001.1",
        assembly_level=AssemblyLevel.COMPLETE_GENOME,
        is_mag=False,
        completeness_pct=99.9,
        source_id=gtdb_source.id,
        evidence_level=EvidenceLevel.OBSERVED_CURATED,
    )
    session.add(real_genome)
    session.commit()

    parsed = parse_antismash_result(_load_fixture(), genome_accession="GCF_TEST900001.1")
    genome, report = load_antismash_result(session, parsed, antismash_tool_source)
    session.commit()

    # Same row, not a duplicate -- and antiSMASH's UNKNOWN/False guesses
    # must NOT have clobbered GTDB's real values.
    assert genome.id == real_genome.id
    assert genome.assembly_level is AssemblyLevel.COMPLETE_GENOME
    assert genome.completeness_pct == 99.9
    assert genome.evidence_level is EvidenceLevel.OBSERVED_CURATED
    assert session.query(Genome).count() == 1
    assert report.created == 3  # the 3 BGCs are still new


def test_bgc_external_ref_and_provenance(session, antismash_tool_source):
    parsed = parse_antismash_result(_load_fixture(), genome_accession="GCF_TEST900001.1")
    load_antismash_result(session, parsed, antismash_tool_source)
    session.commit()

    bgc = session.query(BGC).filter_by(external_ref="NZ_TEST0000001.1.region002").one()
    assert bgc.bgc_class is BGCClass.HYBRID
    assert bgc.subtype == "nrps+pks"
    assert bgc.evidence_level is EvidenceLevel.PREDICTED
    assert bgc.predicted_by_tool == "antiSMASH 7.1.0-test"
    assert bgc.raw_annotation["region_number"] == 2


def test_load_is_idempotent(session, antismash_tool_source):
    parsed = parse_antismash_result(_load_fixture(), genome_accession="GCF_TEST900001.1")
    load_antismash_result(session, parsed, antismash_tool_source)
    session.commit()
    genome_2, report_2 = load_antismash_result(session, parsed, antismash_tool_source)
    session.commit()

    assert report_2.created == 0
    assert report_2.updated == 3
    assert session.query(BGC).count() == 3
    assert session.query(Genome).count() == 1


# --- orchestration tests -----------------------------------------------------------


def test_ingest_antismash_result_end_to_end(session, antismash_tool_source):
    raw = read_antismash_result(RESULT_PATH)
    report = ingest_antismash_result(session, antismash_tool_source, raw, genome_accession="GCF_TEST900001.1")

    assert report.created == 3
    assert report.errors == []
    assert session.query(BGC).count() == 3


def test_ingest_antismash_result_records_parse_error(session, antismash_tool_source):
    broken = _load_fixture()
    del broken["records"]
    report = ingest_antismash_result(session, antismash_tool_source, broken, genome_accession="GCF_TEST900001.1")

    assert report.created == 0
    assert len(report.errors) == 1
    assert report.errors[0][0] == "GCF_TEST900001.1"
