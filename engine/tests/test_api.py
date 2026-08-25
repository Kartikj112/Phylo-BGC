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

from bgcscape.ingest.antismash import ingest_antismash_result, read_antismash_result
from bgcscape.ingest.bigscape import ingest_bigscape_clustering, read_bigscape_clustering_tsv
from bgcscape.ingest.gtdb import ingest_gtdb_metadata, read_gtdb_metadata_tsv
from bgcscape.ingest.mibig import ingest_mibig_entries, read_mibig_entries_from_path
from bgcscape.models import Base, Source, SourceType

FIXTURES = Path(__file__).parent / "fixtures"
MIBIG_FIXTURES = FIXTURES / "mibig"
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
        antismash_source = Source(name="antiSMASH", source_type=SourceType.TOOL_RUN, version="7.1.0")
        bigscape_source = Source(name="BiG-SCAPE", source_type=SourceType.TOOL_RUN, version="2.0.0")
        seed_session.add_all([mibig_source, gtdb_source, antismash_source, bigscape_source])
        seed_session.commit()

        # Full four-source pipeline, in the order a real deployment would
        # run it — so API tests exercise a realistic dataset including the
        # cross-source Taxon merge and the antiSMASH→BiG-SCAPE family join,
        # not a hand-built single row.
        ingest_gtdb_metadata(seed_session, gtdb_source, read_gtdb_metadata_tsv(GTDB_TSV))
        ingest_mibig_entries(seed_session, mibig_source, read_mibig_entries_from_path(MIBIG_FIXTURES))
        ingest_antismash_result(
            seed_session,
            antismash_source,
            read_antismash_result(FIXTURES / "antismash_test_result.json"),
            genome_accession="GCF_TEST900001.1",
        )
        ingest_bigscape_clustering(
            seed_session,
            bigscape_source,
            read_bigscape_clustering_tsv(FIXTURES / "mix_clustering_c0.3.tsv"),
            cutoff=0.3,
            clustering_method="BiG-SCAPE 2.0.0",
        )

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

    # 2 active MIBiG entries (one NRPS, one NRPS+PKS hybrid) plus the 3
    # antiSMASH regions (NRPS, NRPS+PKS hybrid, terpene).
    assert root["bgc_class_counts"].get("nrps") == 2
    assert root["bgc_class_counts"].get("hybrid") == 2
    assert root["bgc_class_counts"].get("terpene") == 1


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
    # MIBiG contributes nrps + hybrid; antiSMASH adds terpene.
    assert set(response.json()) == {"nrps", "hybrid", "terpene"}


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
    """A MIBiG-derived BGC should carry its curated compound links.

    Deliberately selects a BGC *with* a mibig_accession rather than just
    taking the first one found: now that antiSMASH-predicted regions are
    in the fixture dataset too, "the first BGC in the tree" is no longer
    guaranteed to be one that has compounds — antiSMASH output carries no
    compound information at all. The original version of this test passed
    only by accident of ordering.
    """
    tree = api_client.get("/api/v1/taxonomy-tree").json()

    def first_mibig_bgc_id(node):
        for g in node["direct_genomes"]:
            for b in g["bgcs"]:
                if b["mibig_accession"]:
                    return b["id"]
        for child in node["children"]:
            found = first_mibig_bgc_id(child)
            if found:
                return found
        return None

    bgc_id = first_mibig_bgc_id(tree)
    assert bgc_id is not None

    response = api_client.get(f"/api/v1/bgcs/{bgc_id}")
    assert response.status_code == 200
    body = response.json()
    assert body["id"] == bgc_id
    assert len(body["compounds"]) >= 1


def test_antismash_bgc_detail_has_no_compounds(api_client):
    """The complementary case: antiSMASH predicts cluster boundaries and
    class, but says nothing about products. An antiSMASH-derived BGC
    should report an empty compound list rather than anything invented."""
    families = api_client.get("/api/v1/families").json()
    family_detail = api_client.get(f"/api/v1/families/{families[0]['id']}").json()
    bgc_id = family_detail["members"][0]["bgc_id"]

    body = api_client.get(f"/api/v1/bgcs/{bgc_id}").json()
    assert body["evidence_level"] == "predicted"
    assert body["compounds"] == []


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


# --- BGC family endpoints (Phase 3) ----------------------------------------------


def test_list_families(api_client):
    response = api_client.get("/api/v1/families")
    assert response.status_code == 200
    families = response.json()

    # The BiG-SCAPE fixture defines FAM_00001 (2 members) and FAM_00002 (1).
    assert len(families) == 2
    labels = [f["label"] for f in families]
    assert labels == ["FAM_00001", "FAM_00002"]  # sorted most-members-first
    assert families[0]["member_count"] == 2
    assert families[1]["member_count"] == 1
    assert families[0]["clustering_cutoff"] == 0.3
    assert families[0]["evidence_level"] == "computed"


