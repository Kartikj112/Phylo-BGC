from __future__ import annotations

import pytest
from sqlalchemy.exc import IntegrityError, StatementError

from bgcscape.models import AssemblyLevel, EvidenceLevel, Genome, TaxonRank


def test_genome_without_source_id_is_rejected(session):
    """ProvenanceMixin.source_id is nullable=False: omitting it must fail,
    not silently succeed with a NULL provenance pointer.
    """
    genome = Genome(
        accession="GCF_TEST_NO_SOURCE.1",
        assembly_level=AssemblyLevel.MAG,
        is_mag=True,
        evidence_level=EvidenceLevel.PREDICTED,
        # source_id intentionally omitted
    )
    session.add(genome)
    with pytest.raises(IntegrityError):
        session.commit()


def test_genome_without_evidence_level_is_rejected(session, gtdb_source):
    genome = Genome(
        accession="GCF_TEST_NO_EVIDENCE.1",
        assembly_level=AssemblyLevel.MAG,
        is_mag=True,
        source_id=gtdb_source.id,
        # evidence_level intentionally omitted
    )
    session.add(genome)
    with pytest.raises(IntegrityError):
        session.commit()


def test_invalid_evidence_level_value_is_rejected(session, gtdb_source):
    """native_enum=False stores EvidenceLevel as VARCHAR + CHECK, and
    validate_strings=True asks SQLAlchemy to reject junk values — but that
    validation runs when the value is bound to a statement (flush/commit
    time), not at plain Python attribute-assignment time, since SQLAlchemy
    doesn't intercept ordinary `__init__`/`setattr` with type checking.
    """
    genome = Genome(
        accession="GCF_TEST_BAD_EVIDENCE.1",
        assembly_level=AssemblyLevel.MAG,
        is_mag=True,
        source_id=gtdb_source.id,
        evidence_level="definitely_not_a_real_evidence_level",
    )
    session.add(genome)
    with pytest.raises((LookupError, ValueError, StatementError)):
        session.commit()


def test_invalid_taxon_rank_value_is_rejected():
    with pytest.raises(ValueError):
        TaxonRank("not_a_real_rank")
