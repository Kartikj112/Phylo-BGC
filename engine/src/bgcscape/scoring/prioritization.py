"""BGC prioritization scoring (report §8).

## What this is, and what it is emphatically not

The original report is explicit, and this module holds the line: this
produces a **prioritization score**, an ordinal ranking hint for deciding
which clusters to look at first. It is **not** a novelty measurement, not
a probability, and not evidence that any cluster produces a new compound.
Nothing here should ever be rendered to a user as "novelty: 0.87".

Three properties follow from that, and they shape the whole design:

**1. Components are never collapsed into a bare number.**
`PrioritizationResult` always carries its per-component breakdown. A rank
a user can't interrogate is a rank they can't disagree with, and every
component here is a proxy standing in for something we can't measure
directly.

**2. Weights are explicit, overridable, and uncalibrated by construction.**
How much "no MIBiG relative" should count against "singleton family" is a
scientific judgement about a specific research question — not a constant
this module is entitled to pick on a researcher's behalf. `DEFAULT_WEIGHTS`
is a documented starting point that treats the signals as roughly
comparable, explicitly *not* a validated model. `WEIGHTS_ARE_UNCALIBRATED`
is returned in every result's caveats.

**3. Missing evidence is never scored as evidence.**
This is the failure mode that would make the whole feature actively
harmful, so it gets structural enforcement rather than a comment. If MIBiG
has never been ingested, "this BGC has no close MIBiG relative" is not a
finding — it's an artifact of an empty reference set, and scoring it as
maximal distance would rank *every* cluster in the database as maximally
interesting. Components that cannot be computed return `None` (an
`available=False` component), are excluded from the weighted mean, and are
named in `unavailable_components` so the caller can see the score rests on
less than it appears to.

**4. "Rare" is relative to what was EXAMINED, not to what was ingested.**
Every rarity component is a fraction, and the denominator used to be "rows
that happen to be in this database". That is not a corpus — it is whatever
somebody loaded. A cluster class occurring in 1 of 40 curated entries is not
"rare in this clade" unless those 40 genomes were actually surveyed for
clusters, and the genomes MIBiG happens to have entries for were not.

So the denominators now come from `AnalysisRun` coverage
(`bgcscape.coverage`), and each component's explanation names the
denominator it used:

  * `class_rarity_in_clade` counts only clusters on genomes a
    BGC_DETECTION run covered, over the peer group's EXAMINED genomes. Under
    two examined genomes it returns `None` — a "frequency" over an unsurveyed
    peer group is a statement about somebody's reading list.
  * `unclustered`, `family_rarity` and `taxonomic_isolation` are answerable
    only for genomes a SEQUENCE_CLUSTERING run reached. This is the fix for a
    bug that was dormant only because no clustering had been ingested: with
    one BiG-SCAPE run over ten genomes, every other cluster in the corpus
    scored 1.0 on `unclustered` — "no sufficiently similar cluster was found"
    — having never been compared to anything.

The consequence on a MIBiG-derived corpus is that most components go
unavailable and most clusters decline to score. That is the correct answer
and always was; the numbers the scorer used to emit there were the artifact.
"""
from __future__ import annotations

import uuid
from collections import defaultdict
from dataclasses import dataclass, field

from sqlalchemy.orm import Session, selectinload

from bgcscape.coverage import examined_genome_ids
from bgcscape.models import (
    BGC,
    AnalysisType,
    BGCFamily,
    BGCFamilyMembership,
    FamilyKind,
    Genome,
    Taxon,
)

WEIGHTS_ARE_UNCALIBRATED = (
    "Component weights are a documented starting point, not a validated model. They encode a "
    "judgement about which signals matter for a particular research question and should be set "
    "deliberately rather than accepted as a default."
)

SCORE_IS_ORDINAL = (
    "This is a prioritization hint for ranking candidates, not a measurement. A score of 0.8 is not "
    "'80% novel' and not twice as interesting as 0.4 — the only claim is that higher-scoring "
    "clusters are plausible places to look first."
)

NOT_A_NOVELTY_CLAIM = (
    "A high score does not indicate a novel compound. Every component is a proxy computed from "
    "genomic context and database coverage; none observes chemistry."
)


