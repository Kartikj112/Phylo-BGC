"""Phylogenetic trees and their nodes.

Trees carry provenance (which inference run produced them); individual nodes
inherit that provenance from their tree rather than duplicating it per row.
"""
from __future__ import annotations

import uuid

from sqlalchemy import Boolean, CheckConstraint, Float, ForeignKey, String, Text, Uuid
from sqlalchemy.orm import Mapped, mapped_column, relationship

from bgcscape.models.base import Base, ProvenanceMixin, TimestampMixin


class PhylogeneticTree(Base, TimestampMixin, ProvenanceMixin):
    """A single inferred (or imported) phylogenetic tree.

    Small/example trees can be stored inline via `newick_inline`; real
    reference trees (potentially tens of thousands of tips) should live in
    object storage and be referenced via `newick_storage_uri`, per the
    architecture's separation of relational metadata from bulk artifacts.
    At least one of the two must be set — enforced by a CHECK constraint,
    not just a docstring.
    """

    __tablename__ = "phylogenetic_tree"
    __table_args__ = (
        CheckConstraint(
            "newick_inline IS NOT NULL OR newick_storage_uri IS NOT NULL",
            name="ck_phylogenetic_tree_has_newick_source",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(256), nullable=False)
    inference_method: Mapped[str] = mapped_column(String(64), nullable=False)  # "IQ-TREE", "FastTree"
    alignment_method: Mapped[str | None] = mapped_column(String(64), nullable=True)  # "MAFFT"
    marker_set: Mapped[str | None] = mapped_column(String(128), nullable=True)  # "GTDB bac120"
    newick_inline: Mapped[str | None] = mapped_column(Text, nullable=True)
    newick_storage_uri: Mapped[str | None] = mapped_column(String(1024), nullable=True)

    nodes: Mapped[list["PhylogeneticNode"]] = relationship(back_populates="tree", cascade="all, delete-orphan")

    def __repr__(self) -> str:  # pragma: no cover
        return f"<PhylogeneticTree {self.name} ({self.inference_method})>"


class PhylogeneticNode(Base, TimestampMixin):
    """A node in a stored phylogenetic tree.

    Leaf nodes (`is_leaf=True`) typically reference a `Genome`; internal
    nodes represent inferred common ancestors and leave `genome_id` null.
    Node-level provenance is inherited from the parent `PhylogeneticTree`,
    so this table intentionally does not carry its own `ProvenanceMixin`.
    """

    __tablename__ = "phylogenetic_node"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    tree_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("phylogenetic_tree.id"), nullable=False, index=True)
    parent_node_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("phylogenetic_node.id"), nullable=True, index=True
    )
    genome_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("genome.id"), nullable=True, index=True)
    label: Mapped[str | None] = mapped_column(String(256), nullable=True)
    branch_length: Mapped[float | None] = mapped_column(Float, nullable=True)
    support_value: Mapped[float | None] = mapped_column(Float, nullable=True)
    is_leaf: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    tree: Mapped["PhylogeneticTree"] = relationship(back_populates="nodes")
    genome: Mapped["Genome | None"] = relationship(back_populates="phylogenetic_nodes")
    parent: Mapped["PhylogeneticNode | None"] = relationship(remote_side=[id], back_populates="children")
    children: Mapped[list["PhylogeneticNode"]] = relationship(back_populates="parent")

    def __repr__(self) -> str:  # pragma: no cover
        kind = "leaf" if self.is_leaf else "internal"
        return f"<PhylogeneticNode {kind} {self.label or self.id}>"
