"""Grafting parent-less species (MIBiG-style) onto the GTDB genus backbone."""
from __future__ import annotations

import pytest

from bgcscape.ingest.graft import genus_token, graft_orphan_species, normalize_genus
from bgcscape.models import (
    EvidenceLevel,
    Genome,
    Source,
    SourceType,
    Taxon,
    TaxonRank,
)
from bgcscape.models.genome import AssemblyLevel


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("Streptomyces coelicolor A3(2)", "streptomyces"),
        ("Candidatus Entotheonella factor", "entotheonella"),
        ("[Polyangium] brachysporum", "polyangium"),
        ("Kutzneria sp. 744", "kutzneria"),
    ],
)
def test_genus_token(name: str, expected: str) -> None:
    assert genus_token(name) == expected


def test_normalize_genus_drops_gtdb_polyphyly_suffix() -> None:
    assert normalize_genus("Streptomyces_A") == "streptomyces"
    assert normalize_genus("Streptomyces") == "streptomyces"


def _src(session) -> Source:
    src = Source(name="t", source_type=SourceType.REFERENCE_DATABASE, version="1")
    session.add(src)
    session.flush()
    return src


def _species_with_genome(session, src, name: str, parent_id=None) -> Taxon:
    sp = Taxon(
        name=name,
        rank=TaxonRank.SPECIES,
        parent_id=parent_id,
        source_id=src.id,
        evidence_level=EvidenceLevel.OBSERVED_CURATED,
    )
    session.add(sp)
    session.flush()
    session.add(
        Genome(
            accession=f"ACC_{name}",
            taxon_id=sp.id,
            assembly_level=AssemblyLevel.LOCUS,
            is_mag=False,
            source_id=src.id,
            evidence_level=EvidenceLevel.OBSERVED_CURATED,
        )
    )
    session.flush()
    return sp


def test_graft_attaches_orphans_to_matching_genus(session) -> None:
    src = _src(session)
    # GTDB backbone: a genus (with the polyphyly suffix GTDB often adds).
    genus = Taxon(
        name="Streptomyces_A",
        rank=TaxonRank.GENUS,
        source_id=src.id,
        evidence_level=EvidenceLevel.OBSERVED_CURATED,
    )
    session.add(genus)
    session.flush()

    orphan = _species_with_genome(session, src, "Streptomyces nodosus")
    fungus = _species_with_genome(session, src, "Aspergillus oryzae")
    already = _species_with_genome(session, src, "Streptomyces already", parent_id=genus.id)
    session.commit()

    report = graft_orphan_species(session)

    session.refresh(orphan)
    session.refresh(fungus)
    assert orphan.parent_id == genus.id  # grafted by normalized genus name
    assert fungus.parent_id is None  # no matching bacterial genus — left alone
    assert report.grafted == 1
    assert report.unmatched == 1
    assert "Aspergillus oryzae" in report.unmatched_examples
    # `already` was untouched and counted as already placed.
    assert report.already_placed >= 1


def test_graft_is_idempotent(session) -> None:
    src = _src(session)
    genus = Taxon(
        name="Kutzneria",
        rank=TaxonRank.GENUS,
        source_id=src.id,
        evidence_level=EvidenceLevel.OBSERVED_CURATED,
    )
    session.add(genus)
    session.flush()
    _species_with_genome(session, src, "Kutzneria albida")
    session.commit()

    first = graft_orphan_species(session)
    second = graft_orphan_species(session)
    assert first.grafted == 1
    assert second.grafted == 0
