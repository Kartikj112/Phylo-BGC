from __future__ import annotations

from bgcscape.models import (
    BGC,
    AssemblyLevel,
    BGCClass,
    BGCCompoundLink,
    Compound,
    EvidenceLevel,
    Genome,
)


def test_curated_link_from_mibig_reference(session, mibig_source):
    """A MIBiG-style reference BGC with an experimentally-verified product:
    both the BGC and the link should be OBSERVED_CURATED.
    """
    reference_genome = Genome(
        accession="GCF_TEST_MIBIG_HOST.1",
        assembly_level=AssemblyLevel.COMPLETE_GENOME,
        is_mag=False,
        source_id=mibig_source.id,
        evidence_level=EvidenceLevel.OBSERVED_CURATED,
    )
    session.add(reference_genome)
    session.flush()

    bgc = BGC(
        genome=reference_genome,
        bgc_class=BGCClass.NRPS,
        mibig_accession="BGC-TEST0000001",
        source_id=mibig_source.id,
        evidence_level=EvidenceLevel.OBSERVED_CURATED,
    )
    compound = Compound(
        name="Test Compound Alpha",
        chemical_formula="C10H15N3O2S",  # synthetic placeholder, not a real structure
        compound_class="siderophore",
        mibig_compound_ref="BGC-TEST0000001.compound-1",
        source_id=mibig_source.id,
        evidence_level=EvidenceLevel.OBSERVED_CURATED,
    )
    session.add_all([bgc, compound])
    session.flush()

    link = BGCCompoundLink(
        bgc=bgc,
        compound=compound,
        reference="Test et al. (synthetic fixture citation)",
        source_id=mibig_source.id,
        evidence_level=EvidenceLevel.OBSERVED_CURATED,
    )
    session.add(link)
    session.commit()

    assert bgc.compound_links[0].compound.name == "Test Compound Alpha"
    assert bgc.compound_links[0].evidence_level is EvidenceLevel.OBSERVED_CURATED


def test_predicted_link_carries_lower_confidence_than_curated(session, antismash_tool_source, mibig_source):
    """A newly-predicted BGC on a MAG can still be *guessed* to make a known
    compound (e.g. via domain architecture similarity) without that guess
    being promoted to the same confidence as a MIBiG-verified link.
    """
    mag = Genome(
        accession="GCF_TEST_MAG_HOST.1",
        assembly_level=AssemblyLevel.MAG,
        is_mag=True,
        source_id=antismash_tool_source.id,
        evidence_level=EvidenceLevel.PREDICTED,
    )
    session.add(mag)
    session.flush()

    bgc = BGC(
        genome=mag,
        bgc_class=BGCClass.PKS,
        predicted_by_tool="antiSMASH 7.1.0",
        source_id=antismash_tool_source.id,
        evidence_level=EvidenceLevel.PREDICTED,
    )
    # Add immediately rather than deferring: constructing the next object
    # below reads mibig_source.id, which — since that fixture already
    # committed once and expired its attributes — triggers an autoflush to
    # refresh it. SQLAlchemy 2.0 no longer auto-cascades a brand-new object
    # into the session just because it's linked via a relationship
    # attribute, so an un-added `bgc` sitting on `mag.bgcs` at that moment
    # would otherwise surface a harmless but noisy SAWarning.
    session.add(bgc)

    known_compound = Compound(
        name="Test Compound Beta",
        compound_class="polyketide",
        source_id=mibig_source.id,
        evidence_level=EvidenceLevel.OBSERVED_CURATED,
    )
    session.add(known_compound)
    session.flush()

    guess = BGCCompoundLink(
        bgc=bgc,
        compound=known_compound,
        reference="domain-architecture similarity heuristic (synthetic fixture)",
        source_id=antismash_tool_source.id,
        evidence_level=EvidenceLevel.PREDICTED,
    )
    session.add(guess)
    session.commit()

    # The compound itself is curated; the *link* asserting this new BGC
    # makes it is only predicted. These are independent evidence levels.
    assert known_compound.evidence_level is EvidenceLevel.OBSERVED_CURATED
    assert guess.evidence_level is EvidenceLevel.PREDICTED
