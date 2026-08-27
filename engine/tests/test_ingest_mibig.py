from __future__ import annotations

import json
from pathlib import Path

import pytest

from bgcscape.ingest.mibig import (
    MibigParseError,
    ingest_mibig_entries,
    load_mibig_entry,
    parse_mibig_entry,
    read_mibig_entries_from_path,
)
from bgcscape.models import BGC, BGCClass, Compound, Genome, Taxon
from bgcscape.models.base import EvidenceLevel
from bgcscape.models.genome import AssemblyLevel

FIXTURES = Path(__file__).parent / "fixtures" / "mibig"


def _load_fixture(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text())


# --- parser tests (pure, no DB) -------------------------------------------------


def test_parse_single_class_entry():
    parsed = parse_mibig_entry(_load_fixture("mibig_test_entry_active_single_class.json"))

    assert parsed.mibig_accession == "BGC-TEST0000001"
    assert parsed.status == "active"
    assert parsed.locus_accession == "XX999901.1"
    assert parsed.start_coord == 1
    assert parsed.end_coord == 24500
    assert parsed.organism_name == "Streptomyces testomycini"
    assert parsed.ncbi_taxid == 9999901
    assert parsed.bgc_class is BGCClass.NRPS
    assert parsed.subtype is None
    assert len(parsed.compounds) == 1

    compound = parsed.compounds[0]
    assert compound.name == "Testomycin A"
    assert compound.chemical_formula == "C10H15N3O2S"
    assert compound.pubchem_cid == 19990001
    assert compound.mibig_compound_ref == "BGC-TEST0000001:0"
    assert compound.link_reference == "NMR; Mass spectrometry"


def test_parse_hybrid_class_entry_maps_to_hybrid_with_joined_subtype():
    parsed = parse_mibig_entry(_load_fixture("mibig_test_entry_active_hybrid_class.json"))

    assert parsed.bgc_class is BGCClass.HYBRID
    # Canonical BGCClass values, not MIBiG's own vocabulary — the frontend
    # splits this on "+" and matches it against the class filter.
    assert parsed.subtype == "nrps+pks"
    assert len(parsed.compounds) == 2
    assert {c.name for c in parsed.compounds} == {"Testomycin B1", "Testomycin B2"}
    # Second compound has no databaseIds at all.
    b2 = next(c for c in parsed.compounds if c.name == "Testomycin B2")
    assert b2.pubchem_cid is None


def test_parse_retired_entry_still_parses_successfully():
    """Parsing succeeds regardless of status — filtering by status is the
    orchestration layer's job (ingest_mibig_entries), not the parser's."""
    parsed = parse_mibig_entry(_load_fixture("mibig_test_entry_retired.json"))
    assert parsed.status == "retired"
    assert parsed.bgc_class is BGCClass.OTHER


def test_parse_missing_required_field_raises():
    broken = _load_fixture("mibig_test_entry_active_single_class.json")
    del broken["loci"]
    with pytest.raises(MibigParseError, match="loci"):
        parse_mibig_entry(broken)


def test_parse_empty_loci_list_raises():
    broken = _load_fixture("mibig_test_entry_active_single_class.json")
    broken["loci"] = []
    with pytest.raises(MibigParseError, match="no loci"):
        parse_mibig_entry(broken)


# --- loader tests (DB) -----------------------------------------------------------


def test_load_mibig_entry_creates_full_graph(session, mibig_source):
    parsed = parse_mibig_entry(_load_fixture("mibig_test_entry_active_single_class.json"))
    bgc, created = load_mibig_entry(session, parsed, mibig_source)
    session.commit()

    assert created is True
    assert bgc.mibig_accession == "BGC-TEST0000001"
    assert bgc.bgc_class is BGCClass.NRPS
    assert bgc.evidence_level is EvidenceLevel.OBSERVED_CURATED

    genome = session.get(Genome, bgc.genome_id)
    assert genome.accession == "XX999901.1"
    assert genome.assembly_level is AssemblyLevel.LOCUS
    assert genome.genome_size_bp == 24499  # end - start
    assert genome.completeness_pct is None  # not meaningful for a locus stub

    taxon = session.get(Taxon, genome.taxon_id)
    assert taxon.name == "Streptomyces testomycini"
    assert taxon.ncbi_taxid == 9999901

    assert len(bgc.compound_links) == 1
    compound = bgc.compound_links[0].compound
    assert compound.name == "Testomycin A"
    assert compound.pubchem_cid == 19990001


