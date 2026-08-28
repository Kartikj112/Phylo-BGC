"""Groupings of BGCs — sequence families (BiG-SCAPE GCFs) and compound groups.

Two scientifically different kinds of grouping share this table, and
`BGCFamily.kind` is what keeps them apart. See `FamilyKind` below: the
distinction is not cosmetic, and code that consumes families must decide
explicitly which kind it means.
"""
from __future__ import annotations

import enum
import uuid

from sqlalchemy import Float, ForeignKey, String, UniqueConstraint, Uuid
from sqlalchemy import Enum as SAEnum
from sqlalchemy.orm import Mapped, mapped_column, relationship

from bgcscape.models.base import Base, ProvenanceMixin, TimestampMixin


class FamilyKind(str, enum.Enum):
    """What kind of grouping a `BGCFamily` row represents.

    SEQUENCE_FAMILY   A Gene Cluster Family in the BiG-SCAPE / BiG-SLiCE
                      sense: BGCs grouped because their gene content and
                      domain architecture are similar. Produced by a real
                      clustering run over cluster sequences. "Not in a
                      family" here genuinely means "no sufficiently similar
                      cluster was found".

    COMPOUND_GROUP    BGCs grouped because MIBiG records them as producing
                      the same named compound. A curated experimental fact,
                      but NOT a sequence comparison — no sequences are
                      compared at all. "Not in a compound group" says
                      nothing whatever about sequence similarity.

    This column exists because conflating the two produces scientifically
    wrong output. The prioritization scorer's `unclustered`,
    `family_rarity` and `taxonomic_isolation` components are defined over
    sequence families; fed compound groups they emit sequence-similarity
    claims about a corpus on which no clustering has ever been run. That
    regression shipped once (see ARCHITECTURE.md → "Two kinds of grouping"),
    which is why the distinction is now a typed, CHECK-constrained column
    rather than a convention resting on the free-text `clustering_method`.
    """

    SEQUENCE_FAMILY = "sequence_family"
    COMPOUND_GROUP = "compound_group"


class BGCFamily(Base, TimestampMixin, ProvenanceMixin):
    """A group of BGCs. `kind` says which sort of grouping — see `FamilyKind`;
    the two are not interchangeable and must not be pooled.
    `evidence_level` on the family itself should normally be `COMPUTED`.
    """

    __tablename__ = "bgc_family"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    label: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
    kind: Mapped[FamilyKind] = mapped_column(
        SAEnum(
            FamilyKind,
            native_enum=False,
            length=32,
            validate_strings=True,
            create_constraint=True,
            values_callable=lambda enum_cls: [member.value for member in enum_cls],
            name="ck_bgc_family_kind_valid",
        ),
        nullable=False,
        index=True,
        default=FamilyKind.SEQUENCE_FAMILY,
    )
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
