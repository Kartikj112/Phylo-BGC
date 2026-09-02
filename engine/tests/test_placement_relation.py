"""The MIBiG->GTDB placement, as a queryable relation.

`test_weak_name_matches_are_a_query` is the one that states the purpose:
"which entries rest on weak name matching?" used to require decoding every
cluster's raw_annotation JSON in Python. On the shipped corpus the answer is
220 clusters, and it is now a WHERE clause.
"""
from __future__ import annotations

from bgcscape.ingest.link import PLACEMENT_CAVEATS, link_mibig_to_gtdb, placement_of
from bgcscape.models import (
    BGC,
    AssemblyLevel,
    BGCClass,
    BGCOrganismPlacement,
    EvidenceLevel,
    Genome,
    PlacementConfidence,
    PlacementMethod,
    Taxon,
    TaxonRank,
)


def _corpus(session, gtdb_source, mibig_source):
    """A MIBiG cluster on its locus stub, plus the GTDB genome for the same
    organism — the shape `link-mibig` exists to join."""
    species = Taxon(
        name="Streptomyces coelicolor",
        rank=TaxonRank.SPECIES,
        source_id=gtdb_source.id,
        evidence_level=EvidenceLevel.OBSERVED_CURATED,
    )
    session.add(species)
    session.flush()

    gtdb_genome = Genome(
        accession="GCF_000203835.1",
        taxon_id=species.id,
        assembly_level=AssemblyLevel.COMPLETE_GENOME,
        is_mag=False,
        source_id=gtdb_source.id,
        evidence_level=EvidenceLevel.OBSERVED_CURATED,
    )
    locus_stub = Genome(
        accession="AL645882",
        assembly_level=AssemblyLevel.LOCUS,
        is_mag=False,
        source_id=mibig_source.id,
        evidence_level=EvidenceLevel.OBSERVED_CURATED,
    )
    session.add_all([gtdb_genome, locus_stub])
    session.flush()

    bgc = BGC(
        genome_id=locus_stub.id,
        contig="AL645882",
        bgc_class=BGCClass.PKS,
        mibig_accession="BGC0000001",
        source_id=mibig_source.id,
        evidence_level=EvidenceLevel.OBSERVED_CURATED,
    )
    session.add(bgc)
    session.commit()
    return bgc, gtdb_genome


def test_placement_is_a_row_with_method_and_confidence(session, gtdb_source, mibig_source):
    bgc, gtdb_genome = _corpus(session, gtdb_source, mibig_source)
    link_mibig_to_gtdb(session, [("BGC0000001", "GCF_000203835.1", "ncbi_taxid")])

    placement = session.query(BGCOrganismPlacement).one()
    assert placement.bgc_id == bgc.id
    assert placement.representative_genome_id == gtdb_genome.id
    assert placement.method is PlacementMethod.NCBI_TAXID
    assert placement.confidence is PlacementConfidence.STRONG
    assert placement.gtdb_accession == "GCF_000203835.1"


def test_the_caveat_says_it_was_not_sequenced_from_this_assembly(
    session, gtdb_source, mibig_source
):
    """The claim the schema exists to keep straight, carried on the row so
    it travels with an export rather than living only in a docstring."""
    _corpus(session, gtdb_source, mibig_source)
    link_mibig_to_gtdb(session, [("BGC0000001", "GCF_000203835.1", "ncbi_taxid")])

    placement = session.query(BGCOrganismPlacement).one()
    assert "NOT sequenced from this assembly" in placement.caveat
    # And every placed method says so, not just this one.
    for method, caveat in PLACEMENT_CAVEATS.items():
        if method is PlacementMethod.UNPLACED:
            continue
        assert "NOT sequenced from this assembly" in caveat or "not the source of this cluster" in caveat


