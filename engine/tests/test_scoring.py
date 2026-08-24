"""Tests for BGC prioritization scoring.

The central test in this file is
`test_absent_mibig_does_not_inflate_scores` — the failure mode that would
make this feature actively harmful is scoring "no MIBiG match" as maximal
distance when MIBiG simply hasn't been ingested. Everything else is
supporting.
"""
from __future__ import annotations

import pytest
from sqlalchemy.orm import Session

from bgcscape.models import (
    BGC,
    AssemblyLevel,
    BGCClass,
    BGCFamily,
    BGCFamilyMembership,
    EvidenceLevel,
    Genome,
    Source,
    SourceType,
    Taxon,
    TaxonRank,
)
from bgcscape.scoring import (
    DEFAULT_WEIGHTS,
    build_scoring_context,
    rank_bgcs,
    score_bgc,
)


class DatasetBuilder:
    """Small helper so each test can state the corpus shape it needs in a
    few lines — the scoring logic is entirely relative to corpus
    composition, so nearly every test needs a differently-shaped one."""

    def __init__(self, session: Session) -> None:
        self.session = session
        self.tool = Source(name="antiSMASH", source_type=SourceType.TOOL_RUN, version="7.1.0")
        self.curated = Source(name="MIBiG", source_type=SourceType.REFERENCE_DATABASE, version="4.0")
        session.add_all([self.tool, self.curated])
        session.flush()
        self.genus_cache: dict[str, Taxon] = {}
        self.families: dict[str, BGCFamily] = {}

    def genus(self, name: str) -> Taxon:
        if name not in self.genus_cache:
            taxon = Taxon(
                name=name,
                rank=TaxonRank.GENUS,
                source_id=self.tool.id,
                evidence_level=EvidenceLevel.OBSERVED_CURATED,
            )
            self.session.add(taxon)
            self.session.flush()
            self.genus_cache[name] = taxon
        return self.genus_cache[name]

    def species(self, genus_name: str, species_name: str) -> Taxon:
        parent = self.genus(genus_name)
        taxon = Taxon(
            name=species_name,
            rank=TaxonRank.SPECIES,
            parent_id=parent.id,
            source_id=self.tool.id,
            evidence_level=EvidenceLevel.OBSERVED_CURATED,
        )
        self.session.add(taxon)
        self.session.flush()
        return taxon

    def family(self, label: str) -> BGCFamily:
        if label not in self.families:
            fam = BGCFamily(
                label=label,
                clustering_method="BiG-SCAPE 2.0.0",
                clustering_cutoff=0.3,
                source_id=self.tool.id,
                evidence_level=EvidenceLevel.COMPUTED,
            )
            self.session.add(fam)
            self.session.flush()
            self.families[label] = fam
        return self.families[label]

    def add_bgc(
        self,
        *,
        genus_name: str,
        species_name: str,
        accession: str,
        bgc_class: BGCClass = BGCClass.NRPS,
        family_label: str | None = None,
        mibig_accession: str | None = None,
    ) -> BGC:
        taxon = self.species(genus_name, species_name)
        genome = self.session.query(Genome).filter_by(accession=accession).one_or_none()
        if genome is None:
            genome = Genome(
                accession=accession,
                taxon_id=taxon.id,
                assembly_level=AssemblyLevel.COMPLETE_GENOME,
                is_mag=False,
                source_id=self.tool.id,
                evidence_level=EvidenceLevel.OBSERVED_CURATED,
            )
            self.session.add(genome)
            self.session.flush()

        bgc = BGC(
            genome_id=genome.id,
            bgc_class=bgc_class,
            mibig_accession=mibig_accession,
            source_id=self.curated.id if mibig_accession else self.tool.id,
            evidence_level=EvidenceLevel.OBSERVED_CURATED if mibig_accession else EvidenceLevel.PREDICTED,
        )
        self.session.add(bgc)
        self.session.flush()

        if family_label:
            self.session.add(BGCFamilyMembership(bgc_id=bgc.id, family_id=self.family(family_label).id))
            self.session.flush()
        return bgc


