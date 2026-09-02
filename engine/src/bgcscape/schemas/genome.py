from __future__ import annotations

import uuid

from pydantic import BaseModel

from bgcscape.models.base import EvidenceLevel
from bgcscape.models.genome import AssemblyLevel
from bgcscape.schemas.base import ORMReadModel, PersistedReadMixin


class GenomeBase(BaseModel):
    accession: str
    taxon_id: uuid.UUID | None = None
    assembly_level: AssemblyLevel
    is_mag: bool | None = None
    genome_size_bp: int | None = None
    gc_content_pct: float | None = None
    completeness_pct: float | None = None
    contamination_pct: float | None = None
    sample_metadata: dict | None = None
    gtdb_tip_accession: str | None = None
    source_id: uuid.UUID
    evidence_level: EvidenceLevel


class GenomeCreate(GenomeBase):
    pass


class GenomeRead(GenomeBase, PersistedReadMixin, ORMReadModel):
    pass
