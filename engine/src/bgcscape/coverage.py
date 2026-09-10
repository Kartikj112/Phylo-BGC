"""What was examined, by what, and what a zero therefore means.

The one place that turns `AnalysisRun` coverage into the question every
caller actually has: *is this genome's cluster count a finding, or a gap?*

Lives in the engine rather than the API or the frontend for the reason
ARCHITECTURE.md gives under "Separation of concerns" — deciding what a zero
means is scientific logic, and scientific logic is unit-tested here, not
re-derived in a React hook.

## The three states

`EXAMINED`      A `BGC_DETECTION` run covers this genome. Its cluster count
                is a real result, zero included. This is the only state in
                which absence is evidence.

`CURATED_ONLY`  Clusters are recorded for it, but no run covers it — the
                shape of every MIBiG-derived genome. Somebody published
                clusters found in this organism; nobody surveyed the genome.
                The count is a **floor**, not a census, and the difference
                between three and three-of-however-many is not knowable.

`UNEXAMINED`    No run, no clusters. The zero is about this database. This
                is the state the tool used to render identically to
                `EXAMINED` with a count of zero, which was the single
                falsest thing it said.

The same three-way split applies to sequence clustering, with
`AnalysisType.SEQUENCE_CLUSTERING` — "in no family" is only a finding for a
cluster whose genome a clustering run actually covered.
"""
from __future__ import annotations

import enum
import uuid
from datetime import datetime, timezone

from sqlalchemy import func
from sqlalchemy.orm import Session

from bgcscape.models import (
    BGC,
    AnalysisRun,
    AnalysisRunCoverage,
    AnalysisType,
    EvidenceLevel,
    Genome,
    Source,
)


class CoverageState(str, enum.Enum):
    EXAMINED = "examined"
    CURATED_ONLY = "curated_only"
    UNEXAMINED = "unexamined"


#: What a reader must be told alongside the count, per state. Phrased as
#: statements about the *database* where the database is what limits the
#: claim, because that is precisely the distinction being drawn.
ABSENCE_NOTES: dict[CoverageState, str] = {
    CoverageState.EXAMINED: (
        "This genome has been examined for biosynthetic gene clusters, so its cluster count is "
        "a result — including a count of zero, which means none were found rather than that "
        "nobody looked."
    ),
    # Keyed on state alone, and kept that way for callers that only have a
    # state. `absence_note` below is the one to use where a session is
    # available: EXAMINED covers two quite different situations, and this
    # entry silently describes only the stronger of them.
    CoverageState.CURATED_ONLY: (
        "Clusters are recorded for this genome from curated literature, but no cluster-detection "
        "run has covered it. The count is a floor, not a census: how many clusters this genome "
        "carries in total is not known here, and absence of a class says nothing."
    ),
    CoverageState.UNEXAMINED: (
        "No cluster-detection run has covered this genome, and no clusters are recorded for it. "
        "This is not a finding that it produces none — nothing has looked. Run antiSMASH over it "
        "(`bgcscape ingest antismash`) to make its cluster content answerable."
    ),
}


#: What EXAMINED means when the covering run was *declared* rather than
#: ingested. `record-analysis-run` writes `evidence_level=HYPOTHESIZED`
#: precisely because nobody here parsed the tool's output — an operator
#: asserted the run happened. The state is the same and the confidence is
#: not, and until this existed both produced the identical sentence "its
#: cluster count is a result", which is the strongest reading of the
#: weakest evidence the schema can hold.
DECLARED_EXAMINED_NOTE = (
    "A cluster-detection run over this genome has been DECLARED — recorded by an operator "
    "rather than ingested from the tool's own output, so nothing here parsed a result file. "
    "Its cluster count, including a count of zero, rests on that declaration: it is stronger "
    "than never having looked and weaker than a run whose output this database holds."
)


def absence_note(
    session: Session,
    genome_id: uuid.UUID,
    state: CoverageState,
) -> str:
    """The sentence to show beside this genome's cluster count.

    Keyed on the coverage state **and** the evidence behind it. A genome is
    EXAMINED whether its run was ingested from antiSMASH output or declared
    after the fact with `record-analysis-run`, and those are not the same
    claim. The evidence level was already in the API payload; it was absent
    from the one sentence a reader actually quotes.

    A genome covered by several runs takes the strongest: one real ingested
    run is not weakened by an additional declaration beside it.
    """
    if state is not CoverageState.EXAMINED:
        return ABSENCE_NOTES[state]

    levels = {
        run.evidence_level
        for run in runs_covering(session, genome_id)
        if run.analysis_type is AnalysisType.BGC_DETECTION
    }
    if levels and levels <= {EvidenceLevel.HYPOTHESIZED}:
        return DECLARED_EXAMINED_NOTE
    return ABSENCE_NOTES[CoverageState.EXAMINED]


