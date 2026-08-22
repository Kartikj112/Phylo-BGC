from __future__ import annotations

from pathlib import Path

import pytest

from bgcscape.ingest.gtdb import (
    GtdbParseError,
    ingest_gtdb_metadata,
    load_gtdb_genome,
    normalize_gtdb_accession,
    parse_gtdb_metadata_row,
    parse_gtdb_taxonomy_string,
    read_gtdb_metadata_tsv,
)
from bgcscape.models import Genome, Taxon, TaxonRank
from bgcscape.models.base import EvidenceLevel
from bgcscape.models.genome import AssemblyLevel

FIXTURES = Path(__file__).parent / "fixtures"
METADATA_TSV = FIXTURES / "gtdb_metadata_test.tsv"


# --- parser tests (pure, no DB) -------------------------------------------------


def test_normalize_gtdb_accession_strips_known_prefixes():
    assert normalize_gtdb_accession("RS_GCF_000203835.1") == "GCF_000203835.1"
    assert normalize_gtdb_accession("GB_GCA_000203835.1") == "GCA_000203835.1"
    assert normalize_gtdb_accession("GCF_000203835.1") == "GCF_000203835.1"


def test_parse_gtdb_taxonomy_string_full_chain():
    chain = parse_gtdb_taxonomy_string(
        "d__Bacteria;p__Actinomycetota;c__Actinomycetes;o__Streptomycetales;"
        "f__Streptomycetaceae;g__Streptomyces;s__Streptomyces testomycini"
    )
    assert chain == [
        (TaxonRank.DOMAIN, "Bacteria"),
        (TaxonRank.PHYLUM, "Actinomycetota"),
        (TaxonRank.CLASS, "Actinomycetes"),
        (TaxonRank.ORDER, "Streptomycetales"),
        (TaxonRank.FAMILY, "Streptomycetaceae"),
        (TaxonRank.GENUS, "Streptomyces"),
        (TaxonRank.SPECIES, "Streptomyces testomycini"),
    ]


def test_parse_gtdb_taxonomy_string_skips_empty_species():
    chain = parse_gtdb_taxonomy_string(
        "d__Bacteria;p__Actinomycetota;c__Actinomycetes;o__Streptomycetales;f__Streptomycetaceae;g__Streptomyces;s__"
    )
    assert chain[-1] == (TaxonRank.GENUS, "Streptomyces")
    assert all(rank != TaxonRank.SPECIES for rank, _ in chain)


def test_parse_metadata_row_maps_known_columns():
    rows = list(read_gtdb_metadata_tsv(METADATA_TSV))
    parsed = parse_gtdb_metadata_row(rows[0])

    assert parsed.accession == "GCF_TEST900001.1"  # RS_ prefix stripped
    assert parsed.completeness_pct == pytest.approx(99.87)
    assert parsed.contamination_pct == pytest.approx(0.12)
    assert parsed.genome_size_bp == 8452341
    assert parsed.gc_content_pct == pytest.approx(71.4)
    assert parsed.assembly_level is AssemblyLevel.COMPLETE_GENOME
    assert parsed.taxonomy_chain[-1] == (TaxonRank.SPECIES, "Streptomyces testomycini")


def test_parse_metadata_row_missing_accession_raises():
    with pytest.raises(GtdbParseError, match="accession"):
        parse_gtdb_metadata_row({"gtdb_taxonomy": "d__Bacteria;p__Foo"})


def test_parse_metadata_row_missing_taxonomy_raises():
    with pytest.raises(GtdbParseError, match="gtdb_taxonomy"):
        parse_gtdb_metadata_row({"accession": "RS_GCF_000000000.1"})


# --- loader tests (DB) -----------------------------------------------------------