@pytest.fixture()
def builder(session) -> DatasetBuilder:
    return DatasetBuilder(session)


def _component(result, name):
    return next(c for c in result.components if c.name == name)


# === THE CENTRAL GUARANTEE ======================================================


def test_absent_mibig_does_not_inflate_scores(builder, session):
    """If MIBiG has never been ingested, 'no close MIBiG relative' is a
    fact about the database, not the cluster. Scoring it as maximal
    distance would rank every cluster in an empty database as maximally
    interesting — which would make this feature worse than useless.
    """
    bgc = builder.add_bgc(
        genus_name="Streptomyces", species_name="S. one", accession="GCF_1.1", family_label="FAM_A"
    )
    session.commit()

    ctx = build_scoring_context(session)
    assert ctx.mibig_present is False

    result = score_bgc(bgc, ctx)
    mibig = _component(result, "mibig_distance")

    assert mibig.value is None, "absent MIBiG must be unavailable, never a maximal score"
    assert mibig.available is False
    assert "mibig_distance" in result.unavailable_components
    assert "empty reference set" in mibig.explanation
    # And the caller is told the ranking rests on less than it appears to.
    assert any("No MIBiG reference data in this corpus" in c for c in result.caveats)


def test_unavailable_components_are_excluded_not_zeroed_or_maxed(builder, session):
    """A component that couldn't be computed must not drag the score down
    (as zero) or push it up (as one) — it must simply not participate."""
    bgc = builder.add_bgc(
        genus_name="Streptomyces", species_name="S. one", accession="GCF_1.1", family_label="FAM_A"
    )
    session.commit()
    ctx = build_scoring_context(session)
    result = score_bgc(bgc, ctx)

    available = [c for c in result.components if c.available]
    manual = sum(c.value * DEFAULT_WEIGHTS[c.name] for c in available) / sum(
        DEFAULT_WEIGHTS[c.name] for c in available
    )
    assert result.score == pytest.approx(manual)


def test_scoring_refuses_when_too_few_components_are_available(builder, session):
    """An unclassified genome with no families and no MIBiG leaves almost
    nothing computable. Returning a confident-looking number from one
    surviving proxy would be the wrong answer."""
    genome = Genome(
        accession="GCF_ORPHAN.1",
        taxon_id=None,  # unclassified
        assembly_level=AssemblyLevel.UNKNOWN,
        is_mag=True,
        source_id=builder.tool.id,
        evidence_level=EvidenceLevel.PREDICTED,
    )
    session.add(genome)
    session.flush()
    bgc = BGC(
        genome_id=genome.id,
        bgc_class=BGCClass.NRPS,
        source_id=builder.tool.id,
        evidence_level=EvidenceLevel.PREDICTED,
    )
    session.add(bgc)
    session.commit()

    result = score_bgc(bgc, build_scoring_context(session))
    assert result.score is None
    assert len(result.unavailable_components) >= 3
    assert any("too few to combine" in c for c in result.caveats)
    # Components are still returned — they explain *why* there's no score.
    assert len(result.components) == 5


# === epistemic framing is structural, not decorative =============================


def test_every_result_carries_the_not_a_novelty_claim_caveat(builder, session):
    bgc = builder.add_bgc(
        genus_name="Streptomyces", species_name="S. one", accession="GCF_1.1", family_label="FAM_A"
    )
    session.commit()
    result = score_bgc(bgc, build_scoring_context(session))

    joined = " ".join(result.caveats).lower()
    assert "does not indicate a novel compound" in joined
    assert "not a measurement" in joined
    assert "not a validated model" in joined


def test_components_are_always_returned_with_explanations(builder, session):
    bgc = builder.add_bgc(
        genus_name="Streptomyces", species_name="S. one", accession="GCF_1.1", family_label="FAM_A"
    )
    session.commit()
    result = score_bgc(bgc, build_scoring_context(session))

    assert len(result.components) == 5
    for component in result.components:
        assert component.explanation, f"{component.name} has no explanation"
        assert len(component.explanation) > 20


