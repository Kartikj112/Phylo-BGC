from __future__ import annotations

import pytest
from pydantic import ValidationError

from bgcscape.models import AssemblyLevel, EvidenceLevel, Genome, Taxon, TaxonRank
from bgcscape.schemas import GenomeRead, TaxonRead


def test_taxon_read_round_trips_from_orm_instance(session, gtdb_source):
    taxon = Taxon(
        name="Streptomycetaceae",
        rank=TaxonRank.FAMILY,
        source_id=gtdb_source.id,
        evidence_level=EvidenceLevel.OBSERVED_CURATED,
        gtdb_taxonomy_string="d__Bacteria;p__Actinomycetota;...;f__Streptomycetaceae",
    )
    session.add(taxon)
    session.commit()

    schema = TaxonRead.model_validate(taxon)

    assert schema.name == "Streptomycetaceae"
    assert schema.rank is TaxonRank.FAMILY
    assert schema.evidence_level is EvidenceLevel.OBSERVED_CURATED
    assert schema.id == taxon.id


def test_genome_read_round_trips_and_serializes_to_json(session, gtdb_source):
    genome = Genome(
        accession="GCF_TEST_SCHEMA.1",
        assembly_level=AssemblyLevel.MAG,
        is_mag=True,
        source_id=gtdb_source.id,
        evidence_level=EvidenceLevel.PREDICTED,
        sample_metadata={"habitat": "soil"},
    )
    session.add(genome)
    session.commit()

    schema = GenomeRead.model_validate(genome)
    payload = schema.model_dump_json()

    assert '"accession":"GCF_TEST_SCHEMA.1"' in payload
    assert '"is_mag":true' in payload


def test_taxon_read_rejects_invalid_rank():
    with pytest.raises(ValidationError):
        TaxonRead(
            id="00000000-0000-0000-0000-000000000000",
            name="Nonsense",
            rank="not_a_real_rank",
            source_id="00000000-0000-0000-0000-000000000000",
            evidence_level="observed_curated",
        )


def test_taxon_read_rejects_missing_required_field():
    with pytest.raises(ValidationError):
        # Missing `rank`, `source_id`, `evidence_level` entirely.
        TaxonRead(id="00000000-0000-0000-0000-000000000000", name="Incomplete")