def test_load_mibig_entry_is_idempotent(session, mibig_source):
    raw = _load_fixture("mibig_test_entry_active_single_class.json")
    parsed = parse_mibig_entry(raw)

    bgc1, created1 = load_mibig_entry(session, parsed, mibig_source)
    session.commit()
    bgc2, created2 = load_mibig_entry(session, parsed, mibig_source)
    session.commit()

    assert created1 is True
    assert created2 is False
    assert bgc1.id == bgc2.id
    assert session.query(BGC).count() == 1
    assert session.query(Genome).count() == 1
    assert session.query(Compound).count() == 1


def test_two_entries_sharing_ncbi_taxid_share_one_taxon(session, mibig_source):
    parsed_1 = parse_mibig_entry(_load_fixture("mibig_test_entry_active_single_class.json"))
    parsed_2 = parse_mibig_entry(_load_fixture("mibig_test_entry_active_hybrid_class.json"))
    assert parsed_1.ncbi_taxid == parsed_2.ncbi_taxid  # fixture precondition

    bgc_1, _ = load_mibig_entry(session, parsed_1, mibig_source)
    session.commit()
    bgc_2, _ = load_mibig_entry(session, parsed_2, mibig_source)
    session.commit()

    genome_1 = session.get(Genome, bgc_1.genome_id)
    genome_2 = session.get(Genome, bgc_2.genome_id)
    assert genome_1.taxon_id == genome_2.taxon_id
    assert session.query(Taxon).count() == 1


# --- orchestration tests -----------------------------------------------------------


def test_ingest_skips_retired_entries_by_default(session, mibig_source):
    entries = [_load_fixture("mibig_test_entry_retired.json")]
    report = ingest_mibig_entries(session, mibig_source, entries)

    assert report.created == 0
    assert report.skipped == 1
    assert report.errors == []
    assert session.query(BGC).count() == 0


def test_ingest_include_non_active_loads_retired_entries(session, mibig_source):
    entries = [_load_fixture("mibig_test_entry_retired.json")]
    report = ingest_mibig_entries(session, mibig_source, entries, include_non_active=True)

    assert report.created == 1
    assert report.skipped == 0
    assert session.query(BGC).count() == 1


def test_ingest_records_parse_errors_without_aborting_batch(session, mibig_source):
    good = _load_fixture("mibig_test_entry_active_single_class.json")
    broken = _load_fixture("mibig_test_entry_active_hybrid_class.json")
    del broken["taxonomy"]  # will raise MibigParseError

    report = ingest_mibig_entries(session, mibig_source, [good, broken])

    assert report.created == 1
    assert len(report.errors) == 1
    assert report.errors[0][0] == "BGC-TEST0000002"
    # The good entry that came before the broken one must still be persisted
    # — a batch-wide rollback on the second entry's failure must not have
    # discarded the first entry's already-committed work.
    assert session.query(BGC).count() == 1


def test_read_mibig_entries_from_fixtures_directory():
    entries = list(read_mibig_entries_from_path(FIXTURES))
    accessions = {e["accession"] for e in entries}
    assert accessions == {"BGC-TEST0000001", "BGC-TEST0000002", "BGC-TEST0000003"}


def test_read_mibig_entries_skips_non_mibig_json_in_a_mixed_directory(tmp_path):
    """A directory holding another tool's JSON alongside MIBiG entries
    should yield only the MIBiG ones, not feed foreign JSON into the
    parser and produce confusing "missing required field" errors. This
    project hit exactly that when an antiSMASH fixture landed in a shared
    fixture directory.
    """
    import shutil

    shutil.copy(FIXTURES / "mibig_test_entry_active_single_class.json", tmp_path)
    shutil.copy(FIXTURES.parent / "antismash_test_result.json", tmp_path)

    entries = list(read_mibig_entries_from_path(tmp_path))
    assert [e["accession"] for e in entries] == ["BGC-TEST0000001"]


