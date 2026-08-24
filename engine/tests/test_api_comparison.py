"""Tests for comparative clade analysis (/api/v1/compare).

Builds its own multi-clade dataset directly rather than reusing the
fixture-file pipeline: the shipped fixtures deliberately concentrate
everything in one species (they exist to test cross-source merging), which
is precisely the wrong shape for testing a feature about *differences
between* clades.
"""
from __future__ import annotations

import uuid
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from bgcscape.models import (
    BGC,
    AssemblyLevel,
    Base,
    BGCClass,
    BGCFamily,
    BGCFamilyMembership,
    EvidenceLevel,
    Genome,
    Source,
    SourceType,
    Taxon,
    TaxonRank,
)


def _build_dataset(session: Session) -> dict[str, uuid.UUID]:
    """Two genera under one family, with deliberately different profiles:

      Alpha (4 genomes): NRPS-heavy, carries FAM_SHARED and FAM_ALPHA
      Beta  (4 genomes): terpene-heavy, carries FAM_SHARED only
      Gamma (1 genome):  deliberately under-sampled, to trip the thin-data caveat
    """
    tool = Source(name="antiSMASH", source_type=SourceType.TOOL_RUN, version="7.1.0")
    clustering = Source(name="BiG-SCAPE", source_type=SourceType.TOOL_RUN, version="2.0.0")
    session.add_all([tool, clustering])
    session.flush()

    root = Taxon(
        name="Testaceae",
        rank=TaxonRank.FAMILY,
        source_id=tool.id,
        evidence_level=EvidenceLevel.OBSERVED_CURATED,
    )
    session.add(root)
    session.flush()

    genera: dict[str, Taxon] = {}
    for name in ("Alphagenus", "Betagenus", "Gammagenus"):
        genus = Taxon(
            name=name,
            rank=TaxonRank.GENUS,
            parent_id=root.id,
            source_id=tool.id,
            evidence_level=EvidenceLevel.OBSERVED_CURATED,
        )
        session.add(genus)
        genera[name] = genus
    session.flush()

    fam_shared = BGCFamily(
        label="FAM_SHARED",
        clustering_method="BiG-SCAPE 2.0.0",
        clustering_cutoff=0.3,
        source_id=clustering.id,
        evidence_level=EvidenceLevel.COMPUTED,
    )
    fam_alpha = BGCFamily(
        label="FAM_ALPHA_ONLY",
        clustering_method="BiG-SCAPE 2.0.0",
        clustering_cutoff=0.3,
        source_id=clustering.id,
        evidence_level=EvidenceLevel.COMPUTED,
    )
    session.add_all([fam_shared, fam_alpha])
    session.flush()

    def add_genome(genus: Taxon, accession: str, specs: list[tuple[BGCClass, str | None, BGCFamily | None]]) -> None:
        # A species level between genus and genome, mirroring how GTDB
        # ingestion actually builds the hierarchy — so this also exercises
        # subtree collection descending more than one level.
        species = Taxon(
            name=f"{genus.name} {accession.lower()}",
            rank=TaxonRank.SPECIES,
            parent_id=genus.id,
            source_id=tool.id,
            evidence_level=EvidenceLevel.OBSERVED_CURATED,
        )
        session.add(species)
        session.flush()

        genome = Genome(
            accession=accession,
            taxon_id=species.id,
            assembly_level=AssemblyLevel.COMPLETE_GENOME,
            is_mag=False,
            source_id=tool.id,
            evidence_level=EvidenceLevel.OBSERVED_CURATED,
        )
        session.add(genome)
        session.flush()

        for bgc_class, subtype, family in specs:
            bgc = BGC(
                genome_id=genome.id,
                bgc_class=bgc_class,
                subtype=subtype,
                predicted_by_tool="antiSMASH 7.1.0",
                source_id=tool.id,
                evidence_level=EvidenceLevel.PREDICTED,
            )
            session.add(bgc)
            session.flush()
            if family is not None:
                session.add(BGCFamilyMembership(bgc_id=bgc.id, family_id=family.id))
        session.flush()

    for i in range(4):
        add_genome(
            genera["Alphagenus"],
            f"GCF_ALPHA{i}.1",
            [(BGCClass.NRPS, None, fam_shared), (BGCClass.NRPS, None, fam_alpha)],
        )
    for i in range(4):
        add_genome(
            genera["Betagenus"],
            f"GCF_BETA{i}.1",
            [(BGCClass.TERPENE, None, fam_shared)],
        )
    add_genome(
        genera["Gammagenus"],
        "GCF_GAMMA0.1",
        [(BGCClass.HYBRID, "nrps+pks", None)],
    )

    session.commit()
    return {name: genus.id for name, genus in genera.items()} | {"root": root.id}


