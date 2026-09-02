"""`is_mag` is tri-state, because no ingest path can establish it.

Every loader in this project used to write `is_mag=False` without a source
that says so — GTDB's own loader admitted it in a comment — and the
interface rendered that as "Isolate genome assembly" for all 1,542 genomes
in the shipped corpus. These pin the fix: unknown stays unknown, and the
one signal that IS real (`assembly_level`) still gets through.
"""
from __future__ import annotations

import pytest

from bgcscape.ingest.antismash import ingest_antismash_result
from bgcscape.ingest.gtdb import ingest_gtdb_metadata, read_gtdb_metadata_tsv
from bgcscape.models import AssemblyLevel, EvidenceLevel, Genome

FIXTURE = "tests/fixtures/gtdb_metadata_test.tsv"


def test_gtdb_ingest_leaves_mag_status_unknown(session, gtdb_source):
    """GTDB's metadata has no verified MAG-detection column, so its loader
    has never had grounds for either answer. It now says so."""
    rows = read_gtdb_metadata_tsv(FIXTURE)
    ingest_gtdb_metadata(session, gtdb_source, rows)

    genomes = session.query(Genome).all()
    assert genomes, "fixture should produce genomes"
    assert all(g.is_mag is None for g in genomes), (
        "False here would be a claim about each genome's provenance made on no evidence"
    )
    # The thing GTDB DOES record is still recorded.
    assert all(g.assembly_level is not None for g in genomes)


def test_antismash_stub_leaves_mag_status_unknown(session, antismash_tool_source):
    """antiSMASH's JSON carries no assembly metadata at all, so `is_mag`
    gets the same treatment `assembly_level` already had."""
    result = {
        "version": "7.1.0",
        "taxon": "bacteria",
        "records": [{"id": "CONTIG_1", "description": "", "areas": []}],
    }
    ingest_antismash_result(
        session, antismash_tool_source, result, genome_accession="GCF_STUB.1"
    )

    genome = session.query(Genome).filter_by(accession="GCF_STUB.1").one()
    assert genome.assembly_level is AssemblyLevel.UNKNOWN
    assert genome.is_mag is None, "the gap AssemblyLevel.UNKNOWN already named"


def test_an_asserted_mag_is_still_recorded(session, gtdb_source):
    """None is "not established", not "no answer allowed". An operator who
    passes --is-mag is asserting something, and that survives."""
    genome = Genome(
        accession="MAG_001",
        assembly_level=AssemblyLevel.MAG,
        is_mag=True,
        source_id=gtdb_source.id,
        evidence_level=EvidenceLevel.PREDICTED,
    )
    session.add(genome)
    session.commit()
    assert session.query(Genome).filter_by(accession="MAG_001").one().is_mag is True


def test_unknown_is_distinguishable_from_false(session, gtdb_source):
    """The distinction the column could not previously hold."""
    unknown = Genome(
        accession="GCF_UNKNOWN.1",
        assembly_level=AssemblyLevel.CONTIG,
        source_id=gtdb_source.id,
        evidence_level=EvidenceLevel.OBSERVED_CURATED,
    )
    established = Genome(
        accession="GCF_ISOLATE.1",
        assembly_level=AssemblyLevel.COMPLETE_GENOME,
        is_mag=False,
        source_id=gtdb_source.id,
        evidence_level=EvidenceLevel.OBSERVED_CURATED,
    )
    session.add_all([unknown, established])
    session.commit()

    assert unknown.is_mag is None
    assert established.is_mag is False
    assert unknown.is_mag is not established.is_mag


def test_contamination_reaches_the_tree_payload(session, gtdb_source):
    """`contamination_pct` is ingested for 991 of 1,542 genomes and had no
    way out of the database. Completeness without it is half a QC picture:
    a 95%-complete bin at 12% contamination is not a good genome."""
    from bgcscape.api.tree_builder import build_taxonomy_tree
    from bgcscape.models import Taxon, TaxonRank

    taxon = Taxon(
        name="Streptomyces",
        rank=TaxonRank.GENUS,
        source_id=gtdb_source.id,
        evidence_level=EvidenceLevel.OBSERVED_CURATED,
    )
    session.add(taxon)
    session.flush()
    session.add(
        Genome(
            accession="GCF_QC.1",
            taxon_id=taxon.id,
            assembly_level=AssemblyLevel.CONTIG,
            completeness_pct=95.0,
            contamination_pct=12.0,
            source_id=gtdb_source.id,
            evidence_level=EvidenceLevel.OBSERVED_CURATED,
        )
    )
    session.commit()

    root = build_taxonomy_tree(session)
    genome = root.children[0].direct_genomes[0]
    assert genome.completeness_pct == pytest.approx(95.0)
    assert genome.contamination_pct == pytest.approx(12.0)
    assert genome.is_mag is None
