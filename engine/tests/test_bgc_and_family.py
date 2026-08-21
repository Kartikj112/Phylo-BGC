from __future__ import annotations

import pytest
from sqlalchemy.exc import IntegrityError

from bgcscape.models import (
    BGC,
    AssemblyLevel,
    BGCClass,
    BGCFamily,
    BGCFamilyMembership,
    EvidenceLevel,
    Genome,
)


@pytest.fixture()
def genome(session, gtdb_source) -> Genome:
    g = Genome(
        accession="GCF_TEST_BGC_HOST.1",
        assembly_level=AssemblyLevel.MAG,
        is_mag=True,
        source_id=gtdb_source.id,
        evidence_level=EvidenceLevel.PREDICTED,
    )
    session.add(g)
    session.flush()
    return g


def test_bgc_predicted_by_antismash(session, genome, antismash_tool_source):
    bgc = BGC(
        genome=genome,
        contig="contig_00003",
        start_coord=104_200,
        end_coord=128_650,
        strand="+",
        bgc_class=BGCClass.NRPS,
        subtype="NRPS-independent siderophore",
        predicted_by_tool="antiSMASH 7.1.0",
        raw_annotation={"detection_rules": ["NRPS"], "region_number": 3},
        source_id=antismash_tool_source.id,
        evidence_level=EvidenceLevel.PREDICTED,
    )
    session.add(bgc)
    session.commit()

    assert bgc.genome.accession == "GCF_TEST_BGC_HOST.1"
    assert bgc.evidence_level is EvidenceLevel.PREDICTED
    assert bgc.raw_annotation["region_number"] == 3


def test_bgc_family_membership_and_uniqueness(session, genome, antismash_tool_source, bigscape_tool_source):
    bgc_1 = BGC(
        genome=genome,
        bgc_class=BGCClass.RIPP,
        source_id=antismash_tool_source.id,
        evidence_level=EvidenceLevel.PREDICTED,
    )
    bgc_2 = BGC(
        genome=genome,
        bgc_class=BGCClass.RIPP,
        source_id=antismash_tool_source.id,
        evidence_level=EvidenceLevel.PREDICTED,
    )
    session.add_all([bgc_1, bgc_2])
    session.flush()

    family = BGCFamily(
        label="GCF_TEST_0001",
        clustering_method="BiG-SCAPE 2.0",
        clustering_cutoff=0.3,
        source_id=bigscape_tool_source.id,
        evidence_level=EvidenceLevel.COMPUTED,
    )
    session.add(family)
    session.flush()

    m1 = BGCFamilyMembership(bgc=bgc_1, family=family, similarity_score=0.0)
    m2 = BGCFamilyMembership(bgc=bgc_2, family=family, similarity_score=0.18)
    session.add_all([m1, m2])
    session.commit()

    assert {m.bgc_id for m in family.memberships} == {bgc_1.id, bgc_2.id}

    # Same BGC can't be double-assigned to the same family.
    session.add(BGCFamilyMembership(bgc=bgc_1, family=family, similarity_score=0.0))
    with pytest.raises(IntegrityError):
        session.commit()


def test_deleting_bgc_cascades_family_memberships(session, genome, antismash_tool_source, bigscape_tool_source):
    bgc = BGC(
        genome=genome,
        bgc_class=BGCClass.TERPENE,
        source_id=antismash_tool_source.id,
        evidence_level=EvidenceLevel.PREDICTED,
    )
    session.add(bgc)
    session.flush()

    family = BGCFamily(
        label="GCF_TEST_0002",
        source_id=bigscape_tool_source.id,
        evidence_level=EvidenceLevel.COMPUTED,
    )
    session.add(family)
    session.flush()
    session.add(BGCFamilyMembership(bgc=bgc, family=family))
    session.commit()

    session.delete(bgc)
    session.commit()

    remaining = session.query(BGCFamilyMembership).filter_by(family_id=family.id).all()
    assert remaining == []
