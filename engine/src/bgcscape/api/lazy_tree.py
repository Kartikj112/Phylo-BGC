"""Incremental tree loading.

The eager `/taxonomy-tree` endpoint builds the entire hierarchy in memory
and ships it in one response. That was a deliberate MVP simplification
(see tree_builder.py) and it held up to ~2,500 BGCs at 959 KB. It will not
hold up to a real GTDB release: ~600,000 genomes would be a payload no
browser should be asked to parse, for a tree no human can read anyway.

This module serves one level at a time. The client fetches the root and
its immediate children, renders that, and requests deeper subtrees only
where the user actually expands. Combined with the collapsed-clade summary
glyphs, a level *is* a useful view rather than a loading state — each node
carries its rolled-up genome and BGC-class counts whether or not its
children have been fetched.

## Why genomes are not always included

A genus with 40,000 genomes has no useful genome list. Genomes attach to
any rendered node that has them, but only when the count is below
`MAX_INLINE_GENOMES` — otherwise the client gets counts and must narrow
further. This is the same judgement the UI makes visually with summary
glyphs, enforced at the API so an over-eager client can't defeat it.

Note that `depth` governs *taxon* recursion only. Genomes are leaves, and
gating them on depth as well meant a shallow request returned none at all
whenever the taxonomy placed genomes deeper than the requested level.

## Counts still come from a full aggregation pass

Rolled-up counts are computed over the whole taxonomy, not just the
returned slice, because a node's genome count is only meaningful if it
includes descendants the client hasn't fetched. That pass is currently
in-memory like tree_builder's; making it a recursive SQL CTE is the
obvious next optimisation, and is deliberately not bundled here so the
API-shape change can be evaluated on its own.
"""
from __future__ import annotations

import uuid
from collections import defaultdict

from sqlalchemy.orm import Session, selectinload

from bgcscape.api.schemas import BGCSummary, GenomeSummary, LazyTaxonNode, LazyTreeResponse
from bgcscape.models import BGC, Genome, Taxon

MAX_INLINE_GENOMES = 300
# GTDB is seven ranks (domain..species) and the synthetic root sits above
# them, so reaching species from the root needs 8. A lower cap silently
# made the deepest level unreachable — caught by a test asking for
# genomes at MAX_DEPTH and getting none, because recursion stopped at
# family. Not raised further: the point of this endpoint is to avoid
# shipping the whole tree, and an unbounded depth would defeat it.
MAX_DEPTH = 8


class LazyTreeError(ValueError):
    pass


def _genome_summary(genome: Genome) -> GenomeSummary:
    return GenomeSummary(
        id=genome.id,
        accession=genome.accession,
        assembly_level=genome.assembly_level,
        is_mag=genome.is_mag,
        genome_size_bp=genome.genome_size_bp,
        gc_content_pct=genome.gc_content_pct,
        completeness_pct=genome.completeness_pct,
        bgcs=[
            BGCSummary(
                id=b.id,
                bgc_class=b.bgc_class,
                subtype=b.subtype,
                mibig_accession=b.mibig_accession,
                evidence_level=b.evidence_level,
                family_ids=[m.family_id for m in b.family_memberships],
            )
            for b in genome.bgcs
        ],
    )


