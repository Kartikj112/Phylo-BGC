"""Genome assemblies: the unit BGCs are called on and that phylogenetic
leaves ultimately represent.
"""
from __future__ import annotations

import enum
import uuid

from sqlalchemy import Boolean, Float, ForeignKey, Integer, String, Uuid
from sqlalchemy import Enum as SAEnum
from sqlalchemy.orm import Mapped, mapped_column, relationship

from bgcscape.models.base import Base, ProvenanceMixin, TimestampMixin
from bgcscape.models.types import JSONVariant


class AssemblyLevel(str, enum.Enum):
    COMPLETE_GENOME = "complete_genome"
    CHROMOSOME = "chromosome"
    SCAFFOLD = "scaffold"
    CONTIG = "contig"
    MAG = "mag"


class Genome(Base, TimestampMixin, ProvenanceMixin):
    """A single genome assembly.

    `taxon_id` is nullable because ingestion pipelines routinely encounter a
    genome before taxonomic classification (e.g. GTDB-Tk) has completed —
    modeling it as required would force ingestion to happen in a strict
    two-phase commit that real pipelines don't actually follow.
    """

    __tablename__ = "genome"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    accession: Mapped[str] = mapped_column(String(64), nullable=False, unique=True, index=True)
    taxon_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("taxon.id"), nullable=True, index=True)
    assembly_level: Mapped[AssemblyLevel] = mapped_column(
        SAEnum(AssemblyLevel, native_enum=False, length=32, validate_strings=True), nullable=False
    )
    is_mag: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    genome_size_bp: Mapped[int | None] = mapped_column(Integer, nullable=True)
    gc_content_pct: Mapped[float | None] = mapped_column(Float, nullable=True)
    completeness_pct: Mapped[float | None] = mapped_column(Float, nullable=True)
    contamination_pct: Mapped[float | None] = mapped_column(Float, nullable=True)
    sample_metadata: Mapped[dict | None] = mapped_column(JSONVariant, nullable=True)

    taxon: Mapped["Taxon | None"] = relationship(back_populates="genomes")
    bgcs: Mapped[list["BGC"]] = relationship(back_populates="genome", cascade="all, delete-orphan")
    phylogenetic_nodes: Mapped[list["PhylogeneticNode"]] = relationship(back_populates="genome")

    def __repr__(self) -> str:  # pragma: no cover
        return f"<Genome {self.accession}>"