def examined_genome_ids(
    session: Session, analysis_type: AnalysisType = AnalysisType.BGC_DETECTION
) -> set[uuid.UUID]:
    """Genome ids covered by at least one run of `analysis_type`.

    One query, returned as a set, because every caller wants membership
    tests over thousands of genomes rather than a row per genome.
    """
    rows = (
        session.query(AnalysisRunCoverage.genome_id)
        .join(AnalysisRun, AnalysisRun.id == AnalysisRunCoverage.analysis_run_id)
        .filter(AnalysisRun.analysis_type == analysis_type)
        .distinct()
    )
    return {row[0] for row in rows}


def genomes_with_bgcs(session: Session) -> set[uuid.UUID]:
    """Genome ids carrying at least one BGC, from whatever source."""
    return {row[0] for row in session.query(BGC.genome_id).distinct()}


def coverage_state(
    genome_id: uuid.UUID,
    examined: set[uuid.UUID],
    with_bgcs: set[uuid.UUID],
) -> CoverageState:
    """The state for one genome, given the two sets above.

    Takes the sets rather than a session so a caller building a whole tree
    computes them once — the tree builder runs this thousands of times per
    request.
    """
    if genome_id in examined:
        return CoverageState.EXAMINED
    if genome_id in with_bgcs:
        return CoverageState.CURATED_ONLY
    return CoverageState.UNEXAMINED


def coverage_states(session: Session) -> dict[uuid.UUID, CoverageState]:
    """State for every genome in the corpus."""
    examined = examined_genome_ids(session)
    with_bgcs = genomes_with_bgcs(session)
    return {
        genome_id: coverage_state(genome_id, examined, with_bgcs)
        for (genome_id,) in session.query(Genome.id)
    }


def corpus_coverage_summary(session: Session) -> dict[str, int]:
    """Counts per state over the whole corpus, for the provenance endpoint
    and figure captions. A figure that reports "1,542 genomes" without
    saying how many were ever examined is overstating its own basis."""
    states = coverage_states(session)
    return {
        "examined": sum(1 for s in states.values() if s is CoverageState.EXAMINED),
        "curated_only": sum(1 for s in states.values() if s is CoverageState.CURATED_ONLY),
        "unexamined": sum(1 for s in states.values() if s is CoverageState.UNEXAMINED),
    }


def runs_covering(session: Session, genome_id: uuid.UUID) -> list[AnalysisRun]:
    """Every run that examined this genome, newest first."""
    return (
        session.query(AnalysisRun)
        .join(AnalysisRunCoverage, AnalysisRunCoverage.analysis_run_id == AnalysisRun.id)
        .filter(AnalysisRunCoverage.genome_id == genome_id)
        .order_by(AnalysisRun.completed_at.desc().nullslast(), AnalysisRun.created_at.desc())
        .all()
    )


# ---------------------------------------------------------------------------
# Writing coverage
# ---------------------------------------------------------------------------


def get_or_create_analysis_run(
    session: Session,
    *,
    source: Source,
    analysis_type: AnalysisType,
    tool: str,
    tool_version: str,
    label: str = "",
    parameters: dict | None = None,
    evidence_level: EvidenceLevel = EvidenceLevel.COMPUTED,
    completed_at: datetime | None = None,
) -> AnalysisRun:
    """Find or create the run this ingestion belongs to.

    Keyed exactly as `AnalysisRun.__table_args__` is, so ingesting a second
    genome from the same run extends that run's coverage instead of
    creating a second run beside it — the same get-or-create discipline
    every loader in `bgcscape.ingest` follows.
    """
    run = (
        session.query(AnalysisRun)
        .filter_by(
            source_id=source.id,
            analysis_type=analysis_type,
            tool=tool,
            tool_version=tool_version,
            label=label,
        )
        .one_or_none()
    )
    if run is None:
        run = AnalysisRun(
            source_id=source.id,
            evidence_level=evidence_level,
            analysis_type=analysis_type,
            tool=tool,
            tool_version=tool_version,
            label=label,
            parameters=parameters,
            completed_at=completed_at or datetime.now(timezone.utc),
        )
        session.add(run)
        session.flush()
    elif parameters and not run.parameters:
        run.parameters = parameters
    return run


def record_coverage(
    session: Session,
    run: AnalysisRun,
    genome: Genome,
    *,
    bgcs_recorded: int,
) -> AnalysisRunCoverage:
    """Record that `run` examined `genome`. Idempotent.

    `bgcs_recorded` is refreshed on re-ingest rather than accumulated: a
    re-run over the same genome reports what that genome has now, and
    adding to a previous count would make a repeated ingest look like a
    richer genome. Same reasoning as `get_or_create_or_update`'s refresh
    semantics in ingest/_util.py.
    """
    coverage = (
        session.query(AnalysisRunCoverage)
        .filter_by(analysis_run_id=run.id, genome_id=genome.id)
        .one_or_none()
    )
    if coverage is None:
        coverage = AnalysisRunCoverage(
            analysis_run_id=run.id, genome_id=genome.id, bgcs_recorded=bgcs_recorded
        )
        session.add(coverage)
    else:
        coverage.bgcs_recorded = bgcs_recorded
    session.flush()
    return coverage


def bgc_count_for_genome(session: Session, genome_id: uuid.UUID) -> int:
    return int(
        session.query(func.count(BGC.id)).filter(BGC.genome_id == genome_id).scalar() or 0
    )