def test_ingest_full_fixture_directory_end_to_end(session, mibig_source):
    entries = read_mibig_entries_from_path(FIXTURES)
    report = ingest_mibig_entries(session, mibig_source, entries)

    # 2 active (single-class + hybrid) created, 1 retired skipped.
    assert report.created == 2
    assert report.skipped == 1
    assert report.errors == []
    assert session.query(BGC).count() == 2
    # Both active entries share an organism -> one Taxon, not two.
    assert session.query(Taxon).count() == 1


# --- MIBiG 3.x format (the schema the public repository actually ships) ----------

V3_FIXTURES = Path(__file__).parent / "fixtures" / "mibig_v3"


def _v3(name: str) -> dict:
    return json.loads((V3_FIXTURES / name).read_text())


def test_detects_v3_and_v4_schemas():
    from bgcscape.ingest.mibig import detect_mibig_schema

    v3 = _v3(sorted(p.name for p in V3_FIXTURES.glob("*.json"))[0])
    assert detect_mibig_schema(v3) == "v3"
    assert detect_mibig_schema(_load_fixture("mibig_test_entry_active_single_class.json")) == "v4"


def test_parses_real_v3_entries():
    """Against real entries copied from mibig-secmet/mibig-json, not
    hand-written approximations of the format."""
    for path in sorted(V3_FIXTURES.glob("*.json")):
        parsed = parse_mibig_entry(json.loads(path.read_text()))
        assert parsed.mibig_accession.startswith("BGC")
        assert parsed.locus_accession
        assert parsed.bgc_class is not None
        # 3.x stores ncbi_tax_id as a string; it must arrive as an int.
        assert parsed.ncbi_taxid is None or isinstance(parsed.ncbi_taxid, int)


def test_v3_multi_class_becomes_hybrid():
    multi = [p for p in V3_FIXTURES.glob("multi_*.json")]
    if not multi:
        pytest.skip("no multi-class fixture available")
    parsed = parse_mibig_entry(json.loads(multi[0].read_text()))
    assert parsed.bgc_class is BGCClass.HYBRID
    assert parsed.subtype and "+" in parsed.subtype


def test_v3_half_present_coordinates_are_dropped_together():
    """1,408 real entries carry start_coord but only 1,407 carry end_coord.
    A start without an end implies a span that isn't known, so both go."""
    from bgcscape.ingest.mibig import parse_mibig_entry_v3

    base = json.loads(sorted(V3_FIXTURES.glob("*.json"))[0].read_text())
    base["cluster"]["loci"]["start_coord"] = 100
    base["cluster"]["loci"].pop("end_coord", None)
    parsed = parse_mibig_entry_v3(base)
    assert parsed.start_coord is None
    assert parsed.end_coord is None


def test_v3_non_numeric_taxid_does_not_crash():
    from bgcscape.ingest.mibig import parse_mibig_entry_v3

    base = json.loads(sorted(V3_FIXTURES.glob("*.json"))[0].read_text())
    base["cluster"]["ncbi_tax_id"] = "not a number"
    assert parse_mibig_entry_v3(base).ncbi_taxid is None


def test_reader_accepts_a_directory_of_v3_entries():
    entries = list(read_mibig_entries_from_path(V3_FIXTURES))
    assert len(entries) == len(list(V3_FIXTURES.glob("*.json")))
    assert all("cluster" in e for e in entries)


def test_loaded_bgc_carries_the_accession_as_external_ref(session, mibig_source):
    """MIBiG ships one GenBank per entry named "<accession>.gbk", and
    BiG-SCAPE keys its output on that filename stem — so external_ref must
    be the accession for a BiG-SCAPE run over MIBiG to join, rather than
    being reported as skipped."""
    parsed = parse_mibig_entry(_load_fixture("mibig_test_entry_active_single_class.json"))
    bgc, _ = load_mibig_entry(session, parsed, mibig_source)
    session.commit()

    assert bgc.external_ref == parsed.mibig_accession
