"""Analysis coverage: what was examined, and what a zero therefore means.

The central test here is
`test_examined_empty_genome_is_distinguishable_from_unexamined_one` — the
whole reason `AnalysisRun` exists. Before it, those two genomes were the
same row, and the tool asserted that thousands of organisms produce nothing
having never looked at one of them.
"""
from __future__ import annotations

import uuid

import pytest

from bgcscape.coverage import (
    ABSENCE_NOTES,
    absence_note,
    AnalysisType,
    CoverageState,
    corpus_coverage_summary,
    coverage_states,
    examined_genome_ids,
    get_or_create_analysis_run,
    record_coverage,
    runs_covering,
)
from bgcscape.ingest.antismash import ingest_antismash_result
from bgcscape.models import (
    BGC,
    AnalysisRun,
    AnalysisRunCoverage,
    AssemblyLevel,
    BGCClass,
    EvidenceLevel,
    Genome,
)


def _genome(session, source, accession: str) -> Genome:
    genome = Genome(
        accession=accession,
        assembly_level=AssemblyLevel.COMPLETE_GENOME,
        is_mag=False,
        source_id=source.id,
        evidence_level=EvidenceLevel.OBSERVED_CURATED,
    )
    session.add(genome)
    session.flush()
    return genome


def _bgc(session, source, genome: Genome) -> BGC:
    bgc = BGC(
        genome_id=genome.id,
        bgc_class=BGCClass.NRPS,
        source_id=source.id,
        evidence_level=EvidenceLevel.PREDICTED,
    )
    session.add(bgc)
    session.flush()
    return bgc


# === THE POINT OF THE TABLE =================================================


def test_examined_empty_genome_is_distinguishable_from_unexamined_one(
    session, gtdb_source, antismash_tool_source
):
    """Two genomes, both with zero clusters, one a finding and one a gap.

    This is the distinction the data model could not previously represent.
    Both rows had zero `bgc` children; both rendered as "0 BGCs"; only one
    of them was a statement about biology.
    """
    surveyed = _genome(session, gtdb_source, "GCF_SURVEYED.1")
    never_looked_at = _genome(session, gtdb_source, "GCF_UNTOUCHED.1")

    run = get_or_create_analysis_run(
        session,
        source=antismash_tool_source,
        analysis_type=AnalysisType.BGC_DETECTION,
        tool="antiSMASH",
        tool_version="7.1.0",
    )
    record_coverage(session, run, surveyed, bgcs_recorded=0)
    session.commit()

    states = coverage_states(session)
    assert states[surveyed.id] is CoverageState.EXAMINED
    assert states[never_looked_at.id] is CoverageState.UNEXAMINED

    # And the difference is stated, not just typed.
    assert "none were found rather than that nobody looked" in ABSENCE_NOTES[
        CoverageState.EXAMINED
    ]
    assert "nothing has looked" in ABSENCE_NOTES[CoverageState.UNEXAMINED]


def test_curated_clusters_do_not_count_as_having_been_examined(session, mibig_source):
    """A MIBiG entry is a report that one cluster exists, not a survey.

    Treating it as coverage would manufacture exactly the denominator this
    table exists to stop assuming — and would turn "somebody once published
    three clusters" into "we looked and found three".
    """
    genome = _genome(session, mibig_source, "GCF_CURATED.1")
    _bgc(session, mibig_source, genome)
    session.commit()

    states = coverage_states(session)
    assert states[genome.id] is CoverageState.CURATED_ONLY
    assert examined_genome_ids(session) == set()
    assert "floor, not a census" in ABSENCE_NOTES[CoverageState.CURATED_ONLY]


def test_coverage_is_typed_so_clustering_does_not_imply_detection(
    session, gtdb_source, bigscape_tool_source
):
    """Being in a BiG-SCAPE run says nothing about whether anything ever
    looked for clusters on the genome."""
    genome = _genome(session, gtdb_source, "GCF_CLUSTERED_ONLY.1")
    run = get_or_create_analysis_run(
        session,
        source=bigscape_tool_source,
        analysis_type=AnalysisType.SEQUENCE_CLUSTERING,
        tool="BiG-SCAPE",
        tool_version="2.0.0",
    )
    record_coverage(session, run, genome, bgcs_recorded=0)
    session.commit()

    assert examined_genome_ids(session, AnalysisType.SEQUENCE_CLUSTERING) == {genome.id}
    assert examined_genome_ids(session, AnalysisType.BGC_DETECTION) == set()


