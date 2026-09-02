"""Comparative clade analysis.

Answers the original report's §4.7 question — "what biosynthetic
capabilities distinguish these groups?" — by profiling each selected
clade's BGC repertoire and reporting shared vs. clade-specific families
and classes.

## The rigor problem this module has to handle

Two clades almost never contain the same number of genomes. Comparing raw
BGC counts between a 40-genome clade and a 3-genome clade tells you mostly
about sampling effort, not biology. Every count in the response is
therefore accompanied by a per-genome rate, and the response carries an
explicit `comparable` flag plus `caveats` when the comparison rests on
thin or lopsided sampling.

Just as important, and easy to get wrong: **absence of a family from a
clade's profile is not evidence the clade lacks it.** It means no genome
*in this dataset* was found to carry it — which conflates true absence,
incomplete genome sampling, assembly gaps, and prediction sensitivity.
The API names these sets `only_in_*` rather than `absent_from_*`, and the
`caveats` list says so directly, because the difference between "these
organisms don't make this" and "we didn't find it here" is exactly the
kind of overclaim this project's epistemic-rigor principle exists to
prevent.

Nothing here computes statistical significance. Enrichment testing across
clades needs a model of phylogenetic non-independence (closely related
genomes aren't independent samples) that this module doesn't have, and
reporting a naive p-value would be worse than reporting none.
"""
from __future__ import annotations

import uuid
from collections import defaultdict

from sqlalchemy.orm import Session, selectinload

from bgcscape.models import BGC, BGCFamily, BGCFamilyMembership, FamilyKind, Genome, Taxon

# Below this many genomes, per-genome rates are too noisy to compare
# meaningfully — one unusual genome dominates the profile.
MIN_GENOMES_FOR_RATE_COMPARISON = 3


def collect_subtree_taxon_ids(session: Session, root_taxon_id: uuid.UUID) -> set[uuid.UUID]:
    """Every taxon id at or below `root_taxon_id`.

    Loads the full taxon table and walks it in memory, matching
    tree_builder.py's deliberate MVP-scale simplification (see its
    docstring) rather than a recursive CTE — same trade-off, same place to
    revisit when real dataset size demands it.
    """
    rows = session.query(Taxon.id, Taxon.parent_id).all()
    children_by_parent: dict[uuid.UUID | None, list[uuid.UUID]] = defaultdict(list)
    for taxon_id, parent_id in rows:
        children_by_parent[parent_id].append(taxon_id)

    collected: set[uuid.UUID] = set()
    stack = [root_taxon_id]
    while stack:
        current = stack.pop()
        if current in collected:
            continue
        collected.add(current)
        stack.extend(children_by_parent.get(current, []))
    return collected


class CladeProfile:
    """Everything counted for one clade. Plain class rather than a Pydantic
    model because it's an internal intermediate — the API schema
    (`CladeSummary`) is built from it in app.py.
    """

    def __init__(self, taxon: Taxon) -> None:
        self.taxon = taxon
        self.genome_count = 0
        self.bgc_count = 0
        self.bgc_class_counts: dict[str, int] = defaultdict(int)
        self.family_ids: set[uuid.UUID] = set()
        self.family_labels: dict[uuid.UUID, str] = {}
        #: Which kind of grouping each id in `family_ids` is. Two clades
        #: sharing a *sequence family* share gene content; two clades
        #: sharing a *compound group* both make a named molecule, which
        #: convergent evolution means implies nothing about sequence. Both
        #: are real comparative facts and both are reported — but pooling
        #: them into one "shared families" number states the stronger of
        #: the two claims about rows that only support the weaker one.
        self.family_kinds: dict[uuid.UUID, FamilyKind] = {}

    def ids_of_kind(self, kind: FamilyKind) -> set[uuid.UUID]:
        return {fid for fid in self.family_ids if self.family_kinds.get(fid) == kind}

    @property
    def bgcs_per_genome(self) -> float | None:
        if self.genome_count == 0:
            return None
        return self.bgc_count / self.genome_count

    def class_rate(self, bgc_class: str) -> float | None:
        if self.genome_count == 0:
            return None
        return self.bgc_class_counts.get(bgc_class, 0) / self.genome_count


def build_clade_profile(session: Session, taxon: Taxon) -> CladeProfile:
    profile = CladeProfile(taxon)
    subtree_ids = collect_subtree_taxon_ids(session, taxon.id)

    genomes = (
        session.query(Genome)
        .filter(Genome.taxon_id.in_(subtree_ids))
        .options(selectinload(Genome.bgcs).selectinload(BGC.family_memberships).selectinload(BGCFamilyMembership.family))
        .all()
    )

    profile.genome_count = len(genomes)
    for genome in genomes:
        for bgc in genome.bgcs:
            profile.bgc_count += 1
            # Hybrids are attributed to each component class, matching how
            # the frontend counts and filters them (see the frontend's
            # bgcComponentClasses) — otherwise the same BGC would be
            # counted differently in two parts of the same UI.
            for component in _component_classes(bgc):
                profile.bgc_class_counts[component] += 1
            for membership in bgc.family_memberships:
                profile.family_ids.add(membership.family_id)
                if membership.family is not None:
                    profile.family_labels[membership.family_id] = membership.family.label
                    profile.family_kinds[membership.family_id] = membership.family.kind

    return profile