@pytest.fixture()
def compare_client(monkeypatch) -> Iterator[tuple[TestClient, dict[str, uuid.UUID]]]:
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        future=True,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    session_local = sessionmaker(bind=engine, future=True)

    with Session(engine, future=True) as seed:
        ids = _build_dataset(seed)

    import bgcscape.api.app as api_app_module

    monkeypatch.setattr(api_app_module, "get_sessionmaker", lambda: session_local)
    with TestClient(api_app_module.app) as client:
        yield client, ids


def _compare(client: TestClient, *taxon_ids: uuid.UUID):
    params = [("taxon_ids", str(tid)) for tid in taxon_ids]
    return client.get("/api/v1/compare", params=params)


# --- input validation ------------------------------------------------------------


def test_compare_requires_two_distinct_clades(compare_client):
    client, ids = compare_client
    assert _compare(client, ids["Alphagenus"]).status_code == 422
    # The same id twice is still only one clade.
    assert _compare(client, ids["Alphagenus"], ids["Alphagenus"]).status_code == 422


def test_compare_unknown_taxon_is_404(compare_client):
    client, ids = compare_client
    response = _compare(client, ids["Alphagenus"], uuid.UUID("00000000-0000-0000-0000-000000000000"))
    assert response.status_code == 404


# --- profiling -------------------------------------------------------------------


def test_profiles_count_genomes_across_the_whole_subtree(compare_client):
    client, ids = compare_client
    body = _compare(client, ids["Alphagenus"], ids["Betagenus"]).json()

    alpha = next(c for c in body["clades"] if c["taxon_name"] == "Alphagenus")
    beta = next(c for c in body["clades"] if c["taxon_name"] == "Betagenus")

    # Genomes hang off species nodes one level below each genus — this
    # confirms subtree collection descends, rather than only counting
    # genomes attached directly to the selected taxon.
    assert alpha["genome_count"] == 4
    assert beta["genome_count"] == 4
    assert alpha["bgc_count"] == 8  # 2 BGCs per genome
    assert beta["bgc_count"] == 4


def test_per_genome_rates_are_reported(compare_client):
    client, ids = compare_client
    body = _compare(client, ids["Alphagenus"], ids["Betagenus"]).json()

    alpha = next(c for c in body["clades"] if c["taxon_name"] == "Alphagenus")
    beta = next(c for c in body["clades"] if c["taxon_name"] == "Betagenus")
    assert alpha["bgcs_per_genome"] == pytest.approx(2.0)
    assert beta["bgcs_per_genome"] == pytest.approx(1.0)


def test_class_profiles_distinguish_the_clades(compare_client):
    client, ids = compare_client
    body = _compare(client, ids["Alphagenus"], ids["Betagenus"]).json()

    alpha = next(c for c in body["clades"] if c["taxon_name"] == "Alphagenus")
    beta = next(c for c in body["clades"] if c["taxon_name"] == "Betagenus")

    alpha_classes = {e["bgc_class"]: e for e in alpha["class_profile"]}
    beta_classes = {e["bgc_class"]: e for e in beta["class_profile"]}

    assert alpha_classes["nrps"]["count"] == 8
    assert alpha_classes["nrps"]["per_genome"] == pytest.approx(2.0)
    assert "terpene" not in alpha_classes
    assert beta_classes["terpene"]["count"] == 4
    assert "nrps" not in beta_classes


def test_hybrid_bgcs_are_counted_under_each_component_class(compare_client):
    """Matches how the frontend counts and filters hybrids — otherwise the
    same BGC would be counted one way in the comparison table and another
    in the class filter rail."""
    client, ids = compare_client
    body = _compare(client, ids["Gammagenus"], ids["Alphagenus"]).json()

    gamma = next(c for c in body["clades"] if c["taxon_name"] == "Gammagenus")
    classes = {e["bgc_class"]: e["count"] for e in gamma["class_profile"]}
    assert classes == {"nrps": 1, "pks": 1}
    assert "hybrid" not in classes
    assert gamma["bgc_count"] == 1  # still one BGC, counted once


# --- family partitioning ----------------------------------------------------------


