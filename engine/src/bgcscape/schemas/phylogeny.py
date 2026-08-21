from __future__ import annotations

import uuid

from bgcscape.models.base import EvidenceLevel
from bgcscape.schemas.base import ORMReadModel


class PhylogeneticTreeRead(ORMReadModel):
    id: uuid.UUID
    name: str
    inference_method: str
    alignment_method: str | None = None
    marker_set: str | None = None
    newick_inline: str | None = None
    newick_storage_uri: str | None = None
    source_id: uuid.UUID
    evidence_level: EvidenceLevel


class PhylogeneticNodeRead(ORMReadModel):
    id: uuid.UUID
    tree_id: uuid.UUID
    parent_node_id: uuid.UUID | None = None
    genome_id: uuid.UUID | None = None
    label: str | None = None
    branch_length: float | None = None
    support_value: float | None = None
    is_leaf: bool
