"""Linking MIBiG clusters to the GTDB genome of the same organism."""
from __future__ import annotations

from pathlib import Path

from bgcscape.ingest.link import (
    PLACEMENT_KEY,
    link_mibig_to_gtdb,
    placement_of,
    read_mapping,
)
from bgcscape.models import (
    BGC,
    BGCClass,
    EvidenceLevel,
    Genome,
    Source,
    SourceType,
    Taxon,
    TaxonRank,
)
from bgcscape.models.genome import AssemblyLevel


def _source(session, name="MIBiG") -> Source:
    src = Source(name=name, source_type=SourceType.REFERENCE_DATABASE, version="4.0")
    session.add(src)
    session.flush()
    return src


def _genome(session, src, accession: str, level: AssemblyLevel, taxon_id=None) -> Genome:
    genome = Genome(
        accession=accession,
        assembly_level=level,
        is_mag=False,
        taxon_id=taxon_id,
        source_id=src.id,
        evidence_level=EvidenceLevel.OBSERVED_CURATED,
    )
    session.add(genome)
    session.flush()
    return genome


def _bgc(session, src, genome, mibig_accession: str, contig: str) -> BGC:
    bgc = BGC(
        genome_id=genome.id,
        contig=contig,
        bgc_class=BGCClass.PKS,
        mibig_accession=mibig_accession,
        raw_annotation={"accession": mibig_accession},
        source_id=src.id,
        evidence_level=EvidenceLevel.OBSERVED_CURATED,
    )
    session.add(bgc)
    session.flush()
    return bgc


def _fixture(session):
    """A MIBiG locus stub carrying a cluster, plus the GTDB genome for the
    same organism — the exact shape the link pass exists to resolve."""
    src = _source(session)
    species = Taxon(
        name="Verrucosispora maris",
        rank=TaxonRank.SPECIES,
        source_id=src.id,
        evidence_level=EvidenceLevel.OBSERVED_CURATED,
    )
    session.add(species)
    session.flush()

    gtdb_genome = _genome(session, src, "GCF_000204155.1", AssemblyLevel.COMPLETE_GENOME, species.id)
    locus = _genome(session, src, "JF752342.1", AssemblyLevel.LOCUS)
    bgc = _bgc(session, src, locus, "BGC0000001", "JF752342.1")
    session.commit()
    return src, gtdb_genome, locus, bgc


def test_link_repoints_cluster_at_the_gtdb_genome(session) -> None:
    _src, gtdb_genome, _locus, bgc = _fixture(session)

    report = link_mibig_to_gtdb(
        session, [("BGC0000001", "GCF_000204155.1", "ncbi_taxid")]
    )

    session.refresh(bgc)
    assert report.linked == 1
    assert bgc.genome_id == gtdb_genome.id
    # MIBiG's own locus accession survives the move — the cluster was
    # characterized there, not on the GTDB assembly.
    assert bgc.contig == "JF752342.1"


def test_link_records_how_the_placement_was_made(session) -> None:
    _src, _gtdb, _locus, bgc = _fixture(session)
    link_mibig_to_gtdb(session, [("BGC0000001", "GCF_000204155.1", "ncbi_taxid")])

    session.refresh(bgc)
    placement = placement_of(bgc)
    assert placement is not None
    assert placement["method"] == "ncbi_taxid"
    assert placement["gtdb_accession"] == "GCF_000204155.1"
    # The original MIBiG payload is not clobbered by the added key.
    assert bgc.raw_annotation["accession"] == "BGC0000001"
    assert PLACEMENT_KEY in bgc.raw_annotation


def test_link_prunes_the_emptied_locus_stub(session) -> None:
    _src, _gtdb, locus, _bgc = _fixture(session)
    locus_id = locus.id

    report = link_mibig_to_gtdb(session, [("BGC0000001", "GCF_000204155.1", "ncbi_taxid")])

    assert report.pruned_genomes == 1
    assert session.get(Genome, locus_id) is None


def test_unlinked_entries_keep_their_locus_stub(session) -> None:
    """An entry GTDB has no genome for must stay on the tree, not vanish."""
    src, _gtdb, _locus, _existing = _fixture(session)
    orphan_locus = _genome(session, src, "XX999999.1", AssemblyLevel.LOCUS)
    _bgc(session, src, orphan_locus, "BGC0009999", "XX999999.1")
    session.commit()
    orphan_id = orphan_locus.id

    link_mibig_to_gtdb(session, [("BGC0000001", "GCF_000204155.1", "ncbi_taxid")])

    # Still present: it still carries its cluster.
    assert session.get(Genome, orphan_id) is not None


def test_keep_locus_stubs_disables_pruning(session) -> None:
    _src, _gtdb, locus, _bgc = _fixture(session)
    locus_id = locus.id

    report = link_mibig_to_gtdb(
        session, [("BGC0000001", "GCF_000204155.1", "ncbi_taxid")], prune_unlinked=False
    )

    assert report.pruned_genomes == 0
    assert session.get(Genome, locus_id) is not None


