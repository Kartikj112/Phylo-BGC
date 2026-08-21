from __future__ import annotations

import pytest
from sqlalchemy.exc import IntegrityError

from bgcscape.models import AssemblyLevel, EvidenceLevel, Genome, Taxon, TaxonRank


def test_taxon_hierarchy_parent_child(session, gtdb_source):
    domain = Taxon(
        name="Bacteria",
        rank=TaxonRank.DOMAIN,
        source_id=gtdb_source.id,
        evidence_level=EvidenceLevel.OBSERVED_CURATED,
    )
    phylum = Taxon(
        name="Actinomycetota",
        rank=TaxonRank.PHYLUM,
        parent=domain,
        source_id=gtdb_source.id,
        evidence_level=EvidenceLevel.OBSERVED_CURATED,
    )
    session.add_all([domain, phylum])
    session.commit()

    assert phylum.parent_id == domain.id
    assert phylum in domain.children
    assert phylum.parent.name == "Bacteria"


def test_genome_links_to_taxon(session, gtdb_source):
    species = Taxon(
        name="Streptomyces coelicolor",
        rank=TaxonRank.SPECIES,
        source_id=gtdb_source.id,
        evidence_level=EvidenceLevel.OBSERVED_CURATED,
    )
    session.add(species)
    session.flush()

    genome = Genome(
        accession="GCF_TEST0000001.1",
        taxon=species,
        assembly_level=AssemblyLevel.COMPLETE_GENOME,
        is_mag=False,
        source_id=gtdb_source.id,
        evidence_level=EvidenceLevel.OBSERVED_CURATED,
    )
    session.add(genome)
    session.commit()

    assert genome.taxon.name == "Streptomyces coelicolor"
    assert species.genomes == [genome]


def test_genome_taxon_is_optional(session, gtdb_source):
    """A genome may exist before taxonomic classification completes."""
    genome = Genome(
        accession="GCF_TEST0000002.1",
        taxon_id=None,
        assembly_level=AssemblyLevel.MAG,
        is_mag=True,
        source_id=gtdb_source.id,
        evidence_level=EvidenceLevel.PREDICTED,
    )
    session.add(genome)
    session.commit()

    assert genome.taxon is None


def test_genome_accession_must_be_unique(session, gtdb_source):
    kwargs = dict(
        accession="GCF_TEST_DUPLICATE.1",
        assembly_level=AssemblyLevel.MAG,
        is_mag=True,
        source_id=gtdb_source.id,
        evidence_level=EvidenceLevel.PREDICTED,
    )
    session.add(Genome(**kwargs))
    session.commit()

    session.add(Genome(**kwargs))
    with pytest.raises(IntegrityError):
        session.commit()


def test_genome_sample_metadata_round_trips_json(session, gtdb_source):
    genome = Genome(
        accession="GCF_TEST0000003.1",
        assembly_level=AssemblyLevel.MAG,
        is_mag=True,
        source_id=gtdb_source.id,
        evidence_level=EvidenceLevel.PREDICTED,
        sample_metadata={"habitat": "marine sediment", "depth_m": 1200, "replicate": 2},
    )
    session.add(genome)
    session.commit()
    session.expire_all()

    reloaded = session.get(Genome, genome.id)
    assert reloaded.sample_metadata == {"habitat": "marine sediment", "depth_m": 1200, "replicate": 2}