def test_default_weights_are_uniform_asserting_no_ordering(builder):
    """An unequal default would encode a scientific claim this module has
    no basis for."""
    assert len(set(DEFAULT_WEIGHTS.values())) == 1


# === individual components ========================================================


def test_unclustered_bgc_scores_high_on_that_component(builder, session):
    clustered = builder.add_bgc(
        genus_name="Streptomyces", species_name="S. a", accession="GCF_A.1", family_label="FAM_A"
    )
    builder.add_bgc(genus_name="Streptomyces", species_name="S. b", accession="GCF_B.1", family_label="FAM_A")
    orphan = builder.add_bgc(genus_name="Streptomyces", species_name="S. c", accession="GCF_C.1")
    session.commit()

    ctx = build_scoring_context(session)
    assert _component(score_bgc(orphan, ctx), "unclustered").value == 1.0
    assert _component(score_bgc(clustered, ctx), "unclustered").value == 0.0


def test_unclustered_is_unavailable_when_no_clustering_was_ingested(builder, session):
    """With no BiG-SCAPE run in the corpus, *everything* is unclustered —
    which says nothing about any individual cluster."""
    bgc = builder.add_bgc(genus_name="Streptomyces", species_name="S. a", accession="GCF_A.1")
    session.commit()
    ctx = build_scoring_context(session)
    assert ctx.families_present is False
    assert _component(score_bgc(bgc, ctx), "unclustered").value is None


def test_family_rarity_favours_singletons(builder, session):
    singleton = builder.add_bgc(
        genus_name="Streptomyces", species_name="S. a", accession="GCF_A.1", family_label="FAM_SOLO"
    )
    crowded = builder.add_bgc(
        genus_name="Streptomyces", species_name="S. b", accession="GCF_B.1", family_label="FAM_BIG"
    )
    for i in range(3):
        builder.add_bgc(
            genus_name="Streptomyces", species_name=f"S. x{i}", accession=f"GCF_X{i}.1", family_label="FAM_BIG"
        )
    session.commit()

    ctx = build_scoring_context(session)
    assert _component(score_bgc(singleton, ctx), "family_rarity").value == pytest.approx(1.0)
    assert _component(score_bgc(crowded, ctx), "family_rarity").value == pytest.approx(0.25)


def test_mibig_membership_lowers_the_distance_component(builder, session):
    reference = builder.add_bgc(
        genus_name="Streptomyces",
        species_name="S. ref",
        accession="GCF_REF.1",
        family_label="FAM_KNOWN",
        mibig_accession="BGC-TEST0000001",
    )
    relative = builder.add_bgc(
        genus_name="Streptomyces", species_name="S. rel", accession="GCF_REL.1", family_label="FAM_KNOWN"
    )
    stranger = builder.add_bgc(
        genus_name="Streptomyces", species_name="S. str", accession="GCF_STR.1", family_label="FAM_OTHER"
    )
    session.commit()

    ctx = build_scoring_context(session)
    assert ctx.mibig_present is True
    assert _component(score_bgc(reference, ctx), "mibig_distance").value == 0.0
    assert _component(score_bgc(relative, ctx), "mibig_distance").value == 0.25
    assert _component(score_bgc(stranger, ctx), "mibig_distance").value == 1.0


def test_unclustered_bgc_cannot_be_assessed_for_mibig_distance(builder, session):
    """Unclustered is not the same as 'distant from characterized
    clusters' — it means the question wasn't answerable."""
    builder.add_bgc(
        genus_name="Streptomyces",
        species_name="S. ref",
        accession="GCF_REF.1",
        family_label="FAM_KNOWN",
        mibig_accession="BGC-TEST0000001",
    )
    orphan = builder.add_bgc(genus_name="Streptomyces", species_name="S. orphan", accession="GCF_ORPH.1")
    session.commit()

    component = _component(score_bgc(orphan, build_scoring_context(session)), "mibig_distance")
    assert component.value is None
    assert "wasn't answerable" in component.explanation