def test_load_gtdb_genome_creates_full_taxonomy_chain(session, gtdb_source):
    rows = list(read_gtdb_metadata_tsv(METADATA_TSV))
    parsed = parse_gtdb_metadata_row(rows[0])

    genome, created = load_gtdb_genome(session, parsed, gtdb_source)
    session.commit()

    assert created is True
    assert genome.accession == "GCF_TEST900001.1"
    assert genome.assembly_level is AssemblyLevel.COMPLETE_GENOME
    assert genome.evidence_level is EvidenceLevel.OBSERVED_CURATED

    species_taxon = session.get(Taxon, genome.taxon_id)
    assert species_taxon.rank is TaxonRank.SPECIES
    assert species_taxon.name == "Streptomyces testomycini"
    assert species_taxon.gtdb_taxonomy_string == parsed.taxonomy_string

    # Walk the chain back up to confirm parents were wired correctly.
    genus = species_taxon.parent
    assert genus.rank is TaxonRank.GENUS
    assert genus.name == "Streptomyces"
    domain = genus.parent.parent.parent.parent.parent
    assert domain.rank is TaxonRank.DOMAIN
    assert domain.name == "Bacteria"
    assert session.query(Taxon).count() == 7  # one per rank, all newly created


def test_load_gtdb_genome_shares_ancestor_taxa_across_genomes(session, gtdb_source):
    rows = list(read_gtdb_metadata_tsv(METADATA_TSV))
    parsed_1 = parse_gtdb_metadata_row(rows[0])  # s__Streptomyces testomycini
    parsed_2 = parse_gtdb_metadata_row(rows[1])  # s__Streptomyces fixturensis

    load_gtdb_genome(session, parsed_1, gtdb_source)
    session.commit()
    load_gtdb_genome(session, parsed_2, gtdb_source)
    session.commit()

    # 2 distinct species, but domain/phylum/class/order/family/genus (6
    # ranks) are shared -> 6 + 2 = 8 Taxon rows, not 14.
    assert session.query(Taxon).count() == 8
    assert session.query(Genome).count() == 2


def test_load_gtdb_genome_with_unclassified_species_leaves_genus_as_taxon(session, gtdb_source):
    rows = list(read_gtdb_metadata_tsv(METADATA_TSV))
    parsed = parse_gtdb_metadata_row(rows[2])  # s__ empty in the fixture

    genome, _ = load_gtdb_genome(session, parsed, gtdb_source)
    session.commit()

    leaf_taxon = session.get(Taxon, genome.taxon_id)
    assert leaf_taxon.rank is TaxonRank.GENUS
    assert leaf_taxon.name == "Streptomyces"
    assert genome.assembly_level is AssemblyLevel.SCAFFOLD


def test_load_gtdb_genome_is_idempotent(session, gtdb_source):
    rows = list(read_gtdb_metadata_tsv(METADATA_TSV))
    parsed = parse_gtdb_metadata_row(rows[0])

    genome_1, created_1 = load_gtdb_genome(session, parsed, gtdb_source)
    session.commit()
    genome_2, created_2 = load_gtdb_genome(session, parsed, gtdb_source)
    session.commit()

    assert created_1 is True
    assert created_2 is False
    assert genome_1.id == genome_2.id
    assert session.query(Genome).count() == 1


# --- orchestration tests -----------------------------------------------------------


def test_ingest_full_metadata_tsv_end_to_end(session, gtdb_source):
    rows = read_gtdb_metadata_tsv(METADATA_TSV)
    report = ingest_gtdb_metadata(session, gtdb_source, rows)

    assert report.created == 3
    assert report.errors == []
    assert session.query(Genome).count() == 3
    # All 3 rows share the same domain..genus (6 ranks, incl. Streptomyces
    # itself). Rows 1 & 2 each add one distinct species leaf; row 3 has no
    # species rank at all (unclassified) so it contributes zero new taxa —
    # its leaf *is* the shared genus. Total: 6 + 2 = 8, not 9.
    assert session.query(Taxon).count() == 8


def test_ingest_gtdb_metadata_records_errors_without_aborting_batch(session, gtdb_source):
    rows = list(read_gtdb_metadata_tsv(METADATA_TSV))
    del rows[1]["gtdb_taxonomy"]  # corrupt the second row

    report = ingest_gtdb_metadata(session, gtdb_source, rows)

    assert report.created == 2
    assert len(report.errors) == 1
    assert session.query(Genome).count() == 2
