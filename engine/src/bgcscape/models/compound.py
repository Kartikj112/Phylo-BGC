"""Known or predicted natural products, and their links to BGCs."""
from __future__ import annotations

import uuid

from sqlalchemy import ForeignKey, Integer, String, Uuid
from sqlalchemy.orm import Mapped, mapped_column, relationship

from bgcscape.models.base import Base, ProvenanceMixin, TimestampMixin


class Compound(Base, TimestampMixin, ProvenanceMixin):
    """A known or predicted natural product associated with one or more BGCs."""

    __tablename__ = "compound"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(256), nullable=False, index=True)
    chemical_formula: Mapped[str | None] = mapped_column(String(128), nullable=True)
    smiles: Mapped[str | None] = mapped_column(String(2048), nullable=True)
    compound_class: Mapped[str | None] = mapped_column(String(128), nullable=True)
    mibig_compound_ref: Mapped[str | None] = mapped_column(String(64), nullable=True)
    pubchem_cid: Mapped[int | None] = mapped_column(Integer, nullable=True)

    bgc_links: Mapped[list["BGCCompoundLink"]] = relationship(back_populates="compound", cascade="all, delete-orphan")

    def __repr__(self) -> str:  # pragma: no cover
        return f"<Compound {self.name}>"


class BGCCompoundLink(Base, TimestampMixin, ProvenanceMixin):
    """Join table linking a `BGC` to a `Compound` it is known/predicted to
    produce. Carries its own provenance + evidence level because the same
    BGC-compound pair can be asserted with very different confidence — an
    experimentally verified MIBiG entry vs. a computational guess from
    domain architecture are both representable, distinctly.
    """

    __tablename__ = "bgc_compound_link"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    bgc_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("bgc.id"), nullable=False, index=True)
    compound_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("compound.id"), nullable=False, index=True)
    reference: Mapped[str | None] = mapped_column(String(512), nullable=True)

    bgc: Mapped["BGC"] = relationship(back_populates="compound_links")
    compound: Mapped["Compound"] = relationship(back_populates="bgc_links")

    def __repr__(self) -> str:  # pragma: no cover
        return f"<BGCCompoundLink bgc={self.bgc_id} compound={self.compound_id}>"
