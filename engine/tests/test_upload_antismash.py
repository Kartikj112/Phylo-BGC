"""Uploading an antiSMASH result over HTTP, and whether it lands on the tree.

The interesting assertions here are not "did rows get written" — that is
ingest/antismash.py's job and tests/test_ingest_antismash.py already covers
it. They are about the step AFTER that, which is where an upload silently
does nothing: `tree_builder.genomes_by_taxon` skips every genome whose
`taxon_id` is NULL, so a perfectly ingested genome with no organism name is
invisible. `test_genome_without_an_organism_is_absent_from_the_tree` pins
that behaviour deliberately, and the rest check that supplying an organism
actually gets the genome drawn.
"""
from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from bgcscape.ingest.gtdb import ingest_gtdb_metadata, read_gtdb_metadata_tsv
from bgcscape.models import Base, Genome, Source, SourceType, Taxon, TaxonRank

FIXTURES = Path(__file__).parent / "fixtures"
RESULT_PATH = FIXTURES / "antismash_test_result.json"
GTDB_TSV = FIXTURES / "gtdb_metadata_test.tsv"


@pytest.fixture()
def upload_client(monkeypatch) -> Iterator[tuple[TestClient, sessionmaker]]:
    """A client over a database carrying only the GTDB backbone.

    No antiSMASH data is pre-loaded, unlike the `api_client` fixture: these
    tests are about what an upload ADDS, so the corpus has to start without
    it. GTDB is present because the graft target has to exist for
    `placement: "grafted"` to be reachable at all.
    """
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        future=True,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    session_local = sessionmaker(bind=engine, future=True)

    with Session(engine, future=True) as seed:
        gtdb = Source(name="GTDB", source_type=SourceType.REFERENCE_DATABASE, version="R11-RS232")
        seed.add(gtdb)
        seed.commit()
        ingest_gtdb_metadata(seed, gtdb, read_gtdb_metadata_tsv(GTDB_TSV))

    import bgcscape.api.app as api_app_module

    monkeypatch.setattr(api_app_module, "get_sessionmaker", lambda: session_local)
    monkeypatch.setattr(api_app_module, "_UPLOADS_ENABLED", True)
    with TestClient(api_app_module.app) as client:
        yield client, session_local


def _upload(client: TestClient, *, filename="GCF_UPLOAD001.1.json", organism=None, **form):
    files = [("files", (filename, RESULT_PATH.read_bytes(), "application/json"))]
    data = {**form}
    if organism is not None:
        data["organism"] = organism
    return client.post("/api/v1/ingest/antismash", files=files, data=data)


def _genus_in_gtdb(session_local) -> str:
    with session_local() as s:
        genus = s.query(Taxon).filter(Taxon.rank == TaxonRank.GENUS).first()
        assert genus is not None, "fixture GTDB data must carry at least one genus"
        return genus.name


# --- the ingest half --------------------------------------------------------


def test_upload_ingests_every_region_and_names_the_genome_from_the_filename(upload_client):
    client, _ = upload_client
    response = _upload(client, organism="Streptomyces coelicolor")
    assert response.status_code == 200, response.text

    body = response.json()
    assert body["total_regions"] == 3  # the fixture's three regions
    assert len(body["genomes"]) == 1
    genome = body["genomes"][0]
    # antiSMASH's JSON has no accession field, so the filename is the only
    # identifier an upload arrives with.
    assert genome["accession"] == "GCF_UPLOAD001.1"
    assert genome["regions_created"] == 3
    assert genome["errors"] == []


def test_uploading_the_same_file_twice_updates_rather_than_duplicates(upload_client):
    client, session_local = upload_client
    _upload(client, organism="Streptomyces coelicolor")
    second = _upload(client, organism="Streptomyces coelicolor").json()

    assert second["genomes"][0]["regions_created"] == 0
    assert second["genomes"][0]["regions_updated"] == 3
    with session_local() as s:
        assert s.query(Genome).filter_by(accession="GCF_UPLOAD001.1").count() == 1


def test_upload_is_recorded_as_user_data_not_reference_data(upload_client):
    client, session_local = upload_client
    _upload(client, organism="Streptomyces coelicolor", label="my lab run")

    with session_local() as s:
        source = s.query(Source).filter_by(name="my lab run").one()
        # The provenance model's whole point: a reader can tell a visitor's
        # upload from the curated corpus, and it stays removable.
        assert source.source_type == SourceType.USER_UPLOAD


# --- the placement half: does it actually reach the tree? -------------------


def test_genome_without_an_organism_is_absent_from_the_tree(upload_client):
    """The trap this feature exists to close.

    The rows are written and the region count is truthful, but the tree is
    built from taxa — so with no organism the genome cannot be drawn. The
    response must say so rather than report a bare success.
    """
    client, _ = upload_client
    body = _upload(client).json()
    assert body["genomes"][0]["placement"] == "unplaced"
    assert body["genomes"][0]["regions_created"] == 3

    tree = client.get("/api/v1/taxonomy-tree?scope=prokaryote").json()
    assert "GCF_UPLOAD001.1" not in json.dumps(tree)


