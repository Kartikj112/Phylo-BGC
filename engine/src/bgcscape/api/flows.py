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

from sqlalchemy.orm import Session

from bgcscape.api.tree_builder import component_classes, load_classified_bgc_rows
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
    # Scalar columns only — the ORM load here decoded every BGC's
    # `raw_annotation` blob to build a diagram of integer flow widths.
    taxa = {
        tid: (parent_id, name, rank)
        for tid, parent_id, name, rank in session.query(
            Taxon.id, Taxon.parent_id, Taxon.name, Taxon.rank
        )
    }

    _ancestor_cache: dict[tuple, tuple | None] = {}

    def ancestor_at(taxon_id, rank: TaxonRank):
        """Nearest ancestor at `rank`, memoised per (taxon, rank).

        Genomes in one clade share nearly all of their ancestor walk, so
        without the cache this climbed the same chain once per genome.
        """
        key = (taxon_id, rank)
        if key in _ancestor_cache:
            return _ancestor_cache[key]
        chain = []
        current = taxon_id
        found = None
        seen: set = set()
        while current is not None and current in taxa and current not in seen:
            seen.add(current)
            chain.append(current)
            parent_id, name, node_rank = taxa[current]
            if node_rank == rank:
                found = (current, name)
                break
            current = parent_id
        for node in chain:
            _ancestor_cache[(node, rank)] = found
        return found

    phylum_genus: dict[tuple[str, str], int] = defaultdict(int)
    genus_class: dict[tuple[str, str], int] = defaultdict(int)
    phylum_totals: dict[str, int] = defaultdict(int)
    genus_totals: dict[str, int] = defaultdict(int)
    hybrid_double_counted = 0
    unclassified = 0

    for _genome_id, taxon_id, bgc_class, subtype in load_classified_bgc_rows(session):
        phylum = ancestor_at(taxon_id, TaxonRank.PHYLUM)
        genus = ancestor_at(taxon_id, TaxonRank.GENUS)
        if phylum is None or genus is None:
            unclassified += 1
            continue
        phylum_genus[(phylum[1], genus[1])] += 1
        phylum_totals[phylum[1]] += 1
        genus_totals[genus[1]] += 1
        classes = component_classes(bgc_class, subtype)
        if len(classes) > 1:
            # The EXCESS link units this cluster contributes, not the
            # number of clusters. A three-way hybrid emits three links
            # where a simple cluster emits one, so it inflates the final
            # column by two, not one. Counting clusters here made the
            # reported figure under-report by exactly the number of
            # 3-way hybrids (16 on the real corpus), leaving a reader who
            # tried to reconcile 2,271 against 1,913 with an unexplained
            # gap — which is the opposite of what this field is for.
            hybrid_double_counted += len(classes) - 1
        for cls in classes:
            genus_class[(genus[1], cls)] += 1

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
