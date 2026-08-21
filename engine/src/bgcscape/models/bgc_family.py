"""Gene Cluster Families (BiG-SCAPE-style groupings of similar BGCs)."""
from __future__ import annotations

import uuid

from sqlalchemy import Float, ForeignKey, String, UniqueConstraint, Uuid
from sqlalchemy.orm import Mapped, mapped_column, relationship

from bgcscape.models.base import Base, ProvenanceMixin, TimestampMixin


class BGCFamily(Base, TimestampMixin, ProvenanceMixin):
    """A Gene Cluster Family: a group of BGCs judged similar enough to share
    biosynthetic logic, typically produced by a BiG-SCAPE run.
    `evidence_level` on the family itself should normally be `COMPUTED`.
    """

    __tablename__ = "bgc_family"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    label: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
    clustering_method: Mapped[str | None] = mapped_column(String(64), nullable=True)  # "BiG-SCAPE 2.0"
    clustering_cutoff: Mapped[float | None] = mapped_column(Float, nullable=True)
    representative_bgc_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("bgc.id"), nullable=True)

    memberships: Mapped[list["BGCFamilyMembership"]] = relationship(
        back_populates="family", cascade="all, delete-orphan"
    )

    def __repr__(self) -> str:  # pragma: no cover
        return f"<BGCFamily {self.label}>"


class BGCFamilyMembership(Base, TimestampMixin):
    """Join table linking a `BGC` to a `BGCFamily`, with the pairwise/network
    similarity score that justified the assignment (e.g. BiG-SCAPE raw
    distance). Provenance is inherited from the owning `BGCFamily`.
    """

    __tablename__ = "bgc_family_membership"
    __table_args__ = (UniqueConstraint("bgc_id", "family_id", name="uq_bgc_family_membership"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    bgc_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("bgc.id"), nullable=False, index=True)
    family_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("bgc_family.id"), nullable=False, index=True)
    similarity_score: Mapped[float | None] = mapped_column(Float, nullable=True)

    bgc: Mapped["BGC"] = relationship(back_populates="family_memberships")
    family: Mapped["BGCFamily"] = relationship(back_populates="memberships")

    def __repr__(self) -> str:  # pragma: no cover
        return f"<BGCFamilyMembership bgc={self.bgc_id} family={self.family_id}>"
