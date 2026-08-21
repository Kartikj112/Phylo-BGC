from __future__ import annotations

import uuid

from bgcscape.models.base import EvidenceLevel
from bgcscape.models.taxonomy import TaxonRank
from bgcscape.schemas.base import ORMReadModel


class TaxonRead(ORMReadModel):
    id: uuid.UUID
    name: str
    rank: TaxonRank
    parent_id: uuid.UUID | None = None
    gtdb_taxonomy_string: str | None = None
    ncbi_taxid: int | None = None
    source_id: uuid.UUID
    evidence_level: EvidenceLevel
