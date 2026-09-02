"""Analysis coverage: which tool looked at which genomes, and when.

## The question this table exists to answer

Before this existed, a genome with no BGCs and a genome nobody had ever run
antiSMASH on were the same row: both had zero `bgc` children and both
rendered as "0 BGCs". On a GTDB ingest that is thousands of organisms the
tool asserts produce nothing, having never looked at one of them. Absence is
half of what a comparative tool is for, and without a record of what was
examined, absence is uninterpretable.

`AnalysisRun` + `AnalysisRunCoverage` make it interpretable:

  * a genome an `AnalysisRun` covers has been **examined** — zero clusters is
    a real biological finding about that genome;
  * a genome no run covers is **unexamined** — zero clusters is a statement
    about this database, and the UI must say so rather than showing a count.

## Why this is not `Source`

`Source` already documents itself as "one specific antiSMASH/BiG-SCAPE
execution", so the overlap is worth naming. In practice it is not one:
`cli/main.py`'s `_get_or_create_source` keys on `(name, version)`, so a
single `Source` row covers *every* antiSMASH 7.1.0 run ever ingested here.
More importantly, `Source` names no genomes at all — and the genome set is
the entire point. An `AnalysisRun` therefore *points at* a `Source` (its
provenance, licence, citation) rather than replacing it.

## Why coverage is typed

"Covered by a BiG-SCAPE run" says nothing about whether anything ever looked
for clusters on that genome, and "covered by antiSMASH" says nothing about
whether its clusters were ever compared to anything. Those are two different
denominators, and the prioritization scorer needs them apart:
`class_rarity_in_clade` is relative to genomes **examined for clusters**,
`unclustered` is only answerable for genomes a **clustering** covered. So
`analysis_type` is required, and coverage is always read for one type.

## What deliberately creates no run

MIBiG ingestion. A MIBiG entry is a curated report that one cluster exists
in an organism; it is not a survey of that organism's genome. Recording a
`BGC_DETECTION` run for it would manufacture exactly the coverage this
module exists to stop assuming — and would make "we looked and found three"
out of "somebody once published three". A genome with curated clusters and
no covering run is a real third state, and `bgcscape.coverage` names it.
"""
from __future__ import annotations

import enum
import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, UniqueConstraint, Uuid
from sqlalchemy import Enum as SAEnum
from sqlalchemy.orm import Mapped, mapped_column, relationship

from bgcscape.models.base import Base, ProvenanceMixin, TimestampMixin
from bgcscape.models.types import JSONVariant


class AnalysisType(str, enum.Enum):
    """What an analysis run was looking for.

    BGC_DETECTION        A run that searched genomes for biosynthetic gene
                         clusters (antiSMASH). Coverage by one of these is
                         what makes "this genome has no BGCs" a finding
                         rather than a gap.

    SEQUENCE_CLUSTERING  A run that compared cluster sequences to each other
                         and grouped them (BiG-SCAPE, BiG-FAM). Coverage by
                         one of these is what makes "this cluster is in no
                         family" mean "nothing similar was found" rather
                         than "it was never compared".

    Deliberately not one flag. A genome can be covered by either, both, or
    neither, and the four states are all different.
    """

    BGC_DETECTION = "bgc_detection"
    SEQUENCE_CLUSTERING = "sequence_clustering"


