from __future__ import annotations

import uuid

from pydantic import BaseModel

from bgcscape.models.base import EvidenceLevel
from bgcscape.models.bgc import BGCClass
from bgcscape.schemas.base import ORMReadModel, PersistedReadMixin


class BGCBase(BaseModel):
    genome_id: uuid.UUID
    contig: str | None = None
    start_coord: int | None = None
    end_coord: int | None = None
    strand: str | None = None
    bgc_class: BGCClass
    subtype: str | None = None
    predicted_by_tool: str | None = None
    mibig_accession: str | None = None
    external_ref: str | None = None
    raw_annotation: dict | None = None
    source_id: uuid.UUID
    evidence_level: EvidenceLevel


class BGCCreate(BGCBase):
    pass


class BGCRead(BGCBase, PersistedReadMixin, ORMReadModel):
    pass
