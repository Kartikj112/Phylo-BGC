"""Biosynthetic gene clusters."""
from __future__ import annotations

import enum
import uuid

from sqlalchemy import ForeignKey, Integer, String, Uuid
from sqlalchemy import Enum as SAEnum
from sqlalchemy.orm import Mapped, mapped_column, relationship

from bgcscape.models.base import Base, ProvenanceMixin, TimestampMixin
from bgcscape.models.types import JSONVariant


class BGCClass(str, enum.Enum):
    """High-level biosynthetic class, aligned to antiSMASH's rule categories
    at the granularity Phylo-BGC needs for tree overlays. `subtype` on `BGC`
    carries finer detail (e.g. "type I PKS", "lanthipeptide") without
    forcing a combinatorial explosion of enum values here.
    """

    NRPS = "nrps"
    PKS = "pks"
    RIPP = "ripp"
    TERPENE = "terpene"
    SIDEROPHORE = "siderophore"
    SACCHARIDE = "saccharide"
    ALKALOID = "alkaloid"
    HYBRID = "hybrid"
    OTHER = "other"


class BGC(Base, TimestampMixin, ProvenanceMixin):
    """A single biosynthetic gene cluster called on one genome.

    `mibig_accession` links a BGC to its MIBiG entry when the cluster *is*
    (or is believed to be, per `evidence_level`) a known, characterized
    cluster. `raw_annotation` preserves the full predictor output (e.g. the
    antiSMASH region JSON) so downstream features — including a future
    multi-class model, see ARCHITECTURE.md — can be added without
    re-running the prediction tool.
    """

    __tablename__ = "bgc"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    genome_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("genome.id"), nullable=False, index=True)
    contig: Mapped[str | None] = mapped_column(String(128), nullable=True)
    start_coord: Mapped[int | None] = mapped_column(Integer, nullable=True)
    end_coord: Mapped[int | None] = mapped_column(Integer, nullable=True)
    strand: Mapped[str | None] = mapped_column(String(1), nullable=True)
    bgc_class: Mapped[BGCClass] = mapped_column(
        SAEnum(
            BGCClass,
            native_enum=False,
            length=16,
            validate_strings=True,
            create_constraint=True,
            values_callable=lambda enum_cls: [member.value for member in enum_cls],
            name="ck_bgc_bgc_class_valid",
        ),
        nullable=False,
        index=True,
    )
    subtype: Mapped[str | None] = mapped_column(String(128), nullable=True)
    predicted_by_tool: Mapped[str | None] = mapped_column(String(64), nullable=True)  # e.g. "antiSMASH 7.1.0"
    mibig_accession: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    # How an *external tool* refers to this exact BGC region, when that
    # reference isn't something Phylo-BGC itself assigned. Populated by
    # antiSMASH ingestion with antiSMASH's own per-region GenBank filename
    # stem ("{record_id}.region{NNN:03d}", confirmed against antiSMASH's
    # own source — see ingest/antismash.py), because BiG-SCAPE's output
    # identifies regions by that same filename convention, not by any ID
    # Phylo-BGC controls. Not DB-unique-constrained (see
    # ingest/bigscape.py's docstring for why), but is the real join key
    # BiG-SCAPE family ingestion looks BGCs up by.
    external_ref: Mapped[str | None] = mapped_column(String(256), nullable=True, index=True)
    raw_annotation: Mapped[dict | None] = mapped_column(JSONVariant, nullable=True)

    genome: Mapped["Genome"] = relationship(back_populates="bgcs")
    family_memberships: Mapped[list["BGCFamilyMembership"]] = relationship(
        back_populates="bgc", cascade="all, delete-orphan"
    )
    compound_links: Mapped[list["BGCCompoundLink"]] = relationship(back_populates="bgc", cascade="all, delete-orphan")
    #: How this cluster came to sit on `genome`, when something other than
    #: the source put it there — a MIBiG entry matched to GTDB's genome for
    #: the same organism. None for the ordinary case where the source named
    #: the genome itself (antiSMASH). See models/placement.py: a placement
    #: means "characterized in an organism this genome represents", never
    #: "sequenced from this assembly".
    placement: Mapped["BGCOrganismPlacement | None"] = relationship(
        back_populates="bgc", cascade="all, delete-orphan", uselist=False
    )

    def __repr__(self) -> str:  # pragma: no cover
        return f"<BGC {self.bgc_class.value} on genome {self.genome_id}>"