class AnalysisRun(Base, TimestampMixin, ProvenanceMixin):
    """One execution of one analysis tool over a set of genomes.

    `evidence_level` here describes the **coverage claim**, not the findings:

      * `COMPUTED` — Phylo-BGC recorded this run from the tool's own output
        as it was ingested, so the genome set is derived, not asserted.
      * `HYPOTHESIZED` — a human declared the run (`bgcscape
        record-analysis-run`) without output for Phylo-BGC to read. Useful
        and often the only way to record a genome the tool found nothing in,
        but it is somebody's word, and a query can tell the two apart.
    """

    __tablename__ = "analysis_run"
    __table_args__ = (
        # Keyed the way ingestion re-finds it: re-running `ingest antismash`
        # over a second genome from the same run must extend that run's
        # coverage, not create a second run beside it. `label` is what
        # separates two genuinely different runs of the same tool version
        # (e.g. two cutoffs, two batches) and is part of the key for that
        # reason.
        UniqueConstraint(
            "source_id", "analysis_type", "tool", "tool_version", "label",
            name="uq_analysis_run_identity",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    analysis_type: Mapped[AnalysisType] = mapped_column(
        SAEnum(
            AnalysisType,
            native_enum=False,
            length=32,
            validate_strings=True,
            create_constraint=True,
            values_callable=lambda enum_cls: [member.value for member in enum_cls],
            name="ck_analysis_run_analysis_type_valid",
        ),
        nullable=False,
        index=True,
    )
    tool: Mapped[str] = mapped_column(String(64), nullable=False)  # "antiSMASH"
    tool_version: Mapped[str] = mapped_column(String(64), nullable=False)  # "7.1.0"
    #: The invocation's parameters — a BiG-SCAPE cutoff, an antiSMASH taxon
    #: or detection strictness. Stored because a re-run at different
    #: parameters is a materially different scientific claim over the same
    #: genomes, which is the same reasoning that keeps family labels
    #: cutoff-scoped (see ingest/bigscape.py).
    parameters: Mapped[dict | None] = mapped_column(JSONVariant, nullable=True)
    #: Distinguishes two runs of the same tool and version. Empty string
    #: rather than NULL: this is part of a UNIQUE key, and NULLs do not
    #: compare equal in SQL, so a nullable column here would let unlimited
    #: duplicate runs through the constraint that exists to prevent them.
    label: Mapped[str] = mapped_column(String(128), nullable=False, default="")
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    notes: Mapped[str | None] = mapped_column(String(1024), nullable=True)

    coverage: Mapped[list["AnalysisRunCoverage"]] = relationship(
        back_populates="run", cascade="all, delete-orphan"
    )

    def __repr__(self) -> str:  # pragma: no cover - debug helper
        return f"<AnalysisRun {self.tool} {self.tool_version} ({self.analysis_type.value})>"


class AnalysisRunCoverage(Base, TimestampMixin):
    """"This run examined this genome." The denominator, one row at a time.

    No `ProvenanceMixin`: a coverage row is a detail of the run that owns it,
    and inherits that run's source and evidence level — the same reasoning
    that keeps `PhylogeneticNode` and `BGCFamilyMembership` provenance-free.

    Explicit rows rather than a "covers everything from source X" flag. A
    full-GTDB antiSMASH run would write ~900k of them, which is a real cost
    — but a flag cannot express a run that covered most of a source, cannot
    be joined against, and answers "was THIS genome examined?" only by
    re-deriving what the flag once meant.
    """

    __tablename__ = "analysis_run_coverage"
    __table_args__ = (
        UniqueConstraint("analysis_run_id", "genome_id", name="uq_analysis_run_coverage"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    analysis_run_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("analysis_run.id"), nullable=False, index=True
    )
    genome_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("genome.id"), nullable=False, index=True
    )
    #: What this run contributed for this genome when it was ingested.
    #: Derivable by counting `bgc` rows in most cases, but not all: a run
    #: that reported five regions of which five failed to load is a
    #: different fact from a run that reported none, and only this column
    #: keeps them apart. **Zero here is the valuable case** — it is the
    #: literal record of "we looked and found nothing".
    bgcs_recorded: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    run: Mapped["AnalysisRun"] = relationship(back_populates="coverage")
    genome: Mapped["Genome"] = relationship()

    def __repr__(self) -> str:  # pragma: no cover
        return f"<AnalysisRunCoverage run={self.analysis_run_id} genome={self.genome_id}>"
