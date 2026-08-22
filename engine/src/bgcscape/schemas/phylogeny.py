from __future__ import annotations

import uuid

from pydantic import BaseModel, model_validator

from bgcscape.models.base import EvidenceLevel
from bgcscape.schemas.base import ORMReadModel, PersistedReadMixin


class PhylogeneticTreeBase(BaseModel):
    name: str
    inference_method: str
    alignment_method: str | None = None
    marker_set: str | None = None
    newick_inline: str | None = None
    newick_storage_uri: str | None = None
    source_id: uuid.UUID
    evidence_level: EvidenceLevel

    @model_validator(mode="after")
    def _require_a_newick_source(self) -> "PhylogeneticTreeBase":
        # Mirrors the DB-level CheckConstraint (models/phylogeny.py) at the
        # Pydantic layer, so ingestion code fails fast on bad input instead
        # of discovering it at flush time.
        if self.newick_inline is None and self.newick_storage_uri is None:
            raise ValueError("PhylogeneticTree needs newick_inline or newick_storage_uri (or both)")
        return self


class PhylogeneticTreeCreate(PhylogeneticTreeBase):
    pass


class PhylogeneticTreeRead(PhylogeneticTreeBase, PersistedReadMixin, ORMReadModel):
    pass


class PhylogeneticNodeBase(BaseModel):
    tree_id: uuid.UUID
    parent_node_id: uuid.UUID | None = None
    genome_id: uuid.UUID | None = None
    label: str | None = None
    branch_length: float | None = None
    support_value: float | None = None
    is_leaf: bool = False


class PhylogeneticNodeCreate(PhylogeneticNodeBase):
    pass


class PhylogeneticNodeRead(PhylogeneticNodeBase, PersistedReadMixin, ORMReadModel):
    pass