def test_link_is_idempotent(session) -> None:
    _fixture(session)
    mapping = [("BGC0000001", "GCF_000204155.1", "ncbi_taxid")]

    first = link_mibig_to_gtdb(session, mapping)
    second = link_mibig_to_gtdb(session, mapping)

    assert first.linked == 1
    assert second.linked == 0
    assert second.already_linked == 1


def test_missing_rows_are_reported_not_raised(session) -> None:
    _fixture(session)

    report = link_mibig_to_gtdb(
        session,
        [
            ("BGC0000001", "GCF_NOT_INGESTED.1", "ncbi_taxid"),  # genome absent
            ("BGC_NOPE", "GCF_000204155.1", "ncbi_taxid"),  # entry absent
        ],
    )

    assert report.missing_genome == 1
    assert report.missing_bgc == 1
    assert report.linked == 0


def test_read_mapping_parses_the_tsv(tmp_path: Path) -> None:
    path = tmp_path / "map.tsv"
    path.write_text(
        "mibig_accession\tgtdb_accession\tmatch_method\n"
        "BGC0000001\tGCF_000204155.1\tncbi_taxid\n"
        "BGC0000002\tGCF_000525635.1\tgtdb_species\n"
        "\t\t\n",  # blank row is skipped rather than yielding an empty pair
        encoding="utf-8",
    )

    rows = read_mapping(path)

    assert rows == [
        ("BGC0000001", "GCF_000204155.1", "ncbi_taxid"),
        ("BGC0000002", "GCF_000525635.1", "gtdb_species"),
    ]


# === Re-ingestion must not undo placement ======================================


def test_reingesting_mibig_does_not_undo_the_gtdb_placement(session) -> None:
    """THE regression test for the re-ingest corruption.

    `ingest mibig` -> `link-mibig` -> `ingest mibig` is the documented
    "new MIBiG release" workflow. The second ingest used to recreate the
    deleted locus stub and point the cluster back at it, silently undoing
    every placement: on the real corpus that moved 1,629 clusters off real
    GTDB assemblies back onto locus stubs and regrew 665 orphan species
    nodes — while reporting `created=0, updated=2437`, i.e. perfectly
    idempotent. Row counts, not the report line, are what caught it.
    """
    from bgcscape.ingest.mibig import ParsedMibigEntry, load_mibig_entry

    src, gtdb_genome, locus, bgc = _fixture(session)
    link_mibig_to_gtdb(session, [("BGC0000001", "GCF_000204155.1", "ncbi_taxid")])
    session.commit()

    assert bgc.genome_id == gtdb_genome.id
    assert session.query(Genome).filter_by(accession="JF752342.1").one_or_none() is None
    genomes_before = session.query(Genome).count()
    taxa_before = session.query(Taxon).count()

    # Re-ingest the same entry, exactly as a release refresh would.
    entry = ParsedMibigEntry(
        mibig_accession="BGC0000001",
        status="active",
        locus_accession="JF752342.1",
        organism_name="Verrucosispora maris",
        ncbi_taxid=1003110,
        bgc_class=BGCClass.PKS,
        subtype=None,
        start_coord=None,
        end_coord=None,
        compounds=[],
        raw={"accession": "BGC0000001"},
    )
    load_mibig_entry(session, entry, src)
    session.commit()

    session.refresh(bgc)
    assert bgc.genome_id == gtdb_genome.id, "re-ingest must not repoint a placed cluster"
    assert (
        session.query(Genome).filter_by(accession="JF752342.1").one_or_none() is None
    ), "the deleted locus stub must not be resurrected"
    assert session.query(Genome).count() == genomes_before
    assert session.query(Taxon).count() == taxa_before


def test_reingesting_an_unplaced_entry_still_creates_its_locus_stub(session) -> None:
    """The guard must be surgical: an entry that was never linked still
    needs its stub, or a genuine new release would ingest nothing."""
    from bgcscape.ingest.mibig import ParsedMibigEntry, load_mibig_entry

    src = _source(session)
    entry = ParsedMibigEntry(
        mibig_accession="BGC0000999",
        status="active",
        locus_accession="ZZ999999.1",
        organism_name="Streptomyces novus",
        ncbi_taxid=999999,
        bgc_class=BGCClass.PKS,
        subtype=None,
        start_coord=None,
        end_coord=None,
        compounds=[],
        raw={"accession": "BGC0000999"},
    )
    load_mibig_entry(session, entry, src)
    session.commit()

    stub = session.query(Genome).filter_by(accession="ZZ999999.1").one_or_none()
    assert stub is not None
    assert stub.assembly_level == AssemblyLevel.LOCUS
