"""An identifier match is only as good as the identifier.

GTDB derives an assembly's lineage from the genome; NCBI's taxid is typed in
by whoever deposited it. Where the two name different phyla the assembly is
mislabelled, and a taxid match onto it is confidently wrong — so it is
demoted. These tests pin that rule, the deliberate exceptions to it, and the
re-grader that applies it to a database ingested before the column existed.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from bgcscape.ingest.gtdb import parse_gtdb_metadata_row, taxonomies_conflict
from bgcscape.ingest.link import (
    CONFLICTED_GENOME_CAVEAT,
    link_mibig_to_gtdb,
    recheck_placements,
)
from bgcscape.models import (
    BGC,
    BGCClass,
    EvidenceLevel,
    Genome,
    PlacementConfidence,
    Source,
    SourceType,
    Taxon,
    TaxonRank,
)
from bgcscape.models.genome import AssemblyLevel

_ACTINO = "d__Bacteria;p__Actinomycetota;c__Coriobacteriia;g__Anaerotardibacter"
_PROTEO = "d__Bacteria;p__Pseudomonadota;c__Gammaproteobacteria;g__Escherichia"
_MYXO = "d__Bacteria;p__Myxococcota;c__Polyangia;g__Sorangium"
_MYXO_A = "d__Bacteria;p__Myxococcota_A;c__Polyangia;g__Sorangium"


# --------------------------------------------------------------------------
# taxonomies_conflict: what counts as a disagreement
# --------------------------------------------------------------------------

def test_different_phyla_conflict() -> None:
    assert taxonomies_conflict(_ACTINO, _PROTEO) is True


def test_same_phylum_does_not_conflict() -> None:
    assert taxonomies_conflict(_PROTEO, _PROTEO) is False


def test_gtdb_suffix_split_is_not_a_conflict() -> None:
    """`Myxococcota_A` is GTDB resolving a phylum NCBI does not split. Flagging
    it would demote 41 correct placements in the shipped corpus."""
    assert taxonomies_conflict(_MYXO_A, _MYXO) is False


def test_candidatus_prefix_is_not_a_conflict() -> None:
    assert (
        taxonomies_conflict(
            "d__Bacteria;p__Tectomicrobia", "d__Bacteria;p__Candidatus Tectimicrobiota"
        )
        is False
    )


@pytest.mark.parametrize(
    "gtdb, ncbi",
    [
        (_ACTINO, None),
        (_ACTINO, ""),
        # NCBI knows the domain but assigned no phylum — a real shape in
        # bac120_metadata for "uncultured bacterium" submissions.
        (_ACTINO, "d__Bacteria;p__;c__"),
        (None, _PROTEO),
    ],
)
def test_unanswerable_comparison_is_none_not_false(gtdb, ncbi) -> None:
    """"Nobody could ask" must not be recorded as "asked, and they agree"."""
    assert taxonomies_conflict(gtdb, ncbi) is None


def test_gtdb_row_parses_the_conflict() -> None:
    parsed = parse_gtdb_metadata_row(
        {
            "accession": "GB_GCA_963591685.1",
            "gtdb_taxonomy": _ACTINO,
            "ncbi_taxonomy": _PROTEO,
            "checkm_completeness": "91.82",
        }
    )
    assert parsed.ncbi_taxonomy_conflict is True


def test_gtdb_row_without_ncbi_column_leaves_it_unchecked() -> None:
    parsed = parse_gtdb_metadata_row(
        {"accession": "GCF_000204155.1", "gtdb_taxonomy": _ACTINO}
    )
    assert parsed.ncbi_taxonomy_conflict is None


# --------------------------------------------------------------------------
# the placement rule
# --------------------------------------------------------------------------

def _fixture(session, *, conflict: bool | None):
    src = Source(name="MIBiG", source_type=SourceType.REFERENCE_DATABASE, version="4.0")
    session.add(src)
    session.flush()
    species = Taxon(
        name="Anaerotardibacter sp963591685",
        rank=TaxonRank.SPECIES,
        source_id=src.id,
        evidence_level=EvidenceLevel.OBSERVED_CURATED,
    )
    session.add(species)
    session.flush()
    gtdb_genome = Genome(
        accession="GCA_963591685.1",
        assembly_level=AssemblyLevel.SCAFFOLD,
        taxon_id=species.id,
        ncbi_taxonomy_conflict=conflict,
        source_id=src.id,
        evidence_level=EvidenceLevel.OBSERVED_CURATED,
    )
    locus = Genome(
        accession="AF000001.1",
        assembly_level=AssemblyLevel.LOCUS,
        source_id=src.id,
        evidence_level=EvidenceLevel.OBSERVED_CURATED,
    )
    session.add_all([gtdb_genome, locus])
    session.flush()
    bgc = BGC(
        genome_id=locus.id,
        contig="AF000001.1",
        bgc_class=BGCClass.RIPP,
        mibig_accession="BGC0000568",
        raw_annotation={"accession": "BGC0000568"},
        source_id=src.id,
        evidence_level=EvidenceLevel.OBSERVED_CURATED,
    )
    session.add(bgc)
    session.commit()
    return src, gtdb_genome, bgc


def test_taxid_match_onto_a_mislabelled_assembly_is_demoted(session) -> None:
    _src, _genome, bgc = _fixture(session, conflict=True)

    report = link_mibig_to_gtdb(
        session, [("BGC0000568", "GCA_963591685.1", "ncbi_taxid")]
    )

    session.refresh(bgc)
    assert report.demoted_placements == 1
    assert bgc.placement.confidence is PlacementConfidence.WEAK
    assert bgc.placement.caveat == CONFLICTED_GENOME_CAVEAT
    # The method is still recorded truthfully — what changed is what the
    # match is worth, not what was done.
    assert bgc.placement.method.value == "ncbi_taxid"


def test_taxid_match_onto_a_clean_assembly_stays_strong(session) -> None:
    _src, _genome, bgc = _fixture(session, conflict=False)

    report = link_mibig_to_gtdb(
        session, [("BGC0000568", "GCA_963591685.1", "ncbi_taxid")]
    )

    session.refresh(bgc)
    assert report.demoted_placements == 0
    assert bgc.placement.confidence is PlacementConfidence.STRONG


def test_unchecked_assembly_is_not_demoted_on_suspicion(session) -> None:
    """NULL means nobody looked. The coverage model treats an unexamined
    genome as unexamined rather than empty; this is the same rule."""
    _src, _genome, bgc = _fixture(session, conflict=None)

    report = link_mibig_to_gtdb(
        session, [("BGC0000568", "GCA_963591685.1", "ncbi_taxid")]
    )

    session.refresh(bgc)
    assert report.demoted_placements == 0
    assert bgc.placement.confidence is PlacementConfidence.STRONG


def test_gtdb_species_match_is_untouched_by_a_conflict(session) -> None:
    """`gtdb_species` matches on a name GTDB itself controls, so a wrong NCBI
    label cannot have misled it."""
    _src, _genome, bgc = _fixture(session, conflict=True)

    report = link_mibig_to_gtdb(
        session, [("BGC0000568", "GCA_963591685.1", "gtdb_species")]
    )

    session.refresh(bgc)
    assert report.demoted_placements == 0
    assert bgc.placement.confidence is PlacementConfidence.MODERATE


# --------------------------------------------------------------------------
# the re-grader
# --------------------------------------------------------------------------

def _metadata_tsv(tmp_path: Path, *, gtdb: str, ncbi: str) -> Path:
    path = tmp_path / "bac120_metadata.tsv"
    path.write_text(
        "accession\tgtdb_taxonomy\tncbi_taxonomy\n"
        f"GB_GCA_963591685.1\t{gtdb}\t{ncbi}\n",
        encoding="utf-8",
    )
    return path


def test_recheck_demotes_placements_made_before_the_column_existed(
    session, tmp_path: Path
) -> None:
    _src, genome, bgc = _fixture(session, conflict=None)
    link_mibig_to_gtdb(session, [("BGC0000568", "GCA_963591685.1", "ncbi_taxid")])
    session.refresh(bgc)
    assert bgc.placement.confidence is PlacementConfidence.STRONG

    report = recheck_placements(
        session, _metadata_tsv(tmp_path, gtdb=_ACTINO, ncbi=_PROTEO)
    )

    session.refresh(bgc)
    session.refresh(genome)
    assert report.genomes_conflicted == 1
    assert report.demoted == 1
    assert genome.ncbi_taxonomy_conflict is True
    assert bgc.placement.confidence is PlacementConfidence.WEAK


def test_recheck_is_idempotent(session, tmp_path: Path) -> None:
    _src, _genome, bgc = _fixture(session, conflict=None)
    link_mibig_to_gtdb(session, [("BGC0000568", "GCA_963591685.1", "ncbi_taxid")])
    metadata = _metadata_tsv(tmp_path, gtdb=_ACTINO, ncbi=_PROTEO)

    recheck_placements(session, metadata)
    second = recheck_placements(session, metadata)

    session.refresh(bgc)
    assert second.demoted == 0
    assert second.restored == 0
    assert bgc.placement.confidence is PlacementConfidence.WEAK


def test_recheck_restores_a_placement_when_the_conflict_is_resolved(
    session, tmp_path: Path
) -> None:
    """A one-way ratchet would leave a corrected assembly penalised forever —
    the mirror of the bug this rule fixes."""
    _src, _genome, bgc = _fixture(session, conflict=True)
    link_mibig_to_gtdb(session, [("BGC0000568", "GCA_963591685.1", "ncbi_taxid")])
    session.refresh(bgc)
    assert bgc.placement.confidence is PlacementConfidence.WEAK

    report = recheck_placements(
        session, _metadata_tsv(tmp_path, gtdb=_ACTINO, ncbi=_ACTINO)
    )

    session.refresh(bgc)
    assert report.restored == 1
    assert bgc.placement.confidence is PlacementConfidence.STRONG
    assert bgc.placement.caveat != CONFLICTED_GENOME_CAVEAT


def test_recheck_reports_genomes_the_file_never_mentions(
    session, tmp_path: Path
) -> None:
    """A genome absent from the metadata file stays unchecked, and is counted
    as such rather than being quietly cleared."""
    _fixture(session, conflict=None)
    path = tmp_path / "empty.tsv"
    path.write_text("accession\tgtdb_taxonomy\tncbi_taxonomy\n", encoding="utf-8")

    report = recheck_placements(session, path)

    assert report.genomes_seen == 0
    assert report.genomes_unchecked == 2  # the GTDB genome and the locus stub
    assert all(
        genome.ncbi_taxonomy_conflict is None for genome in session.query(Genome).all()
    )