# === ingestion wiring =======================================================


def test_antismash_ingest_records_coverage_even_with_no_regions(
    session, antismash_tool_source
):
    """The finding that had no way to be recorded.

    A run that examined a genome and found nothing produces no rows to
    ingest, so before coverage existed it left no trace at all — and 860
    real negative results out of 900 rendered as "never examined".
    """
    empty_result = {
        "version": "7.1.0",
        "taxon": "bacteria",
        "records": [{"id": "CONTIG_1", "description": "", "areas": []}],
    }
    report = ingest_antismash_result(
        session, antismash_tool_source, empty_result, genome_accession="GCF_EMPTY.1"
    )
    assert report.total_ok == 0

    genome = session.query(Genome).filter_by(accession="GCF_EMPTY.1").one()
    assert coverage_states(session)[genome.id] is CoverageState.EXAMINED

    (coverage,) = session.query(AnalysisRunCoverage).all()
    assert coverage.bgcs_recorded == 0, "zero here is the recorded finding, not a missing value"


def test_antismash_ingest_records_the_tool_version_it_actually_read(
    session, antismash_tool_source, tmp_path
):
    result = {
        "version": "8.0.1",
        "taxon": "fungi",
        "records": [{"id": "CONTIG_1", "description": "", "areas": []}],
    }
    ingest_antismash_result(
        session, antismash_tool_source, result, genome_accession="GCF_VER.1"
    )
    run = session.query(AnalysisRun).one()
    # Taken from the result, not from the Source row's label: the Source is
    # keyed on (name, version) and covers every run of that version, while
    # this is what the file itself says produced these calls.
    assert run.tool_version == "8.0.1"
    assert run.parameters == {"taxon": "fungi"}
    assert run.analysis_type is AnalysisType.BGC_DETECTION


def test_reingesting_the_same_run_extends_coverage_rather_than_duplicating_it(
    session, antismash_tool_source
):
    """Same idempotency discipline as every other loader in bgcscape.ingest."""
    result = {
        "version": "7.1.0",
        "taxon": "bacteria",
        "records": [{"id": "CONTIG_1", "description": "", "areas": []}],
    }
    for accession in ("GCF_ONE.1", "GCF_TWO.1", "GCF_ONE.1"):
        ingest_antismash_result(
            session, antismash_tool_source, result, genome_accession=accession
        )

    assert session.query(AnalysisRun).count() == 1, "one run, not one per genome"
    assert session.query(AnalysisRunCoverage).count() == 2, "two genomes, re-ingest is a no-op"


def test_two_runs_of_the_same_tool_are_separable_by_label(session, antismash_tool_source):
    kwargs = dict(
        source=antismash_tool_source,
        analysis_type=AnalysisType.BGC_DETECTION,
        tool="antiSMASH",
        tool_version="7.1.0",
    )
    first = get_or_create_analysis_run(session, label="batch-a", **kwargs)
    second = get_or_create_analysis_run(session, label="batch-b", **kwargs)
    again = get_or_create_analysis_run(session, label="batch-a", **kwargs)
    session.commit()

    assert first.id != second.id
    assert again.id == first.id


def test_a_declared_run_is_stored_more_weakly_than_a_derived_one(
    session, gtdb_source, antismash_tool_source
):
    """`record-analysis-run` asserts coverage; ingestion derives it. Both are
    worth having; a query must be able to tell them apart."""
    genome = _genome(session, gtdb_source, "GCF_DECLARED.1")
    declared = get_or_create_analysis_run(
        session,
        source=antismash_tool_source,
        analysis_type=AnalysisType.BGC_DETECTION,
        tool="antiSMASH",
        tool_version="7.1.0",
        label="declared",
        evidence_level=EvidenceLevel.HYPOTHESIZED,
    )
    record_coverage(session, declared, genome, bgcs_recorded=0)
    session.commit()

    assert declared.evidence_level is EvidenceLevel.HYPOTHESIZED
    assert coverage_states(session)[genome.id] is CoverageState.EXAMINED
    assert [r.id for r in runs_covering(session, genome.id)] == [declared.id]


# === corpus summary =========================================================