def test_an_organism_in_a_known_genus_is_grafted_and_appears_in_the_tree(upload_client):
    client, session_local = upload_client
    genus = _genus_in_gtdb(session_local)
    body = _upload(client, organism=f"{genus} testicola").json()

    genome = body["genomes"][0]
    assert genome["placement"] == "grafted"
    assert genome["grafted_to"] == genus
    # The assertion that matters: it is actually drawable now.
    tree = client.get("/api/v1/taxonomy-tree?scope=prokaryote").json()
    assert "GCF_UPLOAD001.1" in json.dumps(tree)


def test_an_unknown_genus_is_reported_honestly_rather_than_forced(upload_client):
    client, _ = upload_client
    body = _upload(client, organism="Aspergillus nidulans").json()

    genome = body["genomes"][0]
    # GTDB is prokaryote-only, so a fungal genus has no target. The species
    # is real and kept; it simply has no GTDB parent, and saying
    # "species_only" is the honest answer rather than inventing a placement.
    assert genome["placement"] == "species_only"
    assert genome["organism"] == "Aspergillus nidulans"
    assert genome["grafted_to"] is None


def test_upload_joins_an_existing_species_instead_of_duplicating_it(upload_client):
    client, session_local = upload_client
    with session_local() as s:
        existing = s.query(Taxon).filter(Taxon.rank == TaxonRank.SPECIES).first()
        assert existing is not None
        name = existing.name
        before = existing.source_id

    _upload(client, organism=name)

    with session_local() as s:
        matches = s.query(Taxon).filter(Taxon.rank == TaxonRank.SPECIES, Taxon.name == name).all()
        assert len(matches) == 1, "an upload must not create a second row for a known species"
        # And it must not relabel GTDB's row as user-uploaded data.
        assert matches[0].source_id == before
        genome = s.query(Genome).filter_by(accession="GCF_UPLOAD001.1").one()
        assert genome.taxon_id == matches[0].id


def test_is_mag_flag_is_recorded(upload_client):
    client, session_local = upload_client
    _upload(client, organism="Streptomyces coelicolor", is_mag="true")
    with session_local() as s:
        assert s.query(Genome).filter_by(accession="GCF_UPLOAD001.1").one().is_mag is True


# --- rejection paths --------------------------------------------------------


def test_a_file_that_is_not_json_is_rejected_without_failing_the_request(upload_client):
    client, _ = upload_client
    response = client.post(
        "/api/v1/ingest/antismash",
        files=[("files", ("notes.json", b"this is not json", "application/json"))],
        data={"organism": "Streptomyces coelicolor"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["genomes"] == []
    assert len(body["rejected"]) == 1
    assert "not valid JSON" in body["rejected"][0]


def test_one_bad_file_does_not_sink_the_good_ones_beside_it(upload_client):
    client, _ = upload_client
    response = client.post(
        "/api/v1/ingest/antismash",
        files=[
            ("files", ("broken.json", b"{oh no", "application/json")),
            ("files", ("GCF_UPLOAD002.1.json", RESULT_PATH.read_bytes(), "application/json")),
        ],
        data={"organism": "Streptomyces coelicolor"},
    )
    body = response.json()
    assert len(body["rejected"]) == 1
    assert len(body["genomes"]) == 1
    assert body["genomes"][0]["accession"] == "GCF_UPLOAD002.1"


def test_valid_json_that_is_not_an_antismash_result_is_an_error_not_a_crash(upload_client):
    client, _ = upload_client
    response = client.post(
        "/api/v1/ingest/antismash",
        files=[("files", ("x.json", json.dumps({"hello": "world"}).encode(), "application/json"))],
        data={"organism": "Streptomyces coelicolor"},
    )
    assert response.status_code == 200
    genome = response.json()["genomes"][0]
    assert genome["regions_created"] == 0
    assert genome["errors"], "a structurally invalid result must say why"


def test_uploads_can_be_switched_off_for_a_read_only_deployment(upload_client, monkeypatch):
    client, _ = upload_client
    import bgcscape.api.app as api_app_module

    monkeypatch.setattr(api_app_module, "_UPLOADS_ENABLED", False)
    response = _upload(client, organism="Streptomyces coelicolor")
    assert response.status_code == 403
    assert "read-only" in response.json()["detail"]


def test_too_many_files_is_refused_before_any_are_read(upload_client):
    client, _ = upload_client
    files = [
        ("files", (f"g{i}.json", RESULT_PATH.read_bytes(), "application/json")) for i in range(26)
    ]
    response = client.post(
        "/api/v1/ingest/antismash", files=files, data={"organism": "Streptomyces coelicolor"}
    )
    assert response.status_code == 413
