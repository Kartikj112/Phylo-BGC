from __future__ import annotations

import uuid
from pathlib import Path

import pytest
from typer.testing import CliRunner

from bgcscape.ingest.backbone import build_backbone
from bgcscape.ingest.gtdb import ingest_gtdb_metadata, read_gtdb_metadata_tsv
from bgcscape.models import BackboneGenome, BackboneNode, Genome, Source, SourceType, Taxon, TaxonRank

FIXTURES = Path(__file__).parent / "fixtures"

STREP = "d__Bacteria;p__Actinomycetota;c__Actinomycetes;o__Streptomycetales;f__Streptomycetaceae;g__Streptomyces"
BACILLUS = "d__Bacteria;p__Bacillota;c__Bacilli;o__Bacillales;f__Bacillaceae;g__Bacillus"
ARCHAEON = "d__Archaea;p__Methanobacteriota;c__Methanobacteria;o__Methanobacteriales;f__Methanobacteriaceae;g__Methanobrevibacter"


def _row(accession: str, lineage: str, representative: str) -> dict[str, str]:
    return {"accession": accession, "gtdb_taxonomy": lineage, "gtdb_genome_representative": representative}


# Two Streptomyces species (one with two genomes), one Bacillus species, one
# archaeon: the GTDB shape in miniature, including both RS_ and GB_ prefixes.
ROWS = [
    _row("RS_GCF_000000001.1", f"{STREP};s__Streptomyces alpha", "RS_GCF_000000001.1"),
    _row("GB_GCA_000000002.1", f"{STREP};s__Streptomyces alpha", "RS_GCF_000000001.1"),
    _row("RS_GCF_000000003.1", f"{STREP};s__Streptomyces beta", "RS_GCF_000000003.1"),
    _row("RS_GCF_000000004.1", f"{BACILLUS};s__Bacillus gamma", "RS_GCF_000000004.1"),
    _row("RS_GCF_000000005.1", f"{ARCHAEON};s__Methanobrevibacter delta", "RS_GCF_000000005.1"),
]


def _node(session, name: str) -> BackboneNode:
    return session.query(BackboneNode).filter_by(name=name).one()


def test_builds_the_whole_lineage_with_parents(session, gtdb_source):
    build_backbone(session, gtdb_source, ROWS)

    species = _node(session, "Streptomyces alpha")
    chain = []
    node = species
    while node is not None:
        chain.append((node.rank, node.name))
        node = session.get(BackboneNode, node.parent_id) if node.parent_id else None
    assert chain[::-1] == [
        (TaxonRank.DOMAIN, "Bacteria"),
        (TaxonRank.PHYLUM, "Actinomycetota"),
        (TaxonRank.CLASS, "Actinomycetes"),
        (TaxonRank.ORDER, "Streptomycetales"),
        (TaxonRank.FAMILY, "Streptomycetaceae"),
        (TaxonRank.GENUS, "Streptomyces"),
        (TaxonRank.SPECIES, "Streptomyces alpha"),
    ]
    assert species.representative_accession == "GCF_000000001.1"
    # Both domains are roots of the same backbone.
    roots = {n.name for n in session.query(BackboneNode).filter(BackboneNode.parent_id.is_(None))}
    assert roots == {"Bacteria", "Archaea"}


def test_counts_describe_the_release_not_the_stored_rows(session, gtdb_source):
    """One genome per species is stored, but every genome is counted."""
    report = build_backbone(session, gtdb_source, ROWS)

    assert _node(session, "Streptomyces alpha").genome_count == 2
    assert _node(session, "Streptomyces").genome_count == 3
    assert _node(session, "Streptomyces").species_count == 2
    bacteria = _node(session, "Bacteria")
    assert (bacteria.genome_count, bacteria.species_count) == (4, 3)
    assert _node(session, "Streptomyces alpha").species_count == 1

    assert report.genomes_counted == 5
    assert report.representatives == 4
    assert report.nodes_by_rank["species"] == 4
    assert report.nodes_by_rank["domain"] == 2


def test_default_keeps_one_genome_per_species_on_the_species_node(session, gtdb_source):
    report = build_backbone(session, gtdb_source, ROWS)
    representatives = {
        n.name: n.representative_accession
        for n in session.query(BackboneNode).filter(BackboneNode.rank == TaxonRank.SPECIES)
    }
    assert representatives == {
        "Streptomyces alpha": "GCF_000000001.1",  # not GCA_000000002.1, its non-representative
        "Streptomyces beta": "GCF_000000003.1",
        "Bacillus gamma": "GCF_000000004.1",
        "Methanobrevibacter delta": "GCF_000000005.1",
    }
    # Higher ranks carry no genome of their own.
    assert _node(session, "Streptomyces").representative_accession is None
    assert session.query(BackboneGenome).count() == 0
    assert report.genomes_stored == 0


def test_all_genomes_stores_every_row_and_flags_representatives(session, gtdb_source):
    report = build_backbone(session, gtdb_source, ROWS, all_genomes=True)
    by_accession = {g.accession: g for g in session.query(BackboneGenome)}
    assert len(by_accession) == report.genomes_stored == 5
    assert by_accession["GCA_000000002.1"].is_species_representative is False
    assert by_accession["GCF_000000001.1"].is_species_representative is True
    # Stored on the species node, with the prefix stripped to match `genome.accession`.
    assert by_accession["GCA_000000002.1"].node_id == _node(session, "Streptomyces alpha").id