def test_shared_and_clade_specific_families(compare_client):
    client, ids = compare_client
    body = _compare(client, ids["Alphagenus"], ids["Betagenus"]).json()

    assert [f["label"] for f in body["shared_families"]] == ["FAM_SHARED"]

    alpha = next(c for c in body["clades"] if c["taxon_name"] == "Alphagenus")
    beta = next(c for c in body["clades"] if c["taxon_name"] == "Betagenus")
    assert [f["label"] for f in alpha["only_in_this_clade"]] == ["FAM_ALPHA_ONLY"]
    assert beta["only_in_this_clade"] == []
    assert alpha["family_count"] == 2
    assert beta["family_count"] == 1


def test_family_in_some_but_not_all_clades_is_neither_shared_nor_unique(compare_client):
    """With three clades, FAM_SHARED is in Alpha and Beta but not Gamma.
    It's therefore neither universal nor clade-specific, and must appear in
    neither bucket rather than being quietly folded into one."""
    client, ids = compare_client
    body = _compare(client, ids["Alphagenus"], ids["Betagenus"], ids["Gammagenus"]).json()

    assert body["shared_families"] == []
    for clade in body["clades"]:
        labels = [f["label"] for f in clade["only_in_this_clade"]]
        assert "FAM_SHARED" not in labels
    alpha = next(c for c in body["clades"] if c["taxon_name"] == "Alphagenus")
    assert [f["label"] for f in alpha["only_in_this_clade"]] == ["FAM_ALPHA_ONLY"]


# --- scientific rigor: caveats and the comparable flag ----------------------------


def test_well_sampled_comparison_is_marked_comparable(compare_client):
    client, ids = compare_client
    body = _compare(client, ids["Alphagenus"], ids["Betagenus"]).json()
    assert body["comparable"] is True


def test_absence_caveat_is_always_present(compare_client):
    """The most important caveat: 'only in this clade' reflects the
    dataset, not biology. It must be stated on every comparison, including
    well-sampled ones."""
    client, ids = compare_client
    body = _compare(client, ids["Alphagenus"], ids["Betagenus"]).json()
    joined = " ".join(body["caveats"]).lower()
    assert "not that the other clades lack it" in joined
    assert "sampling depth" in joined


def test_no_statistical_claim_caveat_is_always_present(compare_client):
    client, ids = compare_client
    body = _compare(client, ids["Alphagenus"], ids["Betagenus"]).json()
    joined = " ".join(body["caveats"]).lower()
    assert "no statistical testing" in joined
    assert "not independent samples" in joined


def test_thin_clade_makes_the_comparison_not_comparable(compare_client):
    client, ids = compare_client
    body = _compare(client, ids["Alphagenus"], ids["Gammagenus"]).json()

    assert body["comparable"] is False
    joined = " ".join(body["caveats"])
    assert "Gammagenus" in joined
    assert "Fewer than 3 genomes" in joined
    # Still returns the numbers — the flag is for how to present them.
    gamma = next(c for c in body["clades"] if c["taxon_name"] == "Gammagenus")
    assert gamma["genome_count"] == 1


def test_empty_clade_is_handled_without_dividing_by_zero(compare_client):
    """A taxon with no genomes anywhere beneath it must not crash the
    per-genome rate calculation, and must mark the comparison as not
    comparable rather than silently reporting zeroes as if they were
    measurements."""
    client, ids = compare_client

    # Create a genus with nothing under it, via the same session the API
    # reads from.
    import bgcscape.api.app as api_app_module

    with api_app_module.get_sessionmaker()() as session:
        source = session.query(Source).first()
        empty = Taxon(
            name="Emptygenus",
            rank=TaxonRank.GENUS,
            parent_id=ids["root"],
            source_id=source.id,
            evidence_level=EvidenceLevel.OBSERVED_CURATED,
        )
        session.add(empty)
        session.commit()
        empty_id = empty.id

    body = _compare(client, ids["Alphagenus"], empty_id).json()

    empty_clade = next(c for c in body["clades"] if c["taxon_name"] == "Emptygenus")
    assert empty_clade["genome_count"] == 0
    assert empty_clade["bgc_count"] == 0
    assert empty_clade["bgcs_per_genome"] is None
    assert empty_clade["class_profile"] == []

    assert body["comparable"] is False
    assert any("no classified genomes" in c for c in body["caveats"])

    # An empty clade shares nothing, so nothing is universal.
    assert body["shared_families"] == []