def test_family_summary_rolls_up_classes_and_taxa(api_client):
    families = api_client.get("/api/v1/families").json()
    fam1 = next(f for f in families if f["label"] == "FAM_00001")

    # FAM_00001 holds an nrps region and a hybrid region.
    assert set(fam1["bgc_classes"]) == {"nrps", "hybrid"}
    # Both are on GCF_TEST900001.1, which GTDB classified as this species.
    assert fam1["taxon_names"] == ["Streptomyces testomycini"]


def test_family_detail_lists_members_with_genome_and_taxon(api_client):
    families = api_client.get("/api/v1/families").json()
    fam1_id = next(f["id"] for f in families if f["label"] == "FAM_00001")

    response = api_client.get(f"/api/v1/families/{fam1_id}")
    assert response.status_code == 200
    detail = response.json()

    assert detail["label"] == "FAM_00001"
    assert len(detail["members"]) == 2
    for member in detail["members"]:
        assert member["genome_accession"] == "GCF_TEST900001.1"
        assert member["taxon_name"] == "Streptomyces testomycini"
        assert member["evidence_level"] == "predicted"  # antiSMASH-derived
    assert {m["bgc_class"] for m in detail["members"]} == {"nrps", "hybrid"}


def test_family_detail_not_found(api_client):
    response = api_client.get("/api/v1/families/00000000-0000-0000-0000-000000000000")
    assert response.status_code == 404


def test_tree_bgc_summaries_carry_family_ids(api_client):
    tree = api_client.get("/api/v1/taxonomy-tree").json()
    families = api_client.get("/api/v1/families").json()
    known_family_ids = {f["id"] for f in families}

    found_with_family = []

    def walk(node):
        for genome in node["direct_genomes"]:
            for bgc in genome["bgcs"]:
                if bgc["family_ids"]:
                    found_with_family.append(bgc)
        for child in node["children"]:
            walk(child)

    walk(tree)

    # The 3 antiSMASH regions are family members; the 2 MIBiG BGCs aren't.
    assert len(found_with_family) == 3
    for bgc in found_with_family:
        assert set(bgc["family_ids"]) <= known_family_ids


def test_mibig_bgcs_have_no_family_ids(api_client):
    """MIBiG-derived BGCs have no antiSMASH region filename, so BiG-SCAPE
    ingestion can't match them — they should carry an empty family list,
    not be silently attached to something."""
    tree = api_client.get("/api/v1/taxonomy-tree").json()

    mibig_bgcs = []

    def walk(node):
        for genome in node["direct_genomes"]:
            for bgc in genome["bgcs"]:
                if bgc["mibig_accession"]:
                    mibig_bgcs.append(bgc)
        for child in node["children"]:
            walk(child)

    walk(tree)
    assert len(mibig_bgcs) == 2
    assert all(b["family_ids"] == [] for b in mibig_bgcs)


# --- provenance + export endpoints (Phase 4) ------------------------------------


def test_provenance_endpoint_reports_real_database_state(api_client):
    body = api_client.get("/api/v1/provenance").json()

    names = {s["name"] for s in body["sources"]}
    assert names == {"MIBiG", "GTDB", "antiSMASH", "BiG-SCAPE"}
    assert body["genome_count"] == 5
    assert body["bgc_count"] == 5  # 2 MIBiG + 3 antiSMASH
    assert body["family_count"] == 2
    assert body["engine_version"]

    gtdb = next(s for s in body["sources"] if s["name"] == "GTDB")
    assert gtdb["version"] == "R11-RS232"


def _view_config_from_provenance(api_client, **tree_state):
    prov = api_client.get("/api/v1/provenance").json()
    return {
        "config_version": 1,
        "view_type": "taxonomy_tree",
        "title": "Test figure",
        "tree_state": {
            "collapsed_node_ids": [],
            "active_bgc_classes": [],
            "selected_family_id": None,
            "comparison_taxon_ids": [],
            "search_query": "",
            **tree_state,
        },
        "dataset": {
            "sources": [
                {"name": s["name"], "version": s["version"], "source_type": s["source_type"], "license": s["license"]}
                for s in prov["sources"]
            ],
            "genome_count": prov["genome_count"],
            "bgc_count": prov["bgc_count"],
            "taxon_count": prov["taxon_count"],
            "family_count": prov["family_count"],
            "engine_version": prov["engine_version"],
        },
    }


_EXPORT_SVG = (
    '<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="300" viewBox="0 0 900 300">'
    '<g><text x="10" y="20" font-size="12">Streptomyces</text></g></svg>'
)


