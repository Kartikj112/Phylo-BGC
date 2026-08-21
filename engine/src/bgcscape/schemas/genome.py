from __future__ import annotations

import uuid

from bgcscape.models.base import EvidenceLevel
from bgcscape.models.genome import AssemblyLevel
from bgcscape.schemas.base import ORMReadModel


class GenomeRead(ORMReadModel):
    id: uuid.UUID
    accession: str
    taxon_id: uuid.UUID | None = None
    assembly_level: AssemblyLevel
    is_mag: bool
    genome_size_bp: int | None = None
    gc_content_pct: float | None = None
    completeness_pct: float | None = None
    contamination_pct: float | None = None
    sample_metadata: dict | None = None
    source_id: uuid.UUID
    evidence_level: EvidenceLevel