def build_lazy_tree(
    session: Session,
    root_id: uuid.UUID | None = None,
    depth: int = 2,
) -> LazyTreeResponse:
    if depth < 1 or depth > MAX_DEPTH:
        raise LazyTreeError(f"depth must be between 1 and {MAX_DEPTH}")

    taxa = session.query(Taxon).all()
    genomes = (
        session.query(Genome)
        .options(selectinload(Genome.bgcs).selectinload(BGC.family_memberships))
        .all()
    )

    children_by_parent: dict[uuid.UUID | None, list[Taxon]] = defaultdict(list)
    for taxon in taxa:
        children_by_parent[taxon.parent_id].append(taxon)
    for siblings in children_by_parent.values():
        siblings.sort(key=lambda t: t.name)

    genomes_by_taxon: dict[uuid.UUID, list[Genome]] = defaultdict(list)
    for genome in genomes:
        if genome.taxon_id is not None:
            genomes_by_taxon[genome.taxon_id].append(genome)

    # Full rollup first: a node's counts must include descendants the
    # client hasn't fetched, or the summary glyphs lie.
    rolled_genomes: dict[uuid.UUID, int] = {}
    rolled_classes: dict[uuid.UUID, dict[str, int]] = {}

    def rollup(taxon: Taxon) -> tuple[int, dict[str, int]]:
        if taxon.id in rolled_genomes:
            return rolled_genomes[taxon.id], rolled_classes[taxon.id]
        own = genomes_by_taxon.get(taxon.id, [])
        counts: dict[str, int] = defaultdict(int)
        for genome in own:
            for bgc in genome.bgcs:
                for component in _component_classes(bgc):
                    counts[component] += 1
        total = len(own)
        for child in children_by_parent.get(taxon.id, []):
            child_total, child_counts = rollup(child)
            total += child_total
            for cls, n in child_counts.items():
                counts[cls] += n
        rolled_genomes[taxon.id] = total
        rolled_classes[taxon.id] = dict(counts)
        return total, dict(counts)

    for taxon in children_by_parent.get(None, []):
        rollup(taxon)

    truncated: list[str] = []

    def build(taxon: Taxon, remaining: int) -> LazyTaxonNode:
        child_taxa = children_by_parent.get(taxon.id, [])
        own_genomes = genomes_by_taxon.get(taxon.id, [])
        total, counts = rollup(taxon)
        at_leaf_level = remaining <= 1

        children: list[LazyTaxonNode] = []
        if not at_leaf_level:
            children = [build(c, remaining - 1) for c in child_taxa]
        elif child_taxa:
            truncated.append(taxon.name)

        # Genomes attach wherever a rendered node has them, not only at
        # the deepest requested level. Depth governs *taxon* recursion;
        # genomes are leaves, so gating them on depth too meant a shallow
        # request returned none at all when the taxonomy put genomes
        # deeper than the requested level — which a test caught.
        # The size cap is what bounds the payload here.
        include_genomes = len(own_genomes) <= MAX_INLINE_GENOMES
        return LazyTaxonNode(
            id=taxon.id,
            name=taxon.name,
            rank=taxon.rank,
            genome_count=total,
            bgc_class_counts=counts,
            has_children=bool(child_taxa) or bool(own_genomes),
            child_taxon_count=len(child_taxa),
            direct_genome_count=len(own_genomes),
            children=children,
            direct_genomes=[_genome_summary(g) for g in own_genomes] if include_genomes else [],
        )

    if root_id is not None:
        target = next((t for t in taxa if t.id == root_id), None)
        if target is None:
            raise LazyTreeError(f"Taxon {root_id} not found")
        root_node = build(target, depth)
    else:
        top_level = children_by_parent.get(None, [])
        root_children = [build(t, depth - 1) for t in top_level] if depth > 1 else []
        if depth <= 1 and top_level:
            truncated.append("root")
        root_counts: dict[str, int] = defaultdict(int)
        for taxon in top_level:
            _, counts = rollup(taxon)
            for cls, n in counts.items():
                root_counts[cls] += n
        root_node = LazyTaxonNode(
            id=None,
            name="root",
            rank=None,
            genome_count=sum(rolled_genomes.get(t.id, 0) for t in top_level),
            bgc_class_counts=dict(root_counts),
            has_children=bool(top_level),
            child_taxon_count=len(top_level),
            direct_genome_count=0,
            children=root_children,
            direct_genomes=[],
        )

    return LazyTreeResponse(
        root=root_node,
        depth=depth,
        truncated_at=sorted(set(truncated)),
        total_genomes=session.query(Genome).count(),
        total_bgcs=session.query(BGC).count(),
    )


def _component_classes(bgc: BGC) -> list[str]:
    if bgc.bgc_class.value == "hybrid" and bgc.subtype:
        return [p.strip().lower() for p in bgc.subtype.split("+") if p.strip()]
    return [bgc.bgc_class.value]
