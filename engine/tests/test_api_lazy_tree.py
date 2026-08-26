"""Tests for incremental tree loading.

The property that matters most: a node's rolled-up counts must reflect
the WHOLE subtree, including descendants the client hasn't fetched. If
they only counted the returned slice, every summary glyph would understate
its clade and the feature would be actively misleading.
"""
from __future__ import annotations

import pytest

from tests.test_api import api_client  # noqa: F401  (fixture)
from bgcscape.api.lazy_tree import MAX_DEPTH, MAX_INLINE_GENOMES, LazyTreeError, build_lazy_tree
from bgcscape.models import (
    BGC,
    AssemblyLevel,
    BGCClass,
    EvidenceLevel,
    Genome,
    Source,
    SourceType,
    Taxon,
    TaxonRank,
)


@pytest.fixture()
def deep_tree(session):
    """domain > phylum > class > order > family > genus > species > genomes."""
    src = Source(name="test", source_type=SourceType.TOOL_RUN, version="1")
    session.add(src)
    session.flush()

    ranks = [
        TaxonRank.DOMAIN, TaxonRank.PHYLUM, TaxonRank.CLASS, TaxonRank.ORDER,
        TaxonRank.FAMILY, TaxonRank.GENUS, TaxonRank.SPECIES,
    ]
    parent = None
    nodes = {}
    for rank in ranks:
        taxon = Taxon(
            name=f"Test{rank.value}", rank=rank,
            parent_id=parent.id if parent else None,
            source_id=src.id, evidence_level=EvidenceLevel.OBSERVED_CURATED,
        )
        session.add(taxon)
        session.flush()
        nodes[rank.value] = taxon
        parent = taxon

    for i in range(4):
        genome = Genome(
            accession=f"GCF_DEEP{i}.1", taxon_id=parent.id,
            assembly_level=AssemblyLevel.COMPLETE_GENOME, is_mag=False,
            source_id=src.id, evidence_level=EvidenceLevel.OBSERVED_CURATED,
        )
        session.add(genome)
        session.flush()
        session.add(BGC(
            genome_id=genome.id, bgc_class=BGCClass.NRPS,
            source_id=src.id, evidence_level=EvidenceLevel.PREDICTED,
        ))
    session.commit()
    return nodes


def test_depth_limits_how_much_is_returned(session, deep_tree):
    shallow = build_lazy_tree(session, depth=2)
    deeper = build_lazy_tree(session, depth=4)

    def count(node):
        return 1 + sum(count(c) for c in node.children)

    assert count(shallow.root) < count(deeper.root)


def test_counts_include_unfetched_descendants(session, deep_tree):
    """THE critical property. At depth 1 the root has fetched no children,
    but must still report every genome and BGC beneath it — otherwise the
    summary glyphs understate their clades."""
    shallow = build_lazy_tree(session, depth=1)
    assert shallow.root.children == []
    assert shallow.root.genome_count == 4
    assert shallow.root.bgc_class_counts.get("nrps") == 4


def test_truncation_is_reported_so_the_client_can_show_expanders(session, deep_tree):
    result = build_lazy_tree(session, depth=2)
    assert result.truncated_at
    # Every truncated node genuinely has children left unfetched.
    def find(node, name):
        if node.name == name:
            return node
        for c in node.children:
            found = find(c, name)
            if found:
                return found
        return None

    for name in result.truncated_at:
        node = find(result.root, name)
        if node is not None:
            assert node.has_children
            assert node.children == []


def test_can_re_root_on_a_subtree(session, deep_tree):
    genus = deep_tree["genus"]
    result = build_lazy_tree(session, root_id=genus.id, depth=2)
    assert result.root.name == "Testgenus"
    assert result.root.genome_count == 4


def test_unknown_root_raises(session, deep_tree):
    import uuid as _uuid

    with pytest.raises(LazyTreeError, match="not found"):
        build_lazy_tree(session, root_id=_uuid.uuid4())


def test_depth_bounds_are_enforced(session, deep_tree):
    with pytest.raises(LazyTreeError):
        build_lazy_tree(session, depth=0)
    with pytest.raises(LazyTreeError):
        build_lazy_tree(session, depth=MAX_DEPTH + 1)


def test_genomes_attach_at_the_deepest_requested_level(session, deep_tree):
    deep = build_lazy_tree(session, depth=MAX_DEPTH)

    def collect(node, acc):
        acc.extend(node.direct_genomes)
        for c in node.children:
            collect(c, acc)
        return acc

    assert len(collect(deep.root, [])) == 4
    # At depth 1 nothing is deep enough to carry genomes.
    assert build_lazy_tree(session, depth=1).root.direct_genomes == []


def test_large_genome_lists_are_withheld(session, deep_tree):
    """A genus with tens of thousands of genomes has no useful genome
    list; the client gets counts and must narrow further."""
    src = session.query(Source).first()
    species = session.query(Taxon).filter_by(rank=TaxonRank.SPECIES).one()
    for i in range(MAX_INLINE_GENOMES + 5):
        session.add(Genome(
            accession=f"GCF_BULK{i}.1", taxon_id=species.id,
            assembly_level=AssemblyLevel.COMPLETE_GENOME, is_mag=False,
            source_id=src.id, evidence_level=EvidenceLevel.OBSERVED_CURATED,
        ))
    session.commit()

    result = build_lazy_tree(session, depth=MAX_DEPTH)

    def find_species(node):
        if node.rank == TaxonRank.SPECIES:
            return node
        for c in node.children:
            found = find_species(c)
            if found:
                return found
        return None

    node = find_species(result.root)
    assert node is not None
    assert node.direct_genome_count > MAX_INLINE_GENOMES
    assert node.direct_genomes == []  # withheld, but the count is still reported


def test_endpoint_validates_depth(api_client):
    assert api_client.get("/api/v1/tree", params={"depth": 0}).status_code == 422
    assert api_client.get("/api/v1/tree", params={"depth": 99}).status_code == 422


def test_endpoint_returns_a_shallow_tree(api_client):
    body = api_client.get("/api/v1/tree", params={"depth": 2}).json()
    assert body["root"]["name"] == "root"
    assert body["total_genomes"] > 0
    assert body["depth"] == 2


def test_endpoint_unknown_root_is_404(api_client):
    response = api_client.get(
        "/api/v1/tree", params={"root": "00000000-0000-0000-0000-000000000000"}
    )
    assert response.status_code == 404