@dataclass(frozen=True)
class ComponentScore:
    """One signal. `value` is None when the signal could not be computed —
    which is different from, and must never be silently treated as, zero
    or one."""

    name: str
    value: float | None
    explanation: str

    @property
    def available(self) -> bool:
        return self.value is not None


# Deliberately uniform: an unequal default would encode a scientific claim
# this module has no basis for. Equal weighting is at least an honest
# statement that no ordering of the signals is being asserted.
DEFAULT_WEIGHTS: dict[str, float] = {
    "unclustered": 1.0,
    "family_rarity": 1.0,
    "taxonomic_isolation": 1.0,
    "mibig_distance": 1.0,
    "class_rarity_in_clade": 1.0,
}


@dataclass
class PrioritizationResult:
    bgc_id: uuid.UUID
    score: float | None
    components: list[ComponentScore]
    #: Everything a reader needs to interpret THIS result standalone:
    #: the corpus-level caveats plus the ones specific to this cluster.
    caveats: list[str] = field(default_factory=list)
    #: Only the caveats that are specific to this cluster — its component
    #: coverage, its by-construction bias. Kept separate because hoisting
    #: one cluster's coverage caveat to the top of a whole ranking states
    #: something false about every other row (it did exactly that until
    #: this split existed).
    specific_caveats: list[str] = field(default_factory=list)

    @property
    def unavailable_components(self) -> list[str]:
        return [c.name for c in self.components if not c.available]

    @property
    def available_component_count(self) -> int:
        return sum(1 for c in self.components if c.available)


@dataclass
class ScoringContext:
    """Corpus-wide statistics, computed once per scoring run.

    Every component is relative to the ingested corpus — "rare" only means
    "rare in this database". Building this explicitly (rather than
    querying per BGC) keeps that dependency visible and makes the
    corpus-level caveats computable in one place.
    """

    total_bgcs: int
    family_sizes: dict[uuid.UUID, int]
    family_taxa: dict[uuid.UUID, set[uuid.UUID]]
    families_with_mibig: set[uuid.UUID]
    mibig_present: bool
    families_present: bool
    class_counts_by_parent: dict[uuid.UUID, dict[str, int]]
    parent_taxon_by_genome: dict[uuid.UUID, uuid.UUID | None]
    genome_count_by_parent: dict[uuid.UUID, int]
    #: Ids of the families that are *sequence* families (BiG-SCAPE GCFs).
    #: Every family-derived component is defined over these and only these
    #: — see `FamilyKind`. Compound groups live in the same table but are a
    #: different scientific object and must not feed a similarity claim.
    sequence_family_ids: set[uuid.UUID] = field(default_factory=set)
    #: How many compound groups exist in the corpus. Only used to explain,
    #: in the caveats, that they were deliberately excluded from scoring.
    compound_group_count: int = 0

    # ---- coverage: the denominators -------------------------------------
    #: Genomes a BGC_DETECTION run covered. The denominator for
    #: `class_rarity_in_clade`, and the set within which a zero is a
    #: finding rather than a gap.
    detection_covered: set[uuid.UUID] = field(default_factory=set)
    #: Genomes a SEQUENCE_CLUSTERING run reached. The set within which
    #: "nothing similar was found" is answerable at all.
    clustering_covered: set[uuid.UUID] = field(default_factory=set)
    #: BGCs on detection-covered genomes — the corpus `class_rarity_in_clade`
    #: is actually computed over, as opposed to everything ingested.
    examined_bgc_count: int = 0
    #: BGCs on clustering-covered genomes: the population a family's size is
    #: rare *within*.
    clustered_bgc_count: int = 0
    #: Examined genomes per peer group, replacing "genomes that happen to
    #: have a BGC" as the denominator for "unusual for its neighbours".
    examined_genome_count_by_parent: dict[uuid.UUID, int] = field(default_factory=dict)


def sequence_memberships(bgc: BGC, ctx: ScoringContext) -> list[BGCFamilyMembership]:
    """The BGC's memberships in *sequence* families only.

    Every component that reasons about similarity goes through here. A
    membership in a compound group is an experimental fact about shared
    chemistry, not a sequence comparison, and must never be read as one.
    """
    return [m for m in bgc.family_memberships if m.family_id in ctx.sequence_family_ids]