def test_export_endpoint_returns_a_pdf(api_client):
    payload = {
        "svg": _EXPORT_SVG,
        "view_config": _view_config_from_provenance(api_client, active_bgc_classes=["nrps"]),
        "format": "pdf",
    }
    response = api_client.post("/api/v1/export", json=payload)

    assert response.status_code == 200
    assert response.headers["content-type"] == "application/pdf"
    assert "attachment" in response.headers["content-disposition"]
    assert response.content.startswith(b"%PDF")


def test_export_endpoint_returns_svg_with_recoverable_config(api_client):
    from bgcscape.export import extract_view_config

    payload = {
        "svg": _EXPORT_SVG,
        "view_config": _view_config_from_provenance(api_client, search_query="Strepto"),
        "format": "svg",
    }
    response = api_client.post("/api/v1/export", json=payload)

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("image/svg+xml")

    recovered = extract_view_config(response.text)
    assert recovered is not None
    assert recovered.tree_state.search_query == "Strepto"
    # The round trip preserves the real dataset provenance, which is the
    # whole point of the exercise.
    assert recovered.dataset.genome_count == 5
    assert {s.name for s in recovered.dataset.sources} == {"MIBiG", "GTDB", "antiSMASH", "BiG-SCAPE"}


def test_export_rejects_a_config_from_a_newer_version(api_client):
    config = _view_config_from_provenance(api_client)
    config["config_version"] = 999
    response = api_client.post("/api/v1/export", json={"svg": _EXPORT_SVG, "view_config": config})

    assert response.status_code == 422
    assert "newer BGC-scape" in response.json()["detail"]


def test_export_rejects_a_config_without_provenance(api_client):
    response = api_client.post(
        "/api/v1/export",
        json={"svg": _EXPORT_SVG, "view_config": {"config_version": 1, "title": "No dataset"}},
    )
    assert response.status_code == 422


def test_export_rejects_non_svg_input(api_client):
    payload = {
        "svg": "<html>definitely not an svg</html>",
        "view_config": _view_config_from_provenance(api_client),
    }
    response = api_client.post("/api/v1/export", json=payload)
    assert response.status_code == 422


# --- prioritization endpoint (Phase 5) -------------------------------------------


def test_prioritization_endpoint_returns_ranked_candidates(api_client):
    body = api_client.get("/api/v1/prioritization", params={"limit": 10}).json()

    assert body["corpus_bgc_count"] == 5
    assert body["mibig_reference_present"] is True
    assert len(body["results"]) > 0

    scored = [r["score"] for r in body["results"] if r["score"] is not None]
    assert scored == sorted(scored, reverse=True)


def test_prioritization_always_returns_the_framing_caveats(api_client):
    """A client rendering `score` without these is misusing the endpoint,
    so they are part of the contract rather than optional garnish."""
    body = api_client.get("/api/v1/prioritization").json()
    joined = " ".join(body["caveats"]).lower()
    assert "does not indicate a novel compound" in joined
    assert "not a measurement" in joined
    assert "not a validated model" in joined


def test_prioritization_exposes_every_component_with_availability(api_client):
    body = api_client.get("/api/v1/prioritization").json()
    first = body["results"][0]

    assert len(first["components"]) == 5
    for component in first["components"]:
        assert "explanation" in component and component["explanation"]
        # An unavailable component must carry a null value, never a
        # number that could be mistaken for a real low/high score.
        if not component["available"]:
            assert component["value"] is None
            assert component["name"] in first["unavailable_components"]


def test_prioritization_reports_the_weights_it_used(api_client):
    """Weights are a scientific judgement — the caller must be able to see
    which ones produced this ranking."""
    body = api_client.get("/api/v1/prioritization").json()
    assert set(body["weights"]) == {
        "unclustered",
        "family_rarity",
        "taxonomic_isolation",
        "mibig_distance",
        "class_rarity_in_clade",
    }


def test_prioritization_respects_limit(api_client):
    body = api_client.get("/api/v1/prioritization", params={"limit": 2}).json()
    assert len(body["results"]) <= 2


def test_export_endpoint_allows_browser_preflight(api_client):
    """A browser sends OPTIONS before any POST with a JSON content-type.
    This shipped broken — allow_methods was ["GET"] from when the API was
    read-only — and every existing test missed it because TestClient calls
    the endpoint directly without a preflight. So this test issues the
    preflight explicitly.
    """
    response = api_client.options(
        "/api/v1/export",
        headers={
            "Origin": "http://localhost:3000",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
    )
    assert response.status_code == 200, f"preflight rejected: {response.text}"
    allowed = response.headers.get("access-control-allow-methods", "")
    assert "POST" in allowed
    assert response.headers.get("access-control-allow-origin") is not None


def test_get_endpoints_still_allow_preflight(api_client):
    response = api_client.options(
        "/api/v1/taxonomy-tree",
        headers={"Origin": "http://localhost:3000", "Access-Control-Request-Method": "GET"},
    )
    assert response.status_code == 200