def test_representative_is_recognised_across_rs_and_gb_prefixes(session, gtdb_source):
    rows = [_row("GB_GCA_000000009.1", f"{STREP};s__Streptomyces eta", "RS_GCA_000000009.1")]
    build_backbone(session, gtdb_source, rows)
    assert _node(session, "Streptomyces eta").representative_accession == "GCA_000000009.1"


def test_genome_without_a_species_attaches_to_its_deepest_rank(session, gtdb_source):
    rows = [_row("RS_GCF_000000010.1", f"{STREP};s__", "RS_GCF_000000010.1")]
    build_backbone(session, gtdb_source, rows, all_genomes=True)
    genome = session.query(BackboneGenome).one()
    assert session.get(BackboneNode, genome.node_id).name == "Streptomyces"
    assert _node(session, "Streptomyces").species_count == 0
    assert _node(session, "Streptomyces").genome_count == 1


def test_same_name_under_different_parents_is_two_nodes(session, gtdb_source):
    """Uniqueness is per parent, not per name: a genus name reused under two
    families is two clades, and each keeps its own count."""
    other_family = "d__Bacteria;p__Bacillota;c__Bacilli;o__Bacillales;f__Otheraceae;g__Bacillus"
    rows = [
        _row("RS_GCF_000000020.1", f"{BACILLUS};s__Bacillus one", "RS_GCF_000000020.1"),
        _row("RS_GCF_000000021.1", f"{other_family};s__Bacillus two", "RS_GCF_000000021.1"),
    ]
    build_backbone(session, gtdb_source, rows)
    genera = session.query(BackboneNode).filter_by(name="Bacillus", rank=TaxonRank.GENUS).all()
    assert len(genera) == 2
    assert [g.genome_count for g in genera] == [1, 1]


def test_bad_rows_are_reported_and_skipped(session, gtdb_source):
    rows = [
        *ROWS,
        _row("", f"{STREP};s__Streptomyces alpha", ""),
        _row("RS_GCF_000000011.1", "", "RS_GCF_000000011.1"),
        _row("GB_GCF_000000001.1", f"{STREP};s__Streptomyces alpha", "RS_GCF_000000001.1"),  # duplicate
    ]
    report = build_backbone(session, gtdb_source, rows)
    assert [message for _, message in report.errors] == [
        "no accession",
        "no GTDB lineage",
        "accession appears twice",
    ]
    assert report.genomes_counted == 5
    assert _node(session, "Streptomyces alpha").genome_count == 2


def test_taxonomy_file_without_representative_column_is_refused(session, gtdb_source):
    """`*_taxonomy.tsv` has lineages but no representative flag, which would
    make the one-per-species default store everything or nothing."""
    with pytest.raises(ValueError, match="gtdb_genome_representative"):
        build_backbone(session, gtdb_source, [{"accession": "RS_GCF_1.1", "gtdb_taxonomy": STREP}])
    assert session.query(BackboneNode).count() == 0


def test_reloading_the_same_release_replaces_it(session, gtdb_source):
    build_backbone(session, gtdb_source, ROWS, all_genomes=True)
    build_backbone(session, gtdb_source, ROWS[:1])
    assert session.query(BackboneGenome).count() == 0
    assert session.query(BackboneNode).count() == 7
    assert _node(session, "Bacteria").genome_count == 1


def test_another_release_is_left_alone(session, gtdb_source):
    older = Source(id=uuid.uuid4(), name="GTDB", source_type=SourceType.REFERENCE_DATABASE, version="R10-RS226")
    session.add(older)
    session.commit()
    build_backbone(session, older, ROWS)
    build_backbone(session, gtdb_source, ROWS[:1])
    assert session.query(BackboneNode).filter_by(source_id=older.id).count() == 21
    assert session.query(BackboneNode).filter_by(source_id=gtdb_source.id).count() == 7


def test_backbone_never_touches_the_corpus(session, gtdb_source):
    """The whole point of the separate tables: nothing in `taxon` or `genome`
    is created, changed or removed by a backbone load."""
    ingest_gtdb_metadata(session, gtdb_source, read_gtdb_metadata_tsv(FIXTURES / "gtdb_metadata_test.tsv"))
    before = (
        sorted((t.name, t.rank.value, str(t.parent_id)) for t in session.query(Taxon)),
        sorted(g.accession for g in session.query(Genome)),
    )

    build_backbone(session, gtdb_source, ROWS, all_genomes=True)

    after = (
        sorted((t.name, t.rank.value, str(t.parent_id)) for t in session.query(Taxon)),
        sorted(g.accession for g in session.query(Genome)),
    )
    assert after == before


def test_cli_loads_several_files(tmp_path, monkeypatch, engine):
    from sqlalchemy.orm import sessionmaker

    from bgcscape.cli.main import app
    from bgcscape.db import session as db_session

    # The CLI builds its session from module-level globals; point them at
    # this test's database.
    monkeypatch.setattr(db_session, "_engine", engine)
    monkeypatch.setattr(db_session, "_SessionLocal", sessionmaker(bind=engine, future=True))

    columns = ("accession", "gtdb_taxonomy", "gtdb_genome_representative")

    def write(path: Path, rows: list[dict[str, str]]) -> Path:
        lines = ["\t".join(columns)] + ["\t".join(r[c] for c in columns) for r in rows]
        path.write_text("\n".join(lines) + "\n")
        return path

    bac = write(tmp_path / "bac120_metadata.tsv", ROWS[:4])
    ar = write(tmp_path / "ar53_metadata.tsv", ROWS[4:])

    result = CliRunner().invoke(app, ["ingest", "gtdb-backbone", str(bac), str(ar)])
    assert result.exit_code == 0, result.output
    assert "5 genomes counted, 4 species representatives recorded" in result.output
    assert "domain          2" in result.output
