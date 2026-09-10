"""The typo that used to corrupt the corpus, pinned.

Every test here is a scenario that was run by hand against the shipped code
and did the wrong thing. They are written as the diagnosis found them, in
that order, so a regression reads as the original bug rather than as an
abstract assertion:

1. a mistyped accession MOVED three regions off the genome that held them
   and created an orphan stub;
2. an accession naming a different real genome did the same, silently;
3. `GCF_X` and `GCF_X.1` created two genomes for one assembly;
4. a declared run and a parsed run produced the identical sentence;
5. `/provenance` counted genomes no tree could show and still said "N of N
   examined".

The first two share a consequence worth stating once: the regions moved,
the `AnalysisRunCoverage` row did not, so the genome the run was actually
performed on reported "examined ... a count of zero, which means none were
found rather than that nobody looked". That sentence is the thing being
defended, and `test_typo_does_not_leave_the_real_genome_claiming_a_survey`
asserts it directly rather than only asserting row counts.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from bgcscape.coverage import CoverageState, absence_note, coverage_state, examined_genome_ids, genomes_with_bgcs
from bgcscape.ingest.antismash import (
    AntismashIngestConflict,
    ingest_antismash_result,
    load_antismash_result,
    parse_antismash_result,
)
from bgcscape.ingest.accession import GenomeMatch
from bgcscape.ingest.gtdb import ingest_gtdb_metadata, read_gtdb_metadata_tsv
from bgcscape.models import BGC, AnalysisRunCoverage, Genome

FIXTURES = Path(__file__).parent / "fixtures"
RESULT_PATH = FIXTURES / "antismash_test_result.json"
GTDB_PATH = FIXTURES / "gtdb_metadata_test.tsv"

REAL = "GCF_TEST900001.1"
OTHER_REAL = "GCF_TEST900002.1"
TYPO = "GCF_TEST9000001.1"  # one extra digit
NO_VERSION = "GCF_TEST900001"  # the same assembly, version dropped


def _raw() -> dict:
    return json.loads(RESULT_PATH.read_text())


@pytest.fixture()
def corpus(session, gtdb_source, antismash_tool_source):
    """Three GTDB genomes, with one antiSMASH run correctly ingested."""
    ingest_gtdb_metadata(session, gtdb_source, read_gtdb_metadata_tsv(GTDB_PATH))
    report = ingest_antismash_result(session, antismash_tool_source, _raw(), REAL)
    assert report.created == 3
    return antismash_tool_source


def _bgc_count(session, accession: str) -> int:
    genome = session.query(Genome).filter_by(accession=accession).one()
    return session.query(BGC).filter_by(genome_id=genome.id).count()


# --- 1 & 2: the reassignment itself ---------------------------------------------


def test_typo_is_refused_rather_than_creating_a_stub(session, corpus):
    with pytest.raises(AntismashIngestConflict) as exc:
        ingest_antismash_result(session, corpus, _raw(), TYPO, allow_create_genome=False)

    # The conflict is reported ahead of "no such accession", deliberately.
    # Both are true of a typo, but only this one names the genome the regions
    # are already on — which is almost always the one the operator meant.
    assert "already recorded on a different genome" in str(exc.value)
    assert REAL in str(exc.value)
    session.rollback()
    assert session.query(Genome).filter_by(accession=TYPO).one_or_none() is None


def test_an_unrecognised_accession_with_new_regions_says_so(session, gtdb_source, antismash_tool_source):
    """The other half of the typo case: nothing conflicts, so the refusal is
    about the accession itself and points at the way to proceed."""
    ingest_gtdb_metadata(session, gtdb_source, read_gtdb_metadata_tsv(GTDB_PATH))

    with pytest.raises(AntismashIngestConflict) as exc:
        ingest_antismash_result(
            session, antismash_tool_source, _raw(), TYPO, allow_create_genome=False
        )

    message = str(exc.value)
    assert "matches no ingested genome" in message
    assert "--create-genome" in message


def test_typo_does_not_move_the_regions(session, corpus):
    with pytest.raises(AntismashIngestConflict):
        ingest_antismash_result(session, corpus, _raw(), TYPO, allow_create_genome=False)
    session.rollback()

    assert _bgc_count(session, REAL) == 3


def test_typo_does_not_leave_the_real_genome_claiming_a_survey(session, corpus):
    """The consequence that made this worth fixing rather than documenting.

    Before the guard, the regions moved and the coverage row stayed, so the
    genome the run was performed on reported a survey that had found
    nothing. Asserting the sentence, not the row count, because the sentence
    is what a reader quotes.
    """
    with pytest.raises(AntismashIngestConflict):
        ingest_antismash_result(session, corpus, _raw(), TYPO, allow_create_genome=False)
    session.rollback()

    genome = session.query(Genome).filter_by(accession=REAL).one()
    state = coverage_state(genome.id, examined_genome_ids(session), genomes_with_bgcs(session))
    assert state is CoverageState.EXAMINED
    assert _bgc_count(session, REAL) == 3
    assert "none were found rather than that nobody looked" in absence_note(session, genome.id, state)


def test_wrong_but_real_accession_is_refused(session, corpus):
    with pytest.raises(AntismashIngestConflict) as exc:
        ingest_antismash_result(session, corpus, _raw(), OTHER_REAL)

    message = str(exc.value)
    assert "already recorded on a different genome" in message
    assert REAL in message  # names where they currently live
    session.rollback()

    assert _bgc_count(session, REAL) == 3
    assert _bgc_count(session, OTHER_REAL) == 0


def test_wrong_but_real_accession_records_no_coverage(session, corpus):
    """Refusing the regions is not enough on its own: the coverage row is
    what turns the mistake into a claim that a genome was surveyed."""
    with pytest.raises(AntismashIngestConflict):
        ingest_antismash_result(session, corpus, _raw(), OTHER_REAL)
    session.rollback()

    other = session.query(Genome).filter_by(accession=OTHER_REAL).one()
    assert session.query(AnalysisRunCoverage).filter_by(genome_id=other.id).count() == 0


# --- the escape hatch, and that it does not reintroduce the bug -----------------


def test_reassignment_is_possible_when_explicitly_authorised(session, corpus):
    report = ingest_antismash_result(session, corpus, _raw(), OTHER_REAL, allow_reassign=True)

    assert report.updated == 3
    assert _bgc_count(session, OTHER_REAL) == 3
    assert any("reassigned 3 region(s)" in note for note in report.notes)


def test_authorised_reassignment_withdraws_the_emptied_coverage_claim(session, corpus):
    """The escape hatch must not recreate the falsehood it exists beside.

    Moving every region off a genome leaves it examined-and-empty, which is
    the exact sentence the refusal defends against — so the coverage row
    written by the same mistaken ingest is withdrawn with them.
    """
    ingest_antismash_result(session, corpus, _raw(), OTHER_REAL, allow_reassign=True)

    real = session.query(Genome).filter_by(accession=REAL).one()
    assert session.query(AnalysisRunCoverage).filter_by(genome_id=real.id).count() == 0
    state = coverage_state(real.id, examined_genome_ids(session), genomes_with_bgcs(session))
    assert state is CoverageState.UNEXAMINED


# --- 3: the resolver ------------------------------------------------------------


def test_version_mismatch_resolves_instead_of_duplicating(session, corpus):
    before = session.query(Genome).count()
    report = ingest_antismash_result(session, corpus, _raw(), NO_VERSION)

    assert session.query(Genome).count() == before, "a second genome for the same assembly"
    assert session.query(Genome).filter_by(accession=NO_VERSION).one_or_none() is None
    assert _bgc_count(session, REAL) == 3
    assert report.updated == 3


def test_the_match_type_is_reported(session, corpus):
    report = ingest_antismash_result(session, corpus, _raw(), NO_VERSION)
    assert any(GenomeMatch.VERSION_INSENSITIVE.value in note for note in report.notes)


def test_antismash_first_ingestion_still_works_when_declared(session, antismash_tool_source):
    """The supported workflow the guard must not break: a genome this corpus
    has never seen, ingested from antiSMASH output alone."""
    report = ingest_antismash_result(
        session, antismash_tool_source, _raw(), "GCF_BRANDNEW999.1", allow_create_genome=True
    )

    assert report.created == 3
    genome = session.query(Genome).filter_by(accession="GCF_BRANDNEW999.1").one()
    assert session.query(BGC).filter_by(genome_id=genome.id).count() == 3
    assert any("created a new genome" in note for note in report.notes)


def test_load_reports_which_genome_it_resolved(session, corpus):
    parsed = parse_antismash_result(_raw(), REAL)
    _, report = load_antismash_result(session, parsed, corpus)
    assert any(f"resolved '{REAL}'" in note for note in report.notes)


def test_a_refusal_leaves_nothing_behind_even_without_a_rollback(session, corpus):
    """The refusal must be side-effect-free on its own.

    The guard originally created the genome and *then* checked for
    conflicts, so a refused ingest left a flushed stub in the session: a
    caller that caught the exception and committed anything afterwards
    persisted the orphan the refusal existed to prevent. Deliberately does
    not roll back, which is what makes the ordering observable.
    """
    with pytest.raises(AntismashIngestConflict):
        ingest_antismash_result(session, corpus, _raw(), TYPO, allow_create_genome=True)

    session.commit()  # a caller carrying on with unrelated work

    assert session.query(Genome).filter_by(accession=TYPO).one_or_none() is None
    assert _bgc_count(session, REAL) == 3
