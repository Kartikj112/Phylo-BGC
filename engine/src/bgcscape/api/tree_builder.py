"""Builds the aggregated taxonomy tree the visualization renders.

MVP-scale deliberate simplification: loads the whole taxonomy + genome +
BGC set into memory and aggregates counts in Python via post-order
recursion, rather than a recursive SQL CTE or materialized-path scheme.
Correct and simple at fixture/demo scale; revisit with a CTE-based
approach once real dataset size makes an in-memory build impractical —
see ARCHITECTURE.md.

Note on what "tree" means here: this renders the GTDB **taxonomic**
hierarchy (domain -> ... -> species, from Taxon.parent_id), not a
literal inferred **phylogeny** with branch lengths. Phylo-BGC's data
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
from typing import Literal

from sqlalchemy.orm import Session

from bgcscape.api.schemas import BGCSummary, GenomeSummary, TaxonTreeNode
from bgcscape.coverage import CoverageState, coverage_state, examined_genome_ids, genomes_with_bgcs
from bgcscape.models import BGC, BGCCompoundLink, BGCFamilyMembership, Compound, Genome, Taxon
from bgcscape.models.taxonomy import TaxonRank


def _load_genome_summaries(session: Session) -> dict[uuid.UUID, list[GenomeSummary]]:
    """Build every GenomeSummary in three flat column queries.

    Deliberately NOT the ORM. Loading `Genome` and `BGC` as mapped objects
    hydrates every column, and `BGC.raw_annotation` is a JSONVariant holding
    the entire original MIBiG record — so SQLAlchemy ran `json.loads` on
    ~4,200 sizeable blobs per request to build a tree that never looks at
    them. That single unused column was 41% of the build's CPU time
    (profiled: 0.34s of 0.82s in `json.decoder.raw_decode`).

    Selecting scalar columns skips both the JSON decode and the ORM
    identity-map/instrumentation overhead, and the shape of the result is
    identical.
    """
    memberships_by_bgc: dict[uuid.UUID, list[uuid.UUID]] = defaultdict(list)
    for bgc_id, family_id in session.query(
        BGCFamilyMembership.bgc_id, BGCFamilyMembership.family_id
    ):
        memberships_by_bgc[bgc_id].append(family_id)

    # Compound names per BGC, in one flat join — same reasoning as the rest
    # of this loader: no ORM objects, no `raw_annotation` decode.
    compounds_by_bgc: dict[uuid.UUID, list[str]] = defaultdict(list)
    for bgc_id, name in (
        session.query(BGCCompoundLink.bgc_id, Compound.name)
        .join(Compound, Compound.id == BGCCompoundLink.compound_id)
        .all()
    ):
        if name:
            compounds_by_bgc[bgc_id].append(name)

    bgcs_by_genome: dict[uuid.UUID, list[BGCSummary]] = defaultdict(list)
    for bgc_id, genome_id, bgc_class, subtype, mibig_accession, evidence_level in session.query(
        BGC.id, BGC.genome_id, BGC.bgc_class, BGC.subtype, BGC.mibig_accession, BGC.evidence_level
    ):
        bgcs_by_genome[genome_id].append(
            BGCSummary(
                id=bgc_id,
                bgc_class=bgc_class,
                subtype=subtype,
                mibig_accession=mibig_accession,
                evidence_level=evidence_level,
                family_ids=memberships_by_bgc.get(bgc_id, []),
                compounds=compounds_by_bgc.get(bgc_id, []),
            )
        )

    # Two set queries, not a per-genome lookup: the tree builder touches every
    # genome in the corpus, and "was this one examined?" has to stay O(1) or
    # it costs more than everything else this loader does.
    examined = examined_genome_ids(session)
    with_bgcs = genomes_with_bgcs(session)

    by_taxon: dict[uuid.UUID, list[GenomeSummary]] = defaultdict(list)
    for (
        genome_id,
        taxon_id,
        accession,
        assembly_level,
        is_mag,
        genome_size_bp,
        gc_content_pct,
        completeness_pct,
    ) in session.query(
        Genome.id,
        Genome.taxon_id,
        Genome.accession,
        Genome.assembly_level,
        Genome.is_mag,
        Genome.genome_size_bp,
        Genome.gc_content_pct,
        Genome.completeness_pct,
    ):
        if taxon_id is None:
            continue
        by_taxon[taxon_id].append(
            GenomeSummary(
                id=genome_id,
                accession=accession,
                assembly_level=assembly_level,
                is_mag=is_mag,
                genome_size_bp=genome_size_bp,
                gc_content_pct=gc_content_pct,
                completeness_pct=completeness_pct,
                bgcs=bgcs_by_genome.get(genome_id, []),
                coverage=coverage_state(genome_id, examined, with_bgcs),
            )
        )
    return by_taxon


#: Name of the eukaryote domain root, as NCBI writes it.
EUKARYOTA = "Eukaryota"

#: Which taxonomy a tree is scoped to.
#:
#: The corpus holds two: GTDB for prokaryotes and NCBI for eukaryotes. They
#: are different methodologies that disagree, so the interface serves them as
#: separate views rather than interleaving them into one hybrid tree a reader
#: would have no way to pick apart. `all` exists because the API should be
#: able to describe everything the database actually contains.
TreeScope = Literal["all", "prokaryote", "eukaryote"]


def build_taxonomy_tree(session: Session, scope: TreeScope = "all") -> TaxonTreeNode:
    taxa = session.query(Taxon.id, Taxon.parent_id, Taxon.name, Taxon.rank).all()
    genomes_by_taxon = _load_genome_summaries(session)

    children_by_parent: dict[uuid.UUID | None, list[tuple]] = defaultdict(list)
    for taxon in taxa:
        children_by_parent[taxon.parent_id].append(taxon)
    for siblings in children_by_parent.values():
        siblings.sort(key=lambda t: t.name)

    # Scoping happens at the top level only: everything below a domain root
    # belongs to that domain's taxonomy, so filtering the roots partitions the
    # whole tree. Organisms with no lineage at all (metagenomes, plasmids,
    # "uncultured X") are parent-less non-domain nodes; they belong to neither
    # taxonomy and stay with the prokaryote view, which is where the interface
    # already groups them as "Unplaced organisms".
    if scope != "all":
        roots = children_by_parent.get(None, [])
        is_euk = lambda t: t.name == EUKARYOTA and t.rank == TaxonRank.DOMAIN  # noqa: E731
        children_by_parent[None] = [
            t for t in roots if is_euk(t) == (scope == "eukaryote")
        ]

    def build_node(taxon) -> TaxonTreeNode:
        direct_genomes = genomes_by_taxon.get(taxon.id, [])
        children = [build_node(child) for child in children_by_parent.get(taxon.id, [])]

        bgc_class_counts: dict[str, int] = defaultdict(int)
        for genome_summary in direct_genomes:
            for bgc in genome_summary.bgcs:
                bgc_class_counts[bgc.bgc_class.value] += 1
        for child in children:
            for cls, count in child.bgc_class_counts.items():
                bgc_class_counts[cls] += count

        # Rolled up exactly like genome_count, so a reader comparing the two
        # at any node is comparing like with like. A clade's zero means
        # something only in proportion to how much of it was examined.
        direct_examined = sum(
            1 for g in direct_genomes if g.coverage is CoverageState.EXAMINED
        )

        return TaxonTreeNode(
            id=taxon.id,
            name=taxon.name,
            rank=taxon.rank,
            genome_count=len(direct_genomes) + sum(c.genome_count for c in children),
            examined_genome_count=direct_examined
            + sum(c.examined_genome_count for c in children),
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
        examined_genome_count=sum(n.examined_genome_count for n in top_level_nodes),
        bgc_class_counts=dict(root_bgc_counts),
        direct_genomes=[],
        children=top_level_nodes,
    )


def load_classified_bgc_rows(session: Session) -> list[tuple[uuid.UUID, uuid.UUID, str, str | None]]:
    """`(genome_id, taxon_id, bgc_class, subtype)` for every BGC on a genome
    that has a taxon.

    The shared primitive behind the heatmap and the Sankey flows. Both used
    to `selectinload(Genome.bgcs)`, which hydrates full BGC objects — and so
    paid the same `raw_annotation` JSON-decode cost as the tree builder for
    data neither of them reads. One join returning four scalar columns does
    the whole job.
    """
    return (
        session.query(Genome.id, Genome.taxon_id, BGC.bgc_class, BGC.subtype)
        .join(BGC, BGC.genome_id == Genome.id)
        .filter(Genome.taxon_id.isnot(None))
        .all()
    )


def component_classes(bgc_class, subtype: str | None) -> list[str]:
    """A hybrid's component classes; otherwise the class itself.

    An `nrps+pks` cluster is NRPS machinery AND PKS machinery, and every
    counting surface in the app agrees on that reading. Centralised so the
    heatmap, the flows and the frontend cannot drift apart — they did once.
    """
    value = bgc_class.value if hasattr(bgc_class, "value") else str(bgc_class)
    if value == "hybrid" and subtype:
        return [p.strip().lower() for p in subtype.split("+") if p.strip()]
    return [value]


def taxon_ids_in_scope(session: Session, scope: TreeScope) -> set[uuid.UUID] | None:
    """Taxon ids belonging to one taxonomy, or None for "everything".

    The heatmap and the Sankey aggregate over taxa directly rather than
    walking the tree, so scoping them needs the id set the tree would have
    contained. Without it both views silently merge the two taxonomies:
    Ascomycota (a fungal phylum, from NCBI) appears in the same phylum column
    as Actinomycetota (bacterial, from GTDB), and *Aspergillus* beside
    *Streptomyces* in the same genus column. Those ranks are not comparable —
    GTDB is rank-normalised and NCBI is not — so the merged view invites a
    comparison the data cannot support.

    Taxa with no lineage at all (metagenomes, plasmids, "uncultured X")
    belong to neither taxonomy and stay with the prokaryote scope, matching
    where the tree already groups them.
    """
    if scope == "all":
        return None

    rows = session.query(Taxon.id, Taxon.parent_id, Taxon.name, Taxon.rank).all()
    children: dict[uuid.UUID | None, list] = defaultdict(list)
    for row in rows:
        children[row.parent_id].append(row)

    euk_root = next(
        (r for r in children.get(None, []) if r.name == EUKARYOTA and r.rank == TaxonRank.DOMAIN),
        None,
    )
    eukaryote_ids: set[uuid.UUID] = set()
    if euk_root is not None:
        stack = [euk_root]
        while stack:
            node = stack.pop()
            eukaryote_ids.add(node.id)
            stack.extend(children.get(node.id, []))

    if scope == "eukaryote":
        return eukaryote_ids
    return {r.id for r in rows} - eukaryote_ids
