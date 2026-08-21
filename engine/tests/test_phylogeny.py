from __future__ import annotations

import pytest
from sqlalchemy.exc import IntegrityError

from bgcscape.models import (
    AssemblyLevel,
    EvidenceLevel,
    Genome,
    PhylogeneticNode,
    PhylogeneticTree,
)


def _make_genome(session, gtdb_source, accession: str) -> Genome:
    genome = Genome(
        accession=accession,
        assembly_level=AssemblyLevel.COMPLETE_GENOME,
        is_mag=False,
        source_id=gtdb_source.id,
        evidence_level=EvidenceLevel.OBSERVED_CURATED,
    )
    session.add(genome)
    session.flush()
    return genome


def test_small_tree_with_leaves_linked_to_genomes(session, gtdb_source):
    genome_a = _make_genome(session, gtdb_source, "GCF_TEST_TREE_A.1")
    genome_b = _make_genome(session, gtdb_source, "GCF_TEST_TREE_B.1")

    tree = PhylogeneticTree(
        name="toy 2-tip tree",
        inference_method="IQ-TREE",
        alignment_method="MAFFT",
        newick_inline="(A:0.1,B:0.2);",
        source_id=gtdb_source.id,
        evidence_level=EvidenceLevel.COMPUTED,
    )
    session.add(tree)
    session.flush()

    root = PhylogeneticNode(tree=tree, label="root", is_leaf=False)
    leaf_a = PhylogeneticNode(tree=tree, parent=root, genome=genome_a, label="A", branch_length=0.1, is_leaf=True)
    leaf_b = PhylogeneticNode(tree=tree, parent=root, genome=genome_b, label="B", branch_length=0.2, is_leaf=True)
    session.add_all([root, leaf_a, leaf_b])
    session.commit()

    assert set(root.children) == {leaf_a, leaf_b}
    assert leaf_a.genome.accession == "GCF_TEST_TREE_A.1"
    assert leaf_a.parent is root
    assert len(tree.nodes) == 3


def test_tree_requires_inline_or_storage_newick(session, gtdb_source):
    bad_tree = PhylogeneticTree(
        name="no newick source at all",
        inference_method="FastTree",
        newick_inline=None,
        newick_storage_uri=None,
        source_id=gtdb_source.id,
        evidence_level=EvidenceLevel.COMPUTED,
    )
    session.add(bad_tree)
    with pytest.raises(IntegrityError):
        session.commit()


def test_tree_accepts_storage_uri_without_inline_newick(session, gtdb_source):
    big_tree = PhylogeneticTree(
        name="large reference tree (object storage)",
        inference_method="IQ-TREE",
        marker_set="GTDB bac120",
        newick_storage_uri="s3://bgc-scape-artifacts/trees/gtdb-bac120-r11.nwk",
        source_id=gtdb_source.id,
        evidence_level=EvidenceLevel.COMPUTED,
    )
    session.add(big_tree)
    session.commit()

    assert big_tree.newick_inline is None
    assert big_tree.newick_storage_uri.startswith("s3://")
