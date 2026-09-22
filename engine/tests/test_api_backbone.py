"""The backbone endpoint: the reference taxonomy one clade at a time, with the
corpus laid over it.

The properties that matter: corpus fields mean exactly what they mean in
`/taxonomy-tree` (so nothing that reads them changes meaning), a corpus clade
the reference lacks is never dropped, and wide clades summarise their
reference-only children instead of listing thousands.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from tests.test_api import api_client  # noqa: F401  (fixture)
from bgcscape.api.backbone_tree import (
    BackboneNodeNotFound,
    BackboneUnavailable,
    backbone_status,
    build_backbone_tree,
)
from bgcscape.api.tree_builder import build_taxonomy_tree
from bgcscape.ingest.backbone import build_backbone
from bgcscape.ingest.gtdb import ingest_gtdb_metadata, read_gtdb_metadata_tsv
from bgcscape.models import AssemblyLevel, EvidenceLevel, Genome, Taxon

FIXTURES = Path(__file__).parent / "fixtures"
STREP = "d__Bacteria;p__Actinomycetota;c__Actinomycetes;o__Streptomycetales;f__Streptomycetaceae;g__Streptomyces"
BACILLUS = "d__Bacteria;p__Bacillota;c__Bacilli;o__Bacillales;f__Bacillaceae;g__Bacillus"
ARCHAEON = "d__Archaea;p__Methanobacteriota;c__Methanobacteria;o__Methanobacteriales;f__Methanobacteriaceae;g__Methanobrevibacter"


def _row(accession: str, lineage: str, representative: str) -> dict[str, str]:
    return {"accession": accession, "gtdb_taxonomy": lineage, "gtdb_genome_representative": representative}


@pytest.fixture()
def corpus_and_backbone(session, gtdb_source):
    """Corpus: the three-genome GTDB fixture (two Streptomyces species, one
    genome classified only to genus). Backbone: the same genus with one of
    those species plus three reference-only ones, and two other lineages.
    `Streptomyces fixturensis` is in the corpus but not the backbone."""
    ingest_gtdb_metadata(session, gtdb_source, read_gtdb_metadata_tsv(FIXTURES / "gtdb_metadata_test.tsv"))
    rows = [
        _row("RS_GCF_TEST900001.1", f"{STREP};s__Streptomyces testomycini", "RS_GCF_TEST900001.1"),
        _row("RS_GCF_000000010.1", f"{STREP};s__Streptomyces testomycini", "RS_GCF_TEST900001.1"),
        _row("RS_GCF_000000011.1", f"{STREP};s__Streptomyces alpha", "RS_GCF_000000011.1"),
        _row("RS_GCF_000000012.1", f"{STREP};s__Streptomyces beta", "RS_GCF_000000012.1"),
        _row("RS_GCF_000000013.1", f"{STREP};s__Streptomyces beta", "RS_GCF_000000012.1"),
        _row("RS_GCF_000000014.1", f"{STREP};s__Streptomyces gamma", "RS_GCF_000000014.1"),
        _row("RS_GCF_000000015.1", f"{BACILLUS};s__Bacillus delta", "RS_GCF_000000015.1"),
        _row("RS_GCF_000000016.1", f"{ARCHAEON};s__Methanobrevibacter eps", "RS_GCF_000000016.1"),
    ]
    build_backbone(session, gtdb_source, rows)
    return gtdb_source


def _child(node, name):
    return next(c for c in node.children if c.name == name)


def _descend(session, node, *names):
    """Walk down by name, loading each level from the endpoint."""
    for name in names:
        child = _child(node, name)
        node = build_backbone_tree(session, "prokaryote", parent=child.backbone_id) if not child.children_loaded else child
    return node


def test_status_reports_what_is_loaded(session, corpus_and_backbone):
    status = backbone_status(session, "prokaryote")
    assert status.available
    assert (status.source_name, status.source_version) == ("GTDB", "R11-RS232")
    assert status.reference_genome_count == 8
    assert status.reference_species_count == 6
    # No backbone for eukaryotes, and the reason says so.
    euk = backbone_status(session, "eukaryote")
    assert not euk.available and "bacteria and archaea only" in euk.reason


def test_status_without_a_backbone_says_how_to_build_one(session, gtdb_source):
    status = backbone_status(session, "prokaryote")
    assert not status.available
    assert "bgcscape fetch-gtdb-backbone" in status.reason
    with pytest.raises(BackboneUnavailable):
        build_backbone_tree(session, "prokaryote")


def test_root_loads_domains_and_counts_the_whole_reference(session, corpus_and_backbone):
    root = build_backbone_tree(session, "prokaryote", depth=1)
    assert {c.name for c in root.children} == {"Bacteria", "Archaea"}
    assert root.reference_genome_count == 8
    bacteria = _child(root, "Bacteria")
    # Counts cover the whole clade although nothing below it was sent.
    assert bacteria.children == [] and not bacteria.children_loaded
    assert bacteria.child_count == 2
    assert (bacteria.reference_genome_count, bacteria.genome_count) == (7, 3)
    assert _child(root, "Archaea").genome_count == 0


def test_corpus_clades_keep_their_taxon_id(session, corpus_and_backbone):
    """So comparison, search and family highlighting, all keyed by taxon id,
    keep working in the backbone view."""
    root = build_backbone_tree(session, "prokaryote", depth=2)
    bacteria = _child(root, "Bacteria")
    corpus_bacteria = session.query(Taxon).filter_by(name="Bacteria").one()
    assert bacteria.id == str(corpus_bacteria.id) == str(bacteria.corpus_taxon_id)
    bacillota = _child(bacteria, "Bacillota")
    assert bacillota.corpus_taxon_id is None
    assert bacillota.id == str(bacillota.backbone_id)


def test_genus_shows_corpus_reference_and_corpus_only_species(session, corpus_and_backbone):
    root = build_backbone_tree(session, "prokaryote", depth=2)
    genus = _descend(
        session, _child(root, "Bacteria"),
        "Actinomycetota", "Actinomycetes", "Streptomycetales", "Streptomycetaceae", "Streptomyces",
    )
    names = {c.name: c for c in genus.children}
    assert set(names) == {
        "Streptomyces testomycini",   # in both
        "Streptomyces fixturensis",   # corpus only
        "Streptomyces alpha", "Streptomyces beta", "Streptomyces gamma",  # reference only
    }
    both = names["Streptomyces testomycini"]
    assert (both.genome_count, both.reference_genome_count) == (1, 2)
    assert both.representative_accession == "GCF_TEST900001.1"
    assert [g.accession for g in both.direct_genomes] == ["GCF_TEST900001.1"]

    corpus_only = names["Streptomyces fixturensis"]
    assert corpus_only.backbone_id is None and corpus_only.children_loaded
    assert (corpus_only.genome_count, corpus_only.reference_genome_count) == (1, 0)

    reference_only = names["Streptomyces beta"]
    assert (reference_only.genome_count, reference_only.reference_genome_count) == (0, 2)
    assert reference_only.direct_genomes == []

    # The genome classified only to genus stays on the genus.
    assert [g.accession for g in genus.direct_genomes] == ["GCF_TEST900003.1"]
    assert genus.child_count == 5


def test_corpus_fields_match_the_corpus_tree(session, corpus_and_backbone):
    """Nothing that reads genome_count or bgc_class_counts may change meaning
    when the backbone is switched on."""
    root = build_backbone_tree(session, "prokaryote", depth=3)
    corpus = build_taxonomy_tree(session, "prokaryote")
    assert root.genome_count == corpus.genome_count
    assert root.bgc_class_counts == corpus.bgc_class_counts
    bb_phylum = _child(_child(root, "Bacteria"), "Actinomycetota")
    corpus_phylum = _child(_child(corpus, "Bacteria"), "Actinomycetota")
    assert bb_phylum.genome_count == corpus_phylum.genome_count
    assert bb_phylum.examined_genome_count == corpus_phylum.examined_genome_count
    assert bb_phylum.bgc_class_counts == corpus_phylum.bgc_class_counts

    def curated(node):
        own = sum(1 for g in node.direct_genomes if g.coverage.value == "curated_only")
        return own + sum(curated(c) for c in node.children)

    assert bb_phylum.curated_only_genome_count == curated(corpus_phylum)
    assert root.curated_only_genome_count == curated(corpus)


def test_curated_only_count_rolls_up_mibig_style_genomes(session, corpus_and_backbone, gtdb_source):
    """A genome with clusters and no detection run is curated-only, and an
    unloaded clade has to report it, since the client cannot count it."""
    from bgcscape.models import BGC, BGCClass

    genome = session.query(Genome).filter_by(accession="GCF_TEST900001.1").one()
    session.add(BGC(genome_id=genome.id, bgc_class=BGCClass.NRPS, source_id=gtdb_source.id,
                    evidence_level=EvidenceLevel.OBSERVED_CURATED))
    session.commit()
    bacteria = _child(build_backbone_tree(session, "prokaryote"), "Bacteria")
    assert not bacteria.children_loaded
    assert bacteria.curated_only_genome_count == 1
    assert bacteria.examined_genome_count == 0
    # One of its three corpus genomes now carries a cluster.
    assert (bacteria.genome_count, bacteria.bgc_genome_count) == (3, 1)


def test_limit_summarises_reference_only_children_but_never_corpus_ones(session, corpus_and_backbone):
    genus_id = _descend(
        session, _child(build_backbone_tree(session, "prokaryote", depth=2), "Bacteria"),
        "Actinomycetota", "Actinomycetes", "Streptomycetales", "Streptomycetaceae",
    )
    genus_id = _child(genus_id, "Streptomyces").backbone_id

    genus = build_backbone_tree(session, "prokaryote", parent=genus_id, limit=1)
    shown = {c.name for c in genus.children}
    # Both corpus species survive a limit of 1; all three reference-only go.
    assert shown == {"Streptomyces testomycini", "Streptomyces fixturensis"}
    assert genus.omitted_child_count == 3
    assert genus.omitted_reference_genome_count == 4  # alpha 1 + beta 2 + gamma 1

    # With room for one, the largest reference-only species is kept.
    genus = build_backbone_tree(session, "prokaryote", parent=genus_id, limit=3)
    assert "Streptomyces beta" in {c.name for c in genus.children}
    assert genus.omitted_child_count == 2


def test_corpus_overlay_follows_corpus_changes(session, corpus_and_backbone, gtdb_source):
    before = _child(build_backbone_tree(session, "prokaryote"), "Bacteria").genome_count
    genus = session.query(Taxon).filter_by(name="Streptomyces").one()
    session.add(
        Genome(
            accession="GCF_NEW000001.1", taxon_id=genus.id, assembly_level=AssemblyLevel.CONTIG,
            source_id=gtdb_source.id, evidence_level=EvidenceLevel.PREDICTED,
        )
    )
    session.commit()
    after = _child(build_backbone_tree(session, "prokaryote"), "Bacteria").genome_count
    assert after == before + 1


def test_bad_requests(session, corpus_and_backbone):
    with pytest.raises(ValueError):
        build_backbone_tree(session, "prokaryote", depth=0)
    with pytest.raises(ValueError):
        build_backbone_tree(session, "prokaryote", depth=4)
    with pytest.raises(ValueError):
        build_backbone_tree(session, "prokaryote", limit=0)
    import uuid

    with pytest.raises(BackboneNodeNotFound):
        build_backbone_tree(session, "prokaryote", parent=uuid.uuid4())
    with pytest.raises(BackboneUnavailable):
        build_backbone_tree(session, "eukaryote")


def test_http_without_a_backbone(api_client):  # noqa: F811
    status = api_client.get("/api/v1/backbone/status").json()
    assert status["available"] is False
    response = api_client.get("/api/v1/backbone/tree")
    assert response.status_code == 404
    assert "gtdb-backbone" in response.json()["detail"]
    assert api_client.get("/api/v1/backbone/tree?depth=9").status_code in (404, 422)


def test_a_database_without_the_backbone_tables_reports_unavailable():
    """A deployment still serving a pre-backbone database must say "no
    backbone", not answer 500 from a missing table."""
    from sqlalchemy import create_engine
    from sqlalchemy.orm import Session as OrmSession

    from bgcscape.models import Base

    engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
    tables = [t for name, t in Base.metadata.tables.items() if not name.startswith("backbone_")]
    Base.metadata.create_all(engine, tables=tables)
    with OrmSession(engine) as old_session:
        status = backbone_status(old_session, "prokaryote")
        assert not status.available
        assert "alembic upgrade head" in status.reason
        with pytest.raises(BackboneUnavailable):
            build_backbone_tree(old_session, "prokaryote")
