"""Taxonomic hierarchy, GTDB-flavored by default but not GTDB-specific."""
from __future__ import annotations

import enum
import uuid

from sqlalchemy import ForeignKey, Integer, String, Uuid
from sqlalchemy import Enum as SAEnum
from sqlalchemy.orm import Mapped, mapped_column, relationship

from bgcscape.models.base import Base, ProvenanceMixin, TimestampMixin


class TaxonRank(str, enum.Enum):
    DOMAIN = "domain"
    PHYLUM = "phylum"
    CLASS = "class"
    ORDER = "order"
    FAMILY = "family"
    GENUS = "genus"
    SPECIES = "species"


class Taxon(Base, TimestampMixin, ProvenanceMixin):
    """A node in a taxonomic hierarchy (GTDB by default for bacteria/archaea).

    Self-referential tree via `parent_id`. A `Taxon` does not need to be a
    species-level leaf — genomes attach at whatever rank they were
    classified to (a MAG classified only to genus level still gets a Taxon
    row at genus rank; it just has no species-level child of its own yet).
    """

    __tablename__ = "taxon"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(256), nullable=False, index=True)
    rank: Mapped[TaxonRank] = mapped_column(
        SAEnum(
            TaxonRank,
            native_enum=False,
            length=16,
            validate_strings=True,
            create_constraint=True,
            values_callable=lambda enum_cls: [member.value for member in enum_cls],
            name="ck_taxon_rank_valid",
        ),
        nullable=False,
    )
    parent_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("taxon.id"), nullable=True, index=True)
    gtdb_taxonomy_string: Mapped[str | None] = mapped_column(String(512), nullable=True)
    ncbi_taxid: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)

    parent: Mapped["Taxon | None"] = relationship(remote_side=[id], back_populates="children")
    children: Mapped[list["Taxon"]] = relationship(back_populates="parent")
    genomes: Mapped[list["Genome"]] = relationship(back_populates="taxon")

    def __repr__(self) -> str:  # pragma: no cover
        return f"<Taxon {self.rank.value}:{self.name}>"