def build_scoring_context(session: Session) -> ScoringContext:
    bgcs = (
        session.query(BGC)
        .options(selectinload(BGC.family_memberships), selectinload(BGC.genome))
        .all()
    )
    taxa = {t.id: t for t in session.query(Taxon).all()}
    genomes = {g.id: g for g in session.query(Genome).all()}

    # Coverage, from AnalysisRun. `detection_covered` is taken ONLY from
    # recorded runs: nothing about a BGC's existence implies its genome was
    # surveyed, because a curated MIBiG entry is a report that one cluster
    # exists, not a search of the genome. Deriving detection coverage from
    # the presence of clusters would recreate the exact conflation this
    # change exists to remove.
    detection_covered = examined_genome_ids(session, AnalysisType.BGC_DETECTION)
    clustering_covered = examined_genome_ids(session, AnalysisType.SEQUENCE_CLUSTERING)

    kind_by_family: dict[uuid.UUID, FamilyKind] = {
        fid: kind for fid, kind in session.query(BGCFamily.id, BGCFamily.kind).all()
    }
    sequence_family_ids = {
        fid for fid, kind in kind_by_family.items() if kind == FamilyKind.SEQUENCE_FAMILY
    }
    compound_group_count = sum(
        1 for kind in kind_by_family.values() if kind == FamilyKind.COMPOUND_GROUP
    )

    def enclosing_group(genome_id: uuid.UUID) -> uuid.UUID | None:
        """The genus (or nearest ancestor at/above genus) a genome sits in.

        Class rarity is judged against a peer group, and species level is
        too narrow to be informative — a species with two genomes makes
        every class in it look 'common'. Genus is the coarsest rank that's
        still biologically meaningful for 'unusual for its neighbours'.
        """
        genome = genomes.get(genome_id)
        if genome is None or genome.taxon_id is None:
            return None
        current = taxa.get(genome.taxon_id)
        while current is not None:
            if current.rank.value in ("genus", "family", "order", "class", "phylum", "domain"):
                return current.id
            current = taxa.get(current.parent_id) if current.parent_id else None
        return None

    family_sizes: dict[uuid.UUID, int] = defaultdict(int)
    family_taxa: dict[uuid.UUID, set[uuid.UUID]] = defaultdict(set)
    families_with_mibig: set[uuid.UUID] = set()
    class_counts_by_parent: dict[uuid.UUID, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    parent_taxon_by_genome: dict[uuid.UUID, uuid.UUID | None] = {}
    genomes_seen_by_parent: dict[uuid.UUID, set[uuid.UUID]] = defaultdict(set)

    mibig_present = any(b.mibig_accession for b in bgcs)

    # Clustering coverage IS derivable in one direction, and honestly so: a
    # genome carrying a BGC in a sequence family was demonstrably part of a
    # clustering run — the membership is the run's own output. So a corpus
    # whose clustering predates AnalysisRun still answers correctly, and the
    # derivation adds evidence rather than assuming it. The reverse
    # derivation is the one that does not hold, and is not made: a genome
    # with no memberships tells you nothing about whether it was compared.
    for bgc in bgcs:
        if any(m.family_id in sequence_family_ids for m in bgc.family_memberships):
            clustering_covered.add(bgc.genome_id)

    examined_bgc_count = sum(1 for b in bgcs if b.genome_id in detection_covered)
    clustered_bgc_count = sum(1 for b in bgcs if b.genome_id in clustering_covered)

    for bgc in bgcs:
        parent = parent_taxon_by_genome.get(bgc.genome_id)
        if bgc.genome_id not in parent_taxon_by_genome:
            parent = enclosing_group(bgc.genome_id)
            parent_taxon_by_genome[bgc.genome_id] = parent

        # Numerator and denominator must come from the same population.
        # Counting a curated cluster into the numerator while the
        # denominator is "genomes actually surveyed" would make a clade look
        # unusual in proportion to how much literature it has, which is a
        # property of the reading list, not the biology.
        if parent is not None and bgc.genome_id in detection_covered:
            class_counts_by_parent[parent][bgc.bgc_class.value] += 1
            genomes_seen_by_parent[parent].add(bgc.genome_id)

        genome_taxon = genomes[bgc.genome_id].taxon_id if bgc.genome_id in genomes else None
        for membership in bgc.family_memberships:
            # Sequence families only: pooling compound groups in here is
            # exactly the bug this filter exists to prevent.
            if membership.family_id not in sequence_family_ids:
                continue
            family_sizes[membership.family_id] += 1
            if genome_taxon is not None:
                family_taxa[membership.family_id].add(genome_taxon)
            if bgc.mibig_accession:
                families_with_mibig.add(membership.family_id)

    # Every examined genome in a peer group counts toward its denominator,
    # including the ones a run found nothing in — those are precisely the
    # observations that make a class look rare, and dropping them would
    # inflate every frequency in the group.
    examined_genome_count_by_parent: dict[uuid.UUID, int] = defaultdict(int)
    for genome_id in detection_covered:
        parent = parent_taxon_by_genome.get(genome_id)
        if genome_id not in parent_taxon_by_genome:
            parent = enclosing_group(genome_id)
            parent_taxon_by_genome[genome_id] = parent
        if parent is not None:
            examined_genome_count_by_parent[parent] += 1

    return ScoringContext(
        total_bgcs=len(bgcs),
        family_sizes=dict(family_sizes),
        family_taxa={k: v for k, v in family_taxa.items()},
        families_with_mibig=families_with_mibig,
        mibig_present=mibig_present,
        # "Has a sequence clustering been run over this corpus?" — the
        # question `unclustered` depends on. Compound groups cannot answer
        # it, so they deliberately do not make it true.
        families_present=bool(sequence_family_ids),
        class_counts_by_parent={k: dict(v) for k, v in class_counts_by_parent.items()},
        parent_taxon_by_genome=parent_taxon_by_genome,
        genome_count_by_parent={k: len(v) for k, v in genomes_seen_by_parent.items()},
        sequence_family_ids=sequence_family_ids,
        compound_group_count=compound_group_count,
        detection_covered=detection_covered,
        clustering_covered=clustering_covered,
        examined_bgc_count=examined_bgc_count,
        clustered_bgc_count=clustered_bgc_count,
        examined_genome_count_by_parent=dict(examined_genome_count_by_parent),
    )


def _component_unclustered(bgc: BGC, ctx: ScoringContext) -> ComponentScore:
    if not ctx.families_present:
        return ComponentScore(
            "unclustered",
            None,
            "No family clustering has been ingested, so 'unclustered' carries no information here.",
        )
    if bgc.genome_id not in ctx.clustering_covered:
        # The bug this branch fixes: one clustering run over ten genomes used
        # to make every OTHER cluster in the corpus score 1.0 here, with the
        # explanation "no sufficiently similar cluster was found" — a
        # similarity claim about clusters that were never compared to
        # anything. Being outside a clustering run is not a finding.
        return ComponentScore(
            "unclustered",
            None,
            "This cluster's genome was not covered by any sequence-clustering run, so it has "
            "never been compared to anything. That is not the same as having no similar cluster "
            "— the question was not asked of it.",
        )
    if not sequence_memberships(bgc, ctx):
        return ComponentScore(
            "unclustered",
            1.0,
            f"Not assigned to any sequence-based gene cluster family — no sufficiently similar "
            f"cluster was found among the {ctx.clustered_bgc_count} cluster(s) that were actually "
            f"clustered.",
        )
    return ComponentScore(
        "unclustered", 0.0, "Belongs to a sequence-based gene cluster family with other members."
    )


def _component_family_rarity(bgc: BGC, ctx: ScoringContext) -> ComponentScore:
    memberships = sequence_memberships(bgc, ctx)
    if not memberships:
        return ComponentScore(
            "family_rarity",
            None,
            "Not in a sequence family, so family size is undefined (see the 'unclustered' "
            "component instead).",
        )
    sizes = [ctx.family_sizes.get(m.family_id, 1) for m in memberships]
    smallest = min(sizes)
    # 1/n: a singleton scores 1.0, a pair 0.5, and the curve flattens
    # quickly — which matches the intuition that the gap between 1 and 2
    # members is far more meaningful than between 20 and 21.
    value = 1.0 / smallest
    return ComponentScore(
        "family_rarity",
        value,
        f"Smallest containing sequence family has {smallest} "
        f"member{'s' if smallest != 1 else ''}, out of the {ctx.clustered_bgc_count} cluster(s) "
        f"a clustering run actually compared. Rarity is relative to that population, not to "
        f"everything ingested.",
    )


def _component_taxonomic_isolation(bgc: BGC, ctx: ScoringContext) -> ComponentScore:
    memberships = sequence_memberships(bgc, ctx)
    if not memberships:
        return ComponentScore(
            "taxonomic_isolation", None, "Not in a sequence family, so taxonomic spread is undefined."
        )
    spreads = [len(ctx.family_taxa.get(m.family_id, set())) for m in memberships]
    spread = max(spreads) if spreads else 0
    if spread == 0:
        return ComponentScore(
            "taxonomic_isolation", None, "No classified taxa among this family's members; spread is undefined."
        )
    value = 1.0 / spread
    return ComponentScore(
        "taxonomic_isolation",
        value,
        f"Sequence family spans {spread} classified taxon{'a' if spread != 1 else ''} among the "
        f"genomes a clustering run covered. A family confined to one taxon is less well "
        "characterized across the tree; note this cuts both ways — a widely distributed family "
        "may be a transfer signal worth attention too. The spread is bounded by which genomes "
        "were clustered, not by where the family really occurs.",
    )


def _component_mibig_distance(bgc: BGC, ctx: ScoringContext) -> ComponentScore:
    if not ctx.mibig_present:
        # THE critical case. Without a reference set, "no MIBiG relative"
        # is a statement about the database, not the cluster.
        return ComponentScore(
            "mibig_distance",
            None,
            "No MIBiG reference entries have been ingested, so distance from characterized clusters "
            "cannot be assessed. Absence of a match here would reflect an empty reference set, not "
            "an unusual cluster.",
        )
    if bgc.mibig_accession:
        return ComponentScore(
            "mibig_distance", 0.0, "This cluster is itself a MIBiG reference entry — already characterized."
        )
    memberships = sequence_memberships(bgc, ctx)
    in_mibig_family = any(m.family_id in ctx.families_with_mibig for m in memberships)
    if in_mibig_family:
        return ComponentScore(
            "mibig_distance",
            0.25,
            "Clusters with a MIBiG reference entry in the same family — likely related to a "
            "characterized pathway.",
        )
    if bgc.genome_id not in ctx.clustering_covered:
        return ComponentScore(
            "mibig_distance",
            None,
            "This cluster has never been compared to anything — its genome was not covered by a "
            "sequence-clustering run — so no family-mediated link to MIBiG can be assessed.",
        )
    if not memberships:
        return ComponentScore(
            "mibig_distance",
            None,
            "Unclustered, so no family-mediated link to MIBiG can be assessed. This is not the same "
            "as being distant from characterized clusters — it means the question wasn't answerable.",
        )
    return ComponentScore(
        "mibig_distance",
        1.0,
        "No MIBiG reference entry in any containing sequence family, given the MIBiG entries "
        "ingested here.",
    )


def _component_class_rarity_in_clade(bgc: BGC, ctx: ScoringContext) -> ComponentScore:
    parent = ctx.parent_taxon_by_genome.get(bgc.genome_id)
    if parent is None:
        return ComponentScore(
            "class_rarity_in_clade",
            None,
            "Genome is not classified to genus level or above, so it has no peer group to be unusual "
            "relative to.",
        )
    counts = ctx.class_counts_by_parent.get(parent, {})
    total = sum(counts.values())
    examined_in_group = ctx.examined_genome_count_by_parent.get(parent, 0)
    if examined_in_group < 2:
        # The denominator correction. This used to count "genomes in the
        # group that happen to have a BGC row", which on a curated corpus is
        # "genomes somebody published about" — so a class was called rare in
        # proportion to how thin the literature was, not how thin the class
        # is. A frequency needs a survey underneath it, and under two
        # surveyed genomes there is no peer group to be unusual within.
        return ComponentScore(
            "class_rarity_in_clade",
            None,
            f"Only {examined_in_group} genome(s) in this cluster's enclosing group have been "
            "examined for clusters by a recorded analysis run — too few for 'unusual for its "
            "neighbours' to mean anything. The neighbours have to have been surveyed; counting "
            "curated entries instead would measure the literature, not the biology.",
        )
    if total == 0:
        return ComponentScore(
            "class_rarity_in_clade",
            None,
            f"The {examined_in_group} examined genome(s) in this group carry no clusters at all, "
            "so there is no class distribution to be unusual within.",
        )
    own = counts.get(bgc.bgc_class.value, 0)
    frequency = own / total
    value = 1.0 - frequency
    return ComponentScore(
        "class_rarity_in_clade",
        value,
        f"{bgc.bgc_class.value} accounts for {own}/{total} clusters found across the "
        f"{examined_in_group} EXAMINED genome(s) in this cluster's enclosing group. Clusters on "
        "unexamined genomes in the same group are excluded from both halves of that fraction.",
    )


_COMPONENT_FUNCS = (
    _component_unclustered,
    _component_family_rarity,
    _component_taxonomic_isolation,
    _component_mibig_distance,
    _component_class_rarity_in_clade,
)

MIN_COMPONENTS_FOR_SCORE = 2


def corpus_caveats(ctx: ScoringContext) -> list[str]:
    """Caveats true of the whole scoring run, independent of any one cluster.

    Kept separate from per-cluster caveats so a caller can label a ranking
    as a whole without asserting one row's component coverage over all the
    others.
    """
    caveats = [NOT_A_NOVELTY_CLAIM, SCORE_IS_ORDINAL, WEIGHTS_ARE_UNCALIBRATED]

    # The denominators, stated before anything that uses them. An unstated
    # denominator is what made "rare in this corpus" mean "rare among rows
    # somebody loaded" for as long as it did.
    examined_genomes = len(ctx.detection_covered)
    if examined_genomes == 0:
        caveats.append(
            "DENOMINATOR: no genome in this corpus has been covered by a recorded "
            "cluster-detection run. 'Rare' has nothing to be rare within — the clusters here are "
            "curated reports, not the result of surveying any genome — so class rarity is "
            "uncomputable for every cluster. Ingest an antiSMASH run, or declare an existing one "
            "with `bgcscape record-analysis-run`, to make rarity answerable."
        )
    else:
        caveats.append(
            f"DENOMINATOR: class rarity is computed over the {ctx.examined_bgc_count} cluster(s) "
            f"on the {examined_genomes} genome(s) that a cluster-detection run actually covered — "
            "not over everything ingested. Clusters on unexamined genomes are excluded from both "
            "the numerator and the denominator of every frequency here."
        )

    clustered_genomes = len(ctx.clustering_covered)
    if clustered_genomes:
        caveats.append(
            f"DENOMINATOR: family rarity and taxonomic spread are computed over the "
            f"{ctx.clustered_bgc_count} cluster(s) on the {clustered_genomes} genome(s) a "
            "sequence-clustering run reached. Clusters outside that run are not scored on those "
            "components at all, because nothing compared them."
        )

    if not ctx.families_present:
        caveats.append(
            "No sequence-based gene cluster families (e.g. BiG-SCAPE) have been ingested, so the "
            "three components that depend on sequence clustering are uncomputable for every "
            "cluster. Rankings here rest on the remaining signals only."
        )
    if ctx.compound_group_count:
        caveats.append(
            f"This corpus contains {ctx.compound_group_count} compound group(s) — clusters grouped "
            "because MIBiG records them as making the same named compound. Those are a curated "
            "chemical fact, not a sequence comparison, and are deliberately EXCLUDED from every "
            "component here. Being absent from a compound group is not evidence that a cluster is "
            "sequence-novel."
        )
    if not ctx.mibig_present:
        caveats.append(
            "No MIBiG reference data in this corpus — the most informative signal for prioritization "
            "is missing entirely, and rankings here reflect only genomic context."
        )
    if ctx.total_bgcs < 50:
        caveats.append(
            f"Corpus contains {ctx.total_bgcs} BGCs. Every component is relative to what has been "
            "examined; 'rare' in a small corpus mostly reflects what hasn't been examined yet."
        )
    return caveats


def score_bgc(bgc: BGC, ctx: ScoringContext, weights: dict[str, float] | None = None) -> PrioritizationResult:
    """Score one BGC. Returns components even when no overall score can be
    computed — the breakdown is useful on its own, and suppressing it
    would hide *why* the score is unavailable."""
    active_weights = weights or DEFAULT_WEIGHTS
    components = [func(bgc, ctx) for func in _COMPONENT_FUNCS]

    available = [c for c in components if c.available]
    shared = corpus_caveats(ctx)
    specific: list[str] = []

    def _result(score: float | None) -> PrioritizationResult:
        return PrioritizationResult(
            bgc_id=bgc.id,
            score=score,
            components=components,
            caveats=[*shared, *specific],
            specific_caveats=list(specific),
        )

    if len(available) < MIN_COMPONENTS_FOR_SCORE:
        specific.append(
            f"Only {len(available)} of {len(components)} components could be computed — too few to "
            "combine into a ranking. Read the components individually."
        )
        return _result(None)

    # Weighted mean over available components only. Treating an
    # unavailable component as zero would penalize clusters for gaps in
    # the reference data; treating it as one would reward them for it.
    total_weight = sum(active_weights.get(c.name, 0.0) for c in available)
    if total_weight == 0:
        specific.append("All available components have zero weight, so no score can be computed.")
        return _result(None)

    weighted = sum((c.value or 0.0) * active_weights.get(c.name, 0.0) for c in available)
    score = weighted / total_weight

    missing = [c.name for c in components if not c.available]
    if missing:
        specific.append(
            f"Computed from {len(available)} of {len(components)} components; unavailable: "
            f"{', '.join(missing)}. Scores resting on different component sets are not directly "
            "comparable to each other."
        )

    # A systematic bias, surfaced rather than silently corrected. Being
    # unclustered scores 1.0 AND makes family_rarity, taxonomic_isolation
    # and mibig_distance uncomputable — so an unclustered BGC's mean is
    # taken over few, high components and it rises to the top by
    # construction, not because the evidence is stronger. Found by running
    # the scorer over an 80-genome corpus, where the entire top of the
    # ranking turned out to be unclustered clusters.
    #
    # Deliberately not "fixed" by penalizing unclustered BGCs or imputing
    # values for the missing components: both would invent evidence, which
    # is the thing this module refuses to do. The defensible options are to
    # rank within equal-coverage groups, or to weight `unclustered` down —
    # and choosing between them is a scientific judgement, like the weights
    # themselves. So it's named here and left to the caller.
    unclustered = next((c for c in components if c.name == "unclustered"), None)
    if unclustered is not None and unclustered.value == 1.0 and len(missing) >= 2:
        specific.append(
            "This cluster ranks high partly BY CONSTRUCTION: being unclustered scores maximally on "
            "one component while making three others uncomputable, so its score is an average of few, "
            "high signals rather than strong evidence. Compare it against other unclustered clusters, "
            "not against clusters scored on the full component set."
        )
    return _result(score)


def rank_bgcs_with_context(
    session: Session,
    weights: dict[str, float] | None = None,
    limit: int | None = None,
) -> tuple[list[PrioritizationResult], ScoringContext]:
    """`rank_bgcs`, but also returning the context the run was scored against.

    Callers that render a ranking as a whole (the API, the CLI table) need
    the context to label it with `corpus_caveats(ctx)` rather than borrowing
    the top row's caveats, which describe only that row.
    """
    ctx = build_scoring_context(session)
    bgcs = session.query(BGC).options(selectinload(BGC.family_memberships), selectinload(BGC.genome)).all()
    results = [score_bgc(bgc, ctx, weights) for bgc in bgcs]
    results.sort(key=lambda r: (r.score is None, -(r.score or 0.0)))
    return (results[:limit] if limit else results), ctx


def rank_bgcs(
    session: Session,
    weights: dict[str, float] | None = None,
    limit: int | None = None,
) -> list[PrioritizationResult]:
    """Score every BGC, best-scoring first. Unscoreable BGCs sort last
    rather than being dropped — a cluster that couldn't be assessed is a
    fact the caller should see, not one to hide."""
    results, _ = rank_bgcs_with_context(session, weights, limit)
    return results
