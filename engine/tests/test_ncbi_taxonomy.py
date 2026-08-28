"""Placing eukaryotes from NCBI Taxonomy.

GTDB is prokaryote-only, so MIBiG's fungi and plants arrive as bare species
with no lineage. These cover the shape of the fix and the two cases that
actually bit during development.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from bgcscape.api.tree_builder import build_taxonomy_tree
from bgcscape.ingest.ncbi_taxonomy import (
    CANONICAL_RANKS,
    ingest_ncbi_lineages,
    lineage_of,
    read_merged,
    read_nodes,
)
from bgcscape.models import (
    AssemblyLevel,
    EvidenceLevel,
    Genome,
    Source,
    SourceType,
    Taxon,
    TaxonRank,
)

# A miniature taxdump: Eukaryota -> Fungi -> Ascomycota -> ... -> a STRAIN,
# plus a bacterium, plus a retired taxid.
#
# The trailing "\t|\t\t|\t9\t|" on each row is not padding. Real nodes.dmp
# carries further columns after the rank, so the rank is delimited by
# "\t|\t" on BOTH sides; a fixture that stops at the rank leaves the
# separator glued to it and every lookup silently misses.
NODES = """\
1\t|\t1\t|\tno rank\t|\t\t|\t9\t|
2759\t|\t1\t|\tsuperkingdom\t|\t\t|\t9\t|
4751\t|\t2759\t|\tkingdom\t|\t\t|\t9\t|
4890\t|\t4751\t|\tphylum\t|\t\t|\t9\t|
147545\t|\t4890\t|\tclass\t|\t\t|\t9\t|
5042\t|\t147545\t|\torder\t|\t\t|\t9\t|
1131492\t|\t5042\t|\tfamily\t|\t\t|\t9\t|
5052\t|\t1131492\t|\tgenus\t|\t\t|\t9\t|
162425\t|\t5052\t|\tspecies\t|\t\t|\t9\t|
227321\t|\t162425\t|\tstrain\t|\t\t|\t9\t|
999001\t|\t5052\t|\tclade\t|\t\t|\t9\t|
2\t|\t1\t|\tsuperkingdom\t|\t\t|\t9\t|
1280\t|\t2\t|\tspecies\t|\t\t|\t9\t|
"""
NAMES = """\
2759\t|\tEukaryota\t|\t\t|\tscientific name\t|
4751\t|\tFungi\t|\t\t|\tscientific name\t|
4890\t|\tAscomycota\t|\t\t|\tscientific name\t|
147545\t|\tEurotiomycetes\t|\t\t|\tscientific name\t|
5042\t|\tEurotiales\t|\t\t|\tscientific name\t|
1131492\t|\tAspergillaceae\t|\t\t|\tscientific name\t|
5052\t|\tAspergillus\t|\t\t|\tscientific name\t|
162425\t|\tAspergillus nidulans\t|\t\t|\tscientific name\t|
162425\t|\tsome synonym\t|\t\t|\tsynonym\t|
2\t|\tBacteria\t|\t\t|\tscientific name\t|
1280\t|\tStaphylococcus aureus\t|\t\t|\tscientific name\t|
"""
MERGED = "555000\t|\t162425\t|\n"


@pytest.fixture()
def taxdump(tmp_path: Path) -> Path:
    (tmp_path / "nodes.dmp").write_text(NODES, encoding="utf-8")
    (tmp_path / "names.dmp").write_text(NAMES, encoding="utf-8")
    (tmp_path / "merged.dmp").write_text(MERGED, encoding="utf-8")
    return tmp_path


def _orphan(session, name: str, taxid: int, source: Source) -> Taxon:
    """A MIBiG-style species with no lineage above it — what GTDB leaves."""
    taxon = Taxon(
        name=name,
        rank=TaxonRank.SPECIES,
        ncbi_taxid=taxid,
        source_id=source.id,
        evidence_level=EvidenceLevel.OBSERVED_CURATED,
    )
    session.add(taxon)
    session.flush()
    genome = Genome(
        accession=f"LOCUS_{taxid}",
        taxon_id=taxon.id,
        assembly_level=AssemblyLevel.LOCUS,
        is_mag=False,
        source_id=source.id,
        evidence_level=EvidenceLevel.OBSERVED_CURATED,
    )
    session.add(genome)
    session.flush()
    return taxon


@pytest.fixture()
def sources(session):
    mibig = Source(name="MIBiG", source_type=SourceType.REFERENCE_DATABASE, version="4.0")
    ncbi = Source(name="NCBI Taxonomy", source_type=SourceType.REFERENCE_DATABASE, version="test")
    session.add_all([mibig, ncbi])
    session.flush()
    return mibig, ncbi


def test_lineage_keeps_only_canonical_ranks(taxdump):
    parent, rank = read_nodes(taxdump / "nodes.dmp")
    merged = read_merged(taxdump / "merged.dmp")
    chain = lineage_of(162425, parent, rank, merged)
    assert [r.value for _, r in chain] == [
        "domain", "kingdom", "phylum", "class", "order", "family", "genus", "species",
    ]
    # `clade` and `no rank` carry no rank a biologist would cite and would
    # triple the depth of every lineage.
    assert "clade" not in CANONICAL_RANKS


def test_retired_taxids_still_resolve(taxdump):
    """NCBI retires taxids by merging them; MIBiG entries predate merges."""
    parent, rank = read_nodes(taxdump / "nodes.dmp")
    merged = read_merged(taxdump / "merged.dmp")
    assert lineage_of(555000, parent, rank, merged) is not None


def test_eukaryote_gets_a_full_lineage(session, sources, taxdump):
    mibig, ncbi = sources
    orphan = _orphan(session, "Aspergillus nidulans", 162425, mibig)
    session.commit()

    report = ingest_ncbi_lineages(session, ncbi, taxdump)
    assert report.species_attached == 1

    names = []
    node = orphan
    while node is not None:
        names.append((node.rank.value, node.name))
        node = session.get(Taxon, node.parent_id) if node.parent_id else None
    assert names[-1] == ("domain", "Eukaryota")
    assert ("kingdom", "Fungi") in names


def test_strain_level_organisms_hang_under_their_species(session, sources, taxdump):
    """THE case that stranded 209 BGCs.

    MIBiG names organisms at strain level ("Aspergillus nidulans FGSC A4"),
    and NCBI ranks those `strain` — not a canonical rank, so the organism's
    own taxid never appears in its canonical lineage. Without a fallback its
    ancestors get built around it while it stays parent-less.
    """
    mibig, ncbi = sources
    strain = _orphan(session, "Aspergillus nidulans FGSC A4", 227321, mibig)
    session.commit()

    report = ingest_ncbi_lineages(session, ncbi, taxdump)
    assert report.strains_under_species == 1
    assert strain.parent_id is not None

    parent = session.get(Taxon, strain.parent_id)
    assert parent.name == "Aspergillus nidulans"


def test_prokaryotes_are_left_on_the_gtdb_tree(session, sources, taxdump):
    """Placing them from NCBI too would silently build a hybrid taxonomy."""
    mibig, ncbi = sources
    bacterium = _orphan(session, "Staphylococcus aureus", 1280, mibig)
    session.commit()

    report = ingest_ncbi_lineages(session, ncbi, taxdump)
    assert report.skipped_non_eukaryote == 1
    assert bacterium.parent_id is None


def test_rerun_does_not_duplicate_the_lineage(session, sources, taxdump):
    mibig, ncbi = sources
    _orphan(session, "Aspergillus nidulans", 162425, mibig)
    session.commit()

    ingest_ncbi_lineages(session, ncbi, taxdump)
    after_first = session.query(Taxon).count()
    ingest_ncbi_lineages(session, ncbi, taxdump)
    assert session.query(Taxon).count() == after_first


def test_tree_scope_separates_the_two_taxonomies(session, sources, taxdump):
    """The whole point of the separate view: neither tree is a hybrid."""
    mibig, ncbi = sources
    _orphan(session, "Aspergillus nidulans", 162425, mibig)
    bacteria = Taxon(
        name="Bacteria",
        rank=TaxonRank.DOMAIN,
        source_id=mibig.id,
        evidence_level=EvidenceLevel.OBSERVED_CURATED,
    )
    session.add(bacteria)
    session.commit()
    ingest_ncbi_lineages(session, ncbi, taxdump)

    euk = build_taxonomy_tree(session, scope="eukaryote")
    pro = build_taxonomy_tree(session, scope="prokaryote")
    every = build_taxonomy_tree(session, scope="all")

    assert [c.name for c in euk.children] == ["Eukaryota"]
    assert "Eukaryota" not in [c.name for c in pro.children]
    assert "Bacteria" in [c.name for c in pro.children]
    assert {c.name for c in every.children} >= {"Eukaryota", "Bacteria"}
