from __future__ import annotations

import uuid

from pydantic import BaseModel

from bgcscape.models.base import EvidenceLevel
from bgcscape.schemas.base import ORMReadModel, PersistedReadMixin


class BGCFamilyBase(BaseModel):
    label: str
    clustering_method: str | None = None
    clustering_cutoff: float | None = None
    representative_bgc_id: uuid.UUID | None = None
    source_id: uuid.UUID
    evidence_level: EvidenceLevel


class BGCFamilyCreate(BGCFamilyBase):
    pass


class BGCFamilyRead(BGCFamilyBase, PersistedReadMixin, ORMReadModel):
    pass


class BGCFamilyMembershipBase(BaseModel):
    bgc_id: uuid.UUID
    family_id: uuid.UUID
    similarity_score: float | None = None


class BGCFamilyMembershipCreate(BGCFamilyMembershipBase):
    pass


class BGCFamilyMembershipRead(BGCFamilyMembershipBase, PersistedReadMixin, ORMReadModel):
    pass
