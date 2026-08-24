"""Builds the aggregated taxonomy tree the visualization renders.

MVP-scale deliberate simplification: loads the whole taxonomy + genome +
BGC set into memory and aggregates counts in Python via post-order
recursion, rather than a recursive SQL CTE or materialized-path scheme.
Correct and simple at fixture/demo scale; revisit with a CTE-based
approach once real dataset size makes an in-memory build impractical —
see ARCHITECTURE.md.

Note on what "tree" means here: this renders the GTDB **taxonomic**
hierarchy (domain -> ... -> species, from Taxon.parent_id), not a
literal inferred **phylogeny** with branch lengths. BGC-scape's data
model has a separate PhylogeneticTree/PhylogeneticNode pair for that
(Phase 1a), but nothing populates it yet — MAFFT/IQ-TREE orchestration is
still-future work. Taxonomy and phylogeny are highly correlated but not
identical, and presenting one as the other without saying so would cut
against this project's own epistemic-rigor principle, so the UI should
label this "taxonomic tree," not "phylogeny."
"""
from __future__ import annotations

import uuid
from collections import defaultdict

from sqlalchemy.orm import Session, selectinload

from bgcscape.api.schemas import BGCSummary, GenomeSummary, TaxonTreeNode
from bgcscape.models import BGC, Genome, Taxon


def _genome_summary(genome: Genome) -> GenomeSummary:
    return GenomeSummary(
        id=genome.id,
        accession=genome.accession,
        assembly_level=genome.assembly_level,
        is_mag=genome.is_mag,
        bgcs=[
            BGCSummary(
                id=bgc.id,
                bgc_class=bgc.bgc_class,
                subtype=bgc.subtype,
                mibig_accession=bgc.mibig_accession,
                evidence_level=bgc.evidence_level,
                family_ids=[m.family_id for m in bgc.family_memberships],
            )
            for bgc in genome.bgcs
        ],
    )


def build_taxonomy_tree(session: Session) -> TaxonTreeNode:
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

    def build_node(taxon: Taxon) -> TaxonTreeNode:
        direct_genomes = [_genome_summary(g) for g in genomes_by_taxon.get(taxon.id, [])]
        children = [build_node(child) for child in children_by_parent.get(taxon.id, [])]

        bgc_class_counts: dict[str, int] = defaultdict(int)
        for genome_summary in direct_genomes:
            for bgc in genome_summary.bgcs:
                bgc_class_counts[bgc.bgc_class.value] += 1
        for child in children:
            for cls, count in child.bgc_class_counts.items():
                bgc_class_counts[cls] += count

        return TaxonTreeNode(
            id=taxon.id,
            name=taxon.name,
            rank=taxon.rank,
            genome_count=len(direct_genomes) + sum(c.genome_count for c in children),
            bgc_class_counts=dict(bgc_class_counts),
            direct_genomes=direct_genomes,
            children=children,
        )

    top_level_nodes = [build_node(t) for t in children_by_parent.get(None, [])]

    root_bgc_counts: dict[str, int] = defaultdict(int)
    for node in top_level_nodes:
        for cls, count in node.bgc_class_counts.items():
            root_bgc_counts[cls] += count

    return TaxonTreeNode(
        id=None,
        name="root",
        rank=None,
        genome_count=sum(n.genome_count for n in top_level_nodes),
        bgc_class_counts=dict(root_bgc_counts),
        direct_genomes=[],
        children=top_level_nodes,
    )