def test_corpus_summary_counts_all_three_states(
    session, gtdb_source, mibig_source, antismash_tool_source
):
    examined = _genome(session, gtdb_source, "GCF_EX.1")
    curated = _genome(session, mibig_source, "GCF_CU.1")
    _bgc(session, mibig_source, curated)
    _genome(session, gtdb_source, "GCF_UN.1")

    run = get_or_create_analysis_run(
        session,
        source=antismash_tool_source,
        analysis_type=AnalysisType.BGC_DETECTION,
        tool="antiSMASH",
        tool_version="7.1.0",
    )
    record_coverage(session, run, examined, bgcs_recorded=0)
    session.commit()

    assert corpus_coverage_summary(session) == {
        "examined": 1,
        "curated_only": 1,
        "unexamined": 1,
    }


def test_coverage_enum_is_enforced_by_the_database(session, antismash_tool_source):
    """The CHECK constraint, asserted from outside the ORM — the same way
    every other enum guard in this project is verified."""
    from sqlalchemy import text
    from sqlalchemy.exc import IntegrityError

    with pytest.raises(IntegrityError):
        session.execute(
            text(
                "INSERT INTO analysis_run "
                "(id, analysis_type, tool, tool_version, label, created_at, updated_at, "
                " source_id, evidence_level) "
                "VALUES (:id, 'not_a_real_type', 'x', '1', '', :now, :now, :src, 'computed')"
            ),
            {
                "id": uuid.uuid4().hex,
                "now": "2026-01-01 00:00:00",
                "src": antismash_tool_source.id.hex,
            },
        )
    session.rollback()


# --- the sentence a reader quotes must match the evidence behind it -------------
#
# `record-analysis-run` writes HYPOTHESIZED precisely because nobody parsed a
# result file; an operator asserted the run happened. Both kinds of run make a
# genome EXAMINED, and until `absence_note` existed both produced the identical
# sentence "its cluster count is a result" — the strongest reading of the
# weakest evidence the schema can hold.


def _covering_run(session, source, genome, *, evidence_level, tool_version):
    run = get_or_create_analysis_run(
        session,
        source=source,
        analysis_type=AnalysisType.BGC_DETECTION,
        tool="antiSMASH",
        tool_version=tool_version,
        evidence_level=evidence_level,
    )
    record_coverage(session, run, genome, bgcs_recorded=0)
    session.commit()
    return run


def test_declared_and_observed_runs_produce_different_prose(session, antismash_tool_source):
    declared = _genome(session, antismash_tool_source, "GCF_DECLARED001.1")
    observed = _genome(session, antismash_tool_source, "GCF_OBSERVED001.1")
    session.commit()

    _covering_run(
        session, antismash_tool_source, declared,
        evidence_level=EvidenceLevel.HYPOTHESIZED, tool_version="7.1.0",
    )
    _covering_run(
        session, antismash_tool_source, observed,
        evidence_level=EvidenceLevel.COMPUTED, tool_version="7.1.0-parsed",
    )

    declared_note = absence_note(session, declared.id, CoverageState.EXAMINED)
    observed_note = absence_note(session, observed.id, CoverageState.EXAMINED)

    assert declared_note != observed_note
    assert "DECLARED" in declared_note
    assert "rather than ingested from the tool's own output" in declared_note
    assert "none were found rather than that nobody looked" in observed_note
    assert "DECLARED" not in observed_note


def test_an_ingested_run_is_not_weakened_by_a_declaration_beside_it(session, antismash_tool_source):
    """A genome covered by both takes the stronger claim: adding an operator's
    declaration next to a parsed run does not downgrade the parsed run."""
    genome = _genome(session, antismash_tool_source, "GCF_BOTH0001.1")
    session.commit()

    _covering_run(
        session, antismash_tool_source, genome,
        evidence_level=EvidenceLevel.HYPOTHESIZED, tool_version="7.1.0",
    )
    _covering_run(
        session, antismash_tool_source, genome,
        evidence_level=EvidenceLevel.COMPUTED, tool_version="7.1.0-parsed",
    )

    note = absence_note(session, genome.id, CoverageState.EXAMINED)
    assert "none were found rather than that nobody looked" in note
    assert "DECLARED" not in note


def test_non_examined_states_keep_their_wording(session, antismash_tool_source):
    genome = _genome(session, antismash_tool_source, "GCF_NOTHING001.1")
    session.commit()
    assert absence_note(session, genome.id, CoverageState.UNEXAMINED) == ABSENCE_NOTES[CoverageState.UNEXAMINED]
    assert (
        absence_note(session, genome.id, CoverageState.CURATED_ONLY)
        == ABSENCE_NOTES[CoverageState.CURATED_ONLY]
    )