def test_class_rarity_needs_a_real_peer_group(builder, session):
    lonely = builder.add_bgc(genus_name="Solitarius", species_name="S. only", accession="GCF_SOLO.1")
    session.commit()
    component = _component(score_bgc(lonely, build_scoring_context(session)), "class_rarity_in_clade")
    assert component.value is None
    assert "too few" in component.explanation


def test_class_rarity_reflects_frequency_within_the_enclosing_genus(builder, session):
    for i in range(4):
        builder.add_bgc(
            genus_name="Streptomyces",
            species_name=f"S. n{i}",
            accession=f"GCF_N{i}.1",
            bgc_class=BGCClass.NRPS,
        )
    odd = builder.add_bgc(
        genus_name="Streptomyces", species_name="S. odd", accession="GCF_ODD.1", bgc_class=BGCClass.ALKALOID
    )
    session.commit()

    ctx = build_scoring_context(session)
    component = _component(score_bgc(odd, ctx), "class_rarity_in_clade")
    # 1 alkaloid out of 5 BGCs in the genus -> 1 - 0.2 = 0.8
    assert component.value == pytest.approx(0.8)


# === ranking ======================================================================


def test_rank_orders_by_score_and_keeps_unscoreable_last(builder, session):
    builder.add_bgc(
        genus_name="Streptomyces",
        species_name="S. ref",
        accession="GCF_REF.1",
        family_label="FAM_KNOWN",
        mibig_accession="BGC-TEST0000001",
    )
    for i in range(3):
        builder.add_bgc(
            genus_name="Streptomyces",
            species_name=f"S. c{i}",
            accession=f"GCF_C{i}.1",
            family_label="FAM_KNOWN",
        )
    builder.add_bgc(
        genus_name="Streptomyces", species_name="S. rare", accession="GCF_RARE.1", family_label="FAM_SOLO"
    )
    session.commit()

    results = rank_bgcs(session)
    scores = [r.score for r in results]
    scored = [s for s in scores if s is not None]
    assert scored == sorted(scored, reverse=True)
    # Unscoreable entries, if any, sort last rather than being dropped.
    assert len(results) == 5
    if None in scores:
        assert scores.index(None) >= len(scored)


def test_rank_respects_limit(builder, session):
    for i in range(6):
        builder.add_bgc(
            genus_name="Streptomyces", species_name=f"S. {i}", accession=f"GCF_{i}.1", family_label=f"FAM_{i}"
        )
    session.commit()
    assert len(rank_bgcs(session, limit=3)) == 3


def test_custom_weights_change_the_ranking(builder, session):
    """Weights are the researcher's judgement to make, so they have to
    actually do something."""
    builder.add_bgc(
        genus_name="Streptomyces",
        species_name="S. ref",
        accession="GCF_REF.1",
        family_label="FAM_KNOWN",
        mibig_accession="BGC-TEST0000001",
    )
    solo = builder.add_bgc(
        genus_name="Streptomyces", species_name="S. solo", accession="GCF_SOLO.1", family_label="FAM_SOLO"
    )
    session.commit()
    ctx = build_scoring_context(session)

    balanced = score_bgc(solo, ctx, DEFAULT_WEIGHTS).score
    rarity_only = score_bgc(
        solo,
        ctx,
        {"family_rarity": 1.0, "unclustered": 0.0, "taxonomic_isolation": 0.0, "mibig_distance": 0.0,
         "class_rarity_in_clade": 0.0},
    ).score
    assert balanced != pytest.approx(rarity_only)
    assert rarity_only == pytest.approx(1.0)


def test_small_corpus_caveat_is_raised(builder, session):
    bgc = builder.add_bgc(
        genus_name="Streptomyces", species_name="S. a", accession="GCF_A.1", family_label="FAM_A"
    )
    session.commit()
    result = score_bgc(bgc, build_scoring_context(session))
    assert any("mostly reflects what hasn't been ingested yet" in c for c in result.caveats)
