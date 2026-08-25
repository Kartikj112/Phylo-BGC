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
"""
from __future__ import annotations

import uuid
from collections import defaultdict
from dataclasses import dataclass, field

from sqlalchemy.orm import Session, selectinload

from bgcscape.models import BGC, BGCFamilyMembership, Genome, Taxon

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
    caveats: list[str] = field(default_factory=list)

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


def build_scoring_context(session: Session) -> ScoringContext:
    bgcs = (
        session.query(BGC)
        .options(selectinload(BGC.family_memberships), selectinload(BGC.genome))
        .all()
    )
    taxa = {t.id: t for t in session.query(Taxon).all()}
    genomes = {g.id: g for g in session.query(Genome).all()}

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

    for bgc in bgcs:
        parent = parent_taxon_by_genome.get(bgc.genome_id)
        if bgc.genome_id not in parent_taxon_by_genome:
            parent = enclosing_group(bgc.genome_id)
            parent_taxon_by_genome[bgc.genome_id] = parent

        if parent is not None:
            class_counts_by_parent[parent][bgc.bgc_class.value] += 1
            genomes_seen_by_parent[parent].add(bgc.genome_id)

        genome_taxon = genomes[bgc.genome_id].taxon_id if bgc.genome_id in genomes else None
        for membership in bgc.family_memberships:
            family_sizes[membership.family_id] += 1
            if genome_taxon is not None:
                family_taxa[membership.family_id].add(genome_taxon)
            if bgc.mibig_accession:
                families_with_mibig.add(membership.family_id)

    return ScoringContext(
        total_bgcs=len(bgcs),
        family_sizes=dict(family_sizes),
        family_taxa={k: v for k, v in family_taxa.items()},
        families_with_mibig=families_with_mibig,
        mibig_present=mibig_present,
        families_present=bool(family_sizes),
        class_counts_by_parent={k: dict(v) for k, v in class_counts_by_parent.items()},
        parent_taxon_by_genome=parent_taxon_by_genome,
        genome_count_by_parent={k: len(v) for k, v in genomes_seen_by_parent.items()},
    )


def _component_unclustered(bgc: BGC, ctx: ScoringContext) -> ComponentScore:
    if not ctx.families_present:
        return ComponentScore(
            "unclustered",
            None,
            "No family clustering has been ingested, so 'unclustered' carries no information here.",
        )
    if not bgc.family_memberships:
        return ComponentScore(
            "unclustered",
            1.0,
            "Not assigned to any gene cluster family — no sufficiently similar cluster was found in "
            "this corpus.",
        )
    return ComponentScore("unclustered", 0.0, "Belongs to a gene cluster family with other members.")


def _component_family_rarity(bgc: BGC, ctx: ScoringContext) -> ComponentScore:
    if not bgc.family_memberships:
        return ComponentScore(
            "family_rarity",
            None,
            "Not in a family, so family size is undefined (see the 'unclustered' component instead).",
        )
    sizes = [ctx.family_sizes.get(m.family_id, 1) for m in bgc.family_memberships]
    smallest = min(sizes)
    # 1/n: a singleton scores 1.0, a pair 0.5, and the curve flattens
    # quickly — which matches the intuition that the gap between 1 and 2
    # members is far more meaningful than between 20 and 21.
    value = 1.0 / smallest
    return ComponentScore(
        "family_rarity",
        value,
        f"Smallest containing family has {smallest} member{'s' if smallest != 1 else ''} in this corpus.",
    )


def _component_taxonomic_isolation(bgc: BGC, ctx: ScoringContext) -> ComponentScore:
    if not bgc.family_memberships:
        return ComponentScore("taxonomic_isolation", None, "Not in a family, so taxonomic spread is undefined.")
    spreads = [len(ctx.family_taxa.get(m.family_id, set())) for m in bgc.family_memberships]
    spread = max(spreads) if spreads else 0
    if spread == 0:
        return ComponentScore(
            "taxonomic_isolation", None, "No classified taxa among this family's members; spread is undefined."
        )
    value = 1.0 / spread
    return ComponentScore(
        "taxonomic_isolation",
        value,
        f"Family spans {spread} classified taxon{'a' if spread != 1 else ''} in this corpus. "
        "A family confined to one taxon is less well characterized across the tree; note this cuts "
        "both ways — a widely distributed family may be a transfer signal worth attention too.",
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
    in_mibig_family = any(m.family_id in ctx.families_with_mibig for m in bgc.family_memberships)
    if in_mibig_family:
        return ComponentScore(
            "mibig_distance",
            0.25,
            "Clusters with a MIBiG reference entry in the same family — likely related to a "
            "characterized pathway.",
        )
    if not bgc.family_memberships:
        return ComponentScore(
            "mibig_distance",
            None,
            "Unclustered, so no family-mediated link to MIBiG can be assessed. This is not the same "
            "as being distant from characterized clusters — it means the question wasn't answerable.",
        )
    return ComponentScore(
        "mibig_distance",
        1.0,
        "No MIBiG reference entry in any containing family, given the MIBiG entries ingested here.",
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
    genomes_in_group = ctx.genome_count_by_parent.get(parent, 0)
    if total == 0 or genomes_in_group < 2:
        return ComponentScore(
            "class_rarity_in_clade",
            None,
            f"Peer group has {genomes_in_group} genome(s) with BGCs — too few for 'unusual for its "
            "neighbours' to mean anything.",
        )
    own = counts.get(bgc.bgc_class.value, 0)
    frequency = own / total
    value = 1.0 - frequency
    return ComponentScore(
        "class_rarity_in_clade",
        value,
        f"{bgc.bgc_class.value} accounts for {own}/{total} BGCs in this cluster's enclosing group.",
    )


_COMPONENT_FUNCS = (
    _component_unclustered,
    _component_family_rarity,
    _component_taxonomic_isolation,
    _component_mibig_distance,
    _component_class_rarity_in_clade,
)

MIN_COMPONENTS_FOR_SCORE = 2


def score_bgc(bgc: BGC, ctx: ScoringContext, weights: dict[str, float] | None = None) -> PrioritizationResult:
    """Score one BGC. Returns components even when no overall score can be
    computed — the breakdown is useful on its own, and suppressing it
    would hide *why* the score is unavailable."""
    active_weights = weights or DEFAULT_WEIGHTS
    components = [func(bgc, ctx) for func in _COMPONENT_FUNCS]

    available = [c for c in components if c.available]
    caveats = [NOT_A_NOVELTY_CLAIM, SCORE_IS_ORDINAL, WEIGHTS_ARE_UNCALIBRATED]

    if len(available) < MIN_COMPONENTS_FOR_SCORE:
        caveats.append(
            f"Only {len(available)} of {len(components)} components could be computed — too few to "
            "combine into a ranking. Read the components individually."
        )
        return PrioritizationResult(bgc_id=bgc.id, score=None, components=components, caveats=caveats)

    # Weighted mean over available components only. Treating an
    # unavailable component as zero would penalize clusters for gaps in
    # the reference data; treating it as one would reward them for it.
    total_weight = sum(active_weights.get(c.name, 0.0) for c in available)
    if total_weight == 0:
        caveats.append("All available components have zero weight, so no score can be computed.")
        return PrioritizationResult(bgc_id=bgc.id, score=None, components=components, caveats=caveats)

    weighted = sum((c.value or 0.0) * active_weights.get(c.name, 0.0) for c in available)
    score = weighted / total_weight

    missing = [c.name for c in components if not c.available]
    if missing:
        caveats.append(
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
        caveats.append(
            "This cluster ranks high partly BY CONSTRUCTION: being unclustered scores maximally on "
            "one component while making three others uncomputable, so its score is an average of few, "
            "high signals rather than strong evidence. Compare it against other unclustered clusters, "
            "not against clusters scored on the full component set."
        )
    if not ctx.mibig_present:
        caveats.append(
            "No MIBiG reference data in this corpus — the most informative signal for prioritization "
            "is missing entirely, and rankings here reflect only genomic context."
        )
    if ctx.total_bgcs < 50:
        caveats.append(
            f"Corpus contains {ctx.total_bgcs} BGCs. Every component is relative to what has been "
            "ingested; 'rare' in a small corpus mostly reflects what hasn't been ingested yet."
        )

    return PrioritizationResult(bgc_id=bgc.id, score=score, components=components, caveats=caveats)


def rank_bgcs(
    session: Session,
    weights: dict[str, float] | None = None,
    limit: int | None = None,
) -> list[PrioritizationResult]:
    """Score every BGC, best-scoring first. Unscoreable BGCs sort last
    rather than being dropped — a cluster that couldn't be assessed is a
    fact the caller should see, not one to hide."""
    ctx = build_scoring_context(session)
    bgcs = session.query(BGC).options(selectinload(BGC.family_memberships), selectinload(BGC.genome)).all()
    results = [score_bgc(bgc, ctx, weights) for bgc in bgcs]
    results.sort(key=lambda r: (r.score is None, -(r.score or 0.0)))
    return results[:limit] if limit else results