def _component_classes(bgc: BGC) -> list[str]:
    if bgc.bgc_class.value == "hybrid" and bgc.subtype:
        return [part.strip().lower() for part in bgc.subtype.split("+") if part.strip()]
    return [bgc.bgc_class.value]


def compute_caveats(profiles: list[CladeProfile]) -> tuple[bool, list[str]]:
    """Whether these clades can be compared meaningfully, and why not if
    they can't. Returns `(comparable, caveats)`.

    `comparable=False` doesn't mean the response is withheld — it means the
    UI should present the numbers as descriptive rather than as evidence
    of a real biological difference.
    """
    caveats: list[str] = [
        "A family or class appearing in only one clade means no genome in *this dataset* "
        "was found to carry it elsewhere — not that the other clades lack it. Genome "
        "sampling depth, assembly completeness, and prediction sensitivity all produce "
        "the same signal as true absence.",
    ]
    comparable = True

    empty = [p for p in profiles if p.genome_count == 0]
    if empty:
        comparable = False
        caveats.append(
            "One or more selected clades contain no classified genomes in this dataset, "
            "so there is nothing to compare for them."
        )

    thin = [p for p in profiles if 0 < p.genome_count < MIN_GENOMES_FOR_RATE_COMPARISON]
    if thin:
        comparable = False
        names = ", ".join(sorted(p.taxon.name for p in thin))
        caveats.append(
            f"Fewer than {MIN_GENOMES_FOR_RATE_COMPARISON} genomes in: {names}. "
            "Per-genome rates from so few genomes are dominated by individual genomes "
            "and shouldn't be read as clade-level properties."
        )

    populated = [p for p in profiles if p.genome_count > 0]
    if len(populated) > 1:
        largest = max(p.genome_count for p in populated)
        smallest = min(p.genome_count for p in populated)
        if smallest > 0 and largest / smallest >= 10:
            caveats.append(
                f"Clade sizes differ by more than 10x ({smallest} vs {largest} genomes). "
                "Raw counts mostly reflect sampling effort at this imbalance; compare the "
                "per-genome rates instead."
            )

    caveats.append(
        "No statistical testing is performed. Closely related genomes are not independent "
        "samples, so apparent enrichment may reflect shared ancestry rather than selection."
    )

    # Two kinds of grouping share `bgc_family`, and only one of them is a
    # sequence comparison. Reporting a shared compound group without saying
    # so states "these clades carry the same clusters" on the strength of
    # "these clades both make this molecule" — which convergent evolution
    # makes a different claim entirely. Every FamilyRef carries its `kind`;
    # this says why the reader should look at it.
    shared_kinds = {
        kind for profile in profiles for kind in profile.family_kinds.values()
    }
    if FamilyKind.COMPOUND_GROUP in shared_kinds:
        caveats.append(
            "Some groupings compared here are COMPOUND GROUPS — clusters that MIBiG records "
            "as making the same named compound, with no sequences compared. Two clades sharing "
            "one make the same molecule; that is not evidence they carry similar clusters, "
            "because unrelated pathways converge on the same product. Each entry's `kind` says "
            "which it is."
        )
    if FamilyKind.SEQUENCE_FAMILY not in shared_kinds:
        caveats.append(
            "No sequence-based gene cluster families appear in these clades, so nothing here "
            "supports a claim about shared gene content. Ingest a BiG-SCAPE or BiG-FAM "
            "clustering to make that question answerable."
        )
    return comparable, caveats


def partition_families(profiles: list[CladeProfile]) -> tuple[list[uuid.UUID], dict[uuid.UUID, list[uuid.UUID]]]:
    """Split families into those shared by *every* clade, and those found
    in exactly one. Returns `(shared, only_in[taxon_id] -> family_ids)`.

    Families present in some-but-not-all clades (when comparing 3+) fall
    into neither bucket, deliberately: with three clades, "in two of
    three" is a distinct and less interpretable situation than either
    universal or unique, and quietly folding it into one of those would
    misrepresent it.

    The intersection runs over *every* profile, including clades with no
    families at all. An earlier version filtered those out first, which
    made a family look universal even when one of the compared clades
    plainly didn't have it — caught by the empty-clade and three-clade
    tests. If any clade lacks a family, that family is not shared, and a
    clade with nothing in it means nothing is shared.
    """
    if not profiles:
        return [], {}

    shared_set: set[uuid.UUID] = set.intersection(*(p.family_ids for p in profiles))

    only_in: dict[uuid.UUID, list[uuid.UUID]] = {}
    for profile in profiles:
        others: set[uuid.UUID] = set()
        for other in profiles:
            if other.taxon.id != profile.taxon.id:
                others |= other.family_ids
        only_in[profile.taxon.id] = sorted(profile.family_ids - others)

    return sorted(shared_set), only_in


def all_family_labels(
    session: Session, family_ids: set[uuid.UUID]
) -> dict[uuid.UUID, tuple[str, FamilyKind]]:
    """`(label, kind)` for each id — the kind travels with the label because
    a caller rendering one without the other has no way to tell a sequence
    family from a compound group."""
    if not family_ids:
        return {}
    rows = (
        session.query(BGCFamily.id, BGCFamily.label, BGCFamily.kind)
        .filter(BGCFamily.id.in_(family_ids))
        .all()
    )
    return {row[0]: (row[1], row[2]) for row in rows}
