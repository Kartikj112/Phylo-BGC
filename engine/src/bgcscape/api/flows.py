"""Taxonomy -> BGC class flow, for the Sankey view.

A Sankey diagram requires **conserved flow**: what enters a node must
equal what leaves it, or the widths lie. That's why this is a separate
view rather than ribbons drawn onto the phylogeny — branch width on a
tree already encodes ancestry, and a second width channel there would
fight it.

The flow modeled here genuinely is conserved: every BGC belongs to
exactly one genome, which sits in exactly one genus, under exactly one
phylum. Partitioning `phylum -> genus -> BGC class` counts each BGC once
at every level.

One deliberate exception, and it's the interesting one: a **hybrid** BGC
is counted under *each* of its component classes at the final stage, so
an NRPS+PKS cluster contributes to both. That breaks strict conservation
in the last column only. The alternative — a separate "hybrid" sink —
would be conserved but would hide the fact that hybrid clusters *are*
NRPS and PKS machinery, which is the biologically meaningful reading, and
would also disagree with how the filter rail and clade comparison count
them. Consistency across views was judged more valuable here than a
formal invariant, and `hybrid_double_counted` is returned so the UI can
say so rather than let a reader infer conservation that isn't there.
"""
from __future__ import annotations

from collections import defaultdict

from sqlalchemy.orm import Session, selectinload

from bgcscape.models import BGC, Genome, Taxon, TaxonRank


def _component_classes(bgc: BGC) -> list[str]:
    if bgc.bgc_class.value == "hybrid" and bgc.subtype:
        return [p.strip().lower() for p in bgc.subtype.split("+") if p.strip()]
    return [bgc.bgc_class.value]


def build_taxonomy_class_flow(session: Session, max_nodes_per_stage: int = 12) -> dict:
    """Build `phylum -> genus -> BGC class` flows.

    Stages beyond `max_nodes_per_stage` are collapsed into an explicit
    "other" bucket rather than dropped — silently omitting flow would make
    the widths wrong, which is precisely the failure a Sankey must avoid.
    """
    taxa = {t.id: t for t in session.query(Taxon).all()}
    genomes = (
        session.query(Genome).options(selectinload(Genome.bgcs)).filter(Genome.taxon_id.isnot(None)).all()
    )

    def ancestor_at(taxon_id, rank: TaxonRank) -> Taxon | None:
        current = taxa.get(taxon_id)
        while current is not None:
            if current.rank == rank:
                return current
            current = taxa.get(current.parent_id) if current.parent_id else None
        return None

    phylum_genus: dict[tuple[str, str], int] = defaultdict(int)
    genus_class: dict[tuple[str, str], int] = defaultdict(int)
    phylum_totals: dict[str, int] = defaultdict(int)
    genus_totals: dict[str, int] = defaultdict(int)
    hybrid_double_counted = 0
    unclassified = 0

    for genome in genomes:
        phylum = ancestor_at(genome.taxon_id, TaxonRank.PHYLUM)
        genus = ancestor_at(genome.taxon_id, TaxonRank.GENUS)
        if phylum is None or genus is None:
            unclassified += len(genome.bgcs)
            continue
        for bgc in genome.bgcs:
            phylum_genus[(phylum.name, genus.name)] += 1
            phylum_totals[phylum.name] += 1
            genus_totals[genus.name] += 1
            classes = _component_classes(bgc)
            if len(classes) > 1:
                hybrid_double_counted += 1
            for cls in classes:
                genus_class[(genus.name, cls)] += 1

    def keep(totals: dict[str, int]) -> set[str]:
        ranked = sorted(totals.items(), key=lambda kv: -kv[1])
        return {name for name, _ in ranked[:max_nodes_per_stage]}

    kept_phyla = keep(phylum_totals)
    kept_genera = keep(genus_totals)

    def bucket(name: str, kept: set[str]) -> str:
        return name if name in kept else "other"

    links: dict[tuple[str, str], int] = defaultdict(int)
    for (phylum, genus), value in phylum_genus.items():
        links[(f"p:{bucket(phylum, kept_phyla)}", f"g:{bucket(genus, kept_genera)}")] += value
    for (genus, cls), value in genus_class.items():
        links[(f"g:{bucket(genus, kept_genera)}", f"c:{cls}")] += value

    node_names: list[str] = []
    for key in links:
        for endpoint in key:
            if endpoint not in node_names:
                node_names.append(endpoint)

    def label(node_id: str) -> str:
        return node_id.split(":", 1)[1]

    def stage(node_id: str) -> str:
        return {"p": "phylum", "g": "genus", "c": "bgc_class"}[node_id.split(":", 1)[0]]

    return {
        "nodes": [{"id": n, "label": label(n), "stage": stage(n)} for n in node_names],
        "links": [
            {"source": s, "target": t, "value": v} for (s, t), v in sorted(links.items(), key=lambda kv: -kv[1])
        ],
        "hybrid_double_counted": hybrid_double_counted,
        "unclassified_bgcs": unclassified,
        "total_bgcs": session.query(BGC).count(),
    }
