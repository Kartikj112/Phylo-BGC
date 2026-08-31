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
    # A single deposited genomic locus (e.g. a MIBiG reference BGC record's
    # GenBank accession) rather than a full genome assembly. QC fields that
    # only make sense at assembly scale — completeness_pct, contamination_pct
    # — are not meaningful here and should be left null; genome_size_bp may
    # still be populated with the locus span.
    LOCUS = "locus"
    # No real assembly-level metadata is known — e.g. a Genome stub
    # created by antiSMASH ingestion (see ingest/antismash.py), which has
    # no way to know completeness/contamination/assembly-level facts about
    # a genome it wasn't given. Distinct from simply leaving the field
    # unset: this is an explicit statement that the value is unknown,
    # not an accidental omission. Defaulting silently to e.g. CONTIG in
    # that situation would be asserting something not actually known —
    # exactly the kind of thing this project's "never fabricate data"
    # principle exists to catch, even in a small case like this.
    UNKNOWN = "unknown"


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
        SAEnum(
            AssemblyLevel,
            native_enum=False,
            length=32,
            validate_strings=True,
            create_constraint=True,
            values_callable=lambda enum_cls: [member.value for member in enum_cls],
            name="ck_genome_assembly_level_valid",
        ),
        nullable=False,
    )
    is_mag: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    genome_size_bp: Mapped[int | None] = mapped_column(Integer, nullable=True)
    gc_content_pct: Mapped[float | None] = mapped_column(Float, nullable=True)
    completeness_pct: Mapped[float | None] = mapped_column(Float, nullable=True)
    contamination_pct: Mapped[float | None] = mapped_column(Float, nullable=True)
    sample_metadata: Mapped[dict | None] = mapped_column(JSONVariant, nullable=True)
    # Which tip of GTDB's reference tree (`bac120.tree` / `ar53.tree`) this
    # genome maps to, stored WITH GTDB's `RS_`/`GB_` prefix because that is
    # verbatim how the Newick file spells its tip labels — the value is a
    # foreign identifier, and rewriting it here would mean rewriting it back
    # at every use.
    #
    # This is NOT `accession` under another name, and the difference is the
    # whole reason the column exists. The metadata TSV describes 878,998
    # bacterial genomes but `bac120.tree` has only 189,801 tips: GTDB builds
    # its reference tree from species representatives alone. A genome that
    # is not a representative has no tip of its own and reaches the tree
    # only through the representative of its species, which GTDB names in
    # the metadata's `gtdb_genome_representative` column.
    #
    # Measured over the 991 assembly-accession genomes in the bundled
    # corpus: 651 are representatives and are their own tip, 340 are not
    # and reach a tip through this column, 0 reach neither. Without it a
    # third of the corpus would silently vanish from any tree-tip join —
    # not error, just quietly not be there, which is exactly the failure
    # mode this project's accession handling exists to prevent.
    #
    # Null means "no tip was resolved": a MIBiG locus accession (551 of the
    # 1,542 rows here) names a deposited sequence record, not an assembly,
    # and GTDB's tree has nothing to join it to.
    gtdb_tip_accession: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)

    taxon: Mapped["Taxon | None"] = relationship(back_populates="genomes")
    bgcs: Mapped[list["BGC"]] = relationship(back_populates="genome", cascade="all, delete-orphan")
    phylogenetic_nodes: Mapped[list["PhylogeneticNode"]] = relationship(back_populates="genome")

    def __repr__(self) -> str:  # pragma: no cover
        return f"<Genome {self.accession}>"
