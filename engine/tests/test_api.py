"""API tests against a real (SQLite, ingested-fixture-data) database, via
FastAPI's TestClient — exercises the actual HTTP layer (routing, response
validation against the Pydantic response_model, status codes), not just
the underlying Python functions.
"""
from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from bgcscape.ingest.gtdb import ingest_gtdb_metadata, read_gtdb_metadata_tsv
from bgcscape.ingest.mibig import ingest_mibig_entries, read_mibig_entries_from_path
from bgcscape.models import Base, Source, SourceType

FIXTURES = Path(__file__).parent / "fixtures"
GTDB_TSV = FIXTURES / "gtdb_metadata_test.tsv"


@pytest.fixture()
def api_client(monkeypatch) -> Iterator[TestClient]:
    """A FastAPI TestClient wired to a fresh in-memory SQLite DB, pre-loaded
    with both fixture datasets — so API tests exercise a realistic,
    multi-source dataset (including the cross-source Taxon merge) rather
    than a hand-built single row.
    """
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        future=True,
        # :memory: SQLite is per-connection by default — without a shared
        # single connection, the seed session's data would be invisible to
        # the API's own session (a different pooled connection sees an
        # empty database). Caught by this test failing with "no such
        # table" the first time it ran.
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    session_local = sessionmaker(bind=engine, future=True)

    with Session(engine, future=True) as seed_session:
        mibig_source = Source(name="MIBiG", source_type=SourceType.REFERENCE_DATABASE, version="4.0")
        gtdb_source = Source(name="GTDB", source_type=SourceType.REFERENCE_DATABASE, version="R11-RS232")
        seed_session.add_all([mibig_source, gtdb_source])
        seed_session.commit()

        ingest_gtdb_metadata(seed_session, gtdb_source, read_gtdb_metadata_tsv(GTDB_TSV))
        ingest_mibig_entries(seed_session, mibig_source, read_mibig_entries_from_path(FIXTURES))

    # Patch the API's session factory to use this exact engine, rather than
    # whatever BGCSCAPE_DATABASE_URL happens to be set to.
    import bgcscape.api.app as api_app_module

    monkeypatch.setattr(api_app_module, "get_sessionmaker", lambda: session_local)

    with TestClient(api_app_module.app) as client:
        yield client


def test_health(api_client):
    response = api_client.get("/api/v1/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_taxonomy_tree_root_shape(api_client):
    response = api_client.get("/api/v1/taxonomy-tree")
    assert response.status_code == 200
    root = response.json()

    assert root["id"] is None
    assert root["rank"] is None
    assert root["genome_count"] == 5  # 3 GTDB genomes + 2 MIBiG locus stubs
    assert len(root["children"]) == 1  # single Bacteria domain in the fixtures

    domain = root["children"][0]
    assert domain["name"] == "Bacteria"
    assert domain["rank"] == "domain"
    assert domain["genome_count"] == 5


def test_taxonomy_tree_bgc_class_counts_aggregate_up(api_client):
    response = api_client.get("/api/v1/taxonomy-tree")
    root = response.json()

    # 2 active MIBiG entries: one NRPS, one NRPS+PKS hybrid.
    assert root["bgc_class_counts"].get("nrps") == 1
    assert root["bgc_class_counts"].get("hybrid") == 1


def test_taxonomy_tree_reaches_species_with_direct_genomes(api_client):
    response = api_client.get("/api/v1/taxonomy-tree")
    root = response.json()

    def find_species(node, name):
        if node.get("rank") == "species" and node["name"] == name:
            return node
        for child in node["children"]:
            found = find_species(child, name)
            if found:
                return found
        return None

    species = find_species(root, "Streptomyces testomycini")
    assert species is not None
    # This species has both a GTDB whole-genome accession AND the two MIBiG
    # locus stubs attached (cross-source merge from Chunk 2) -> 3 genomes.
    assert len(species["direct_genomes"]) == 3


def test_bgc_classes_endpoint(api_client):
    response = api_client.get("/api/v1/bgc-classes")
    assert response.status_code == 200
    assert set(response.json()) == {"nrps", "hybrid"}


def test_genome_detail_not_found(api_client):
    response = api_client.get("/api/v1/genomes/00000000-0000-0000-0000-000000000000")
    assert response.status_code == 404


def test_genome_detail_found(api_client):
    tree = api_client.get("/api/v1/taxonomy-tree").json()

    def first_genome_id(node):
        if node["direct_genomes"]:
            return node["direct_genomes"][0]["id"]
        for child in node["children"]:
            found = first_genome_id(child)
            if found:
                return found
        return None

    genome_id = first_genome_id(tree)
    assert genome_id is not None

    response = api_client.get(f"/api/v1/genomes/{genome_id}")
    assert response.status_code == 200
    body = response.json()
    assert body["id"] == genome_id
    assert "accession" in body


def test_bgc_detail_includes_compounds(api_client):
    classes = api_client.get("/api/v1/bgc-classes").json()
    assert classes  # sanity: fixtures produced at least one BGC

    tree = api_client.get("/api/v1/taxonomy-tree").json()

    def first_bgc_id(node):
        for g in node["direct_genomes"]:
            if g["bgcs"]:
                return g["bgcs"][0]["id"]
        for child in node["children"]:
            found = first_bgc_id(child)
            if found:
                return found
        return None

    bgc_id = first_bgc_id(tree)
    assert bgc_id is not None

    response = api_client.get(f"/api/v1/bgcs/{bgc_id}")
    assert response.status_code == 200
    body = response.json()
    assert body["id"] == bgc_id
    assert isinstance(body["compounds"], list)
    assert len(body["compounds"]) >= 1


def test_search_by_organism_name(api_client):
    response = api_client.get("/api/v1/search", params={"q": "testomycini"})
    assert response.status_code == 200
    results = response.json()
    assert any(r["kind"] == "taxon" and "testomycini" in r["label"] for r in results)


def test_search_by_genome_accession(api_client):
    response = api_client.get("/api/v1/search", params={"q": "GCF_TEST900001"})
    assert response.status_code == 200
    results = response.json()
    assert any(r["kind"] == "genome" for r in results)


def test_search_short_query_returns_empty(api_client):
    response = api_client.get("/api/v1/search", params={"q": "a"})
    assert response.status_code == 200
    assert response.json() == []
