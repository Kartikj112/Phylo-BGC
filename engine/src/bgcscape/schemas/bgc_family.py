from __future__ import annotations

import uuid

from bgcscape.models.base import EvidenceLevel
from bgcscape.schemas.base import ORMReadModel


class BGCFamilyRead(ORMReadModel):
    id: uuid.UUID
    label: str
    clustering_method: str | None = None
    clustering_cutoff: float | None = None
    representative_bgc_id: uuid.UUID | None = None
    source_id: uuid.UUID
    evidence_level: EvidenceLevel


class BGCFamilyMembershipRead(ORMReadModel):
    id: uuid.UUID
    bgc_id: uuid.UUID
    family_id: uuid.UUID
    similarity_score: float | None = None