def test_weak_name_matches_are_a_query(session, gtdb_source, mibig_source):
    """The question from the brief, answered in SQL."""
    _corpus(session, gtdb_source, mibig_source)
    link_mibig_to_gtdb(session, [("BGC0000001", "GCF_000203835.1", "ncbi_species_name")])

    weak = (
        session.query(BGCOrganismPlacement)
        .filter(BGCOrganismPlacement.confidence == PlacementConfidence.WEAK)
        .all()
    )
    assert len(weak) == 1
    assert weak[0].method is PlacementMethod.NCBI_SPECIES_NAME
    assert "weakest join" in weak[0].caveat


def test_placement_is_computed_not_curated(session, gtdb_source, mibig_source):
    """MIBiG curated the cluster; the join to a GTDB genome is ours.

    Letting the placement inherit the cluster's OBSERVED_CURATED level would
    launder an inference into an observation — the exact thing the evidence
    model exists to prevent.
    """
    bgc, _ = _corpus(session, gtdb_source, mibig_source)
    link_mibig_to_gtdb(session, [("BGC0000001", "GCF_000203835.1", "ncbi_taxid")])

    placement = session.query(BGCOrganismPlacement).one()
    assert placement.evidence_level is EvidenceLevel.COMPUTED
    assert bgc.evidence_level is EvidenceLevel.OBSERVED_CURATED, "the cluster is untouched"


def test_relinking_updates_the_placement_rather_than_adding_a_second(
    session, gtdb_source, mibig_source
):
    _corpus(session, gtdb_source, mibig_source)
    link_mibig_to_gtdb(session, [("BGC0000001", "GCF_000203835.1", "ncbi_species_name")])
    link_mibig_to_gtdb(session, [("BGC0000001", "GCF_000203835.1", "ncbi_taxid")])

    placement = session.query(BGCOrganismPlacement).one()
    assert placement.method is PlacementMethod.NCBI_TAXID
    assert placement.confidence is PlacementConfidence.STRONG


def test_an_undefined_match_method_is_reported_not_coerced(
    session, gtdb_source, mibig_source
):
    """The mapping TSV's match_method is free text produced by a script that
    can be edited. Inventing a confidence for a value nobody defined would
    put a number on the tree that no method backs."""
    bgc, gtdb_genome = _corpus(session, gtdb_source, mibig_source)
    report = link_mibig_to_gtdb(
        session, [("BGC0000001", "GCF_000203835.1", "vibes_based_matching")]
    )

    assert session.query(BGCOrganismPlacement).count() == 0
    assert report.unknown_methods == {"vibes_based_matching"}
    # The cluster is still linked — only the confidence claim is withheld.
    assert report.linked == 1
    session.refresh(bgc)
    assert bgc.genome_id == gtdb_genome.id


def test_placement_of_reads_the_table_and_falls_back_to_the_json(
    session, gtdb_source, mibig_source
):
    """A database migrated but not yet re-linked still answers, at the
    fidelity the JSON supports — which is method only, no confidence."""
    bgc, _ = _corpus(session, gtdb_source, mibig_source)
    link_mibig_to_gtdb(session, [("BGC0000001", "GCF_000203835.1", "gtdb_species")])

    from_table = placement_of(bgc)
    assert from_table["method"] == "gtdb_species"
    assert from_table["confidence"] == "moderate"

    # Drop the row, leaving only the legacy JSON key link.py still writes.
    session.query(BGCOrganismPlacement).delete()
    session.commit()
    session.expire_all()

    legacy = placement_of(session.get(BGC, bgc.id))
    assert legacy["method"] == "gtdb_species"
    assert "confidence" not in legacy, "the JSON never carried one; None is not 'strong'"


def test_report_counts_weak_placements(session, gtdb_source, mibig_source):
    """The number a reader needs: the fraction of the corpus whose position
    on the tree is nomenclature rather than an identifier."""
    _corpus(session, gtdb_source, mibig_source)
    report = link_mibig_to_gtdb(
        session, [("BGC0000001", "GCF_000203835.1", "ncbi_species_name")]
    )
    assert report.placements_recorded == 1
    assert report.weak_placements == 1
