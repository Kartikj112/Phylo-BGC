from __future__ import annotations

import uuid

from bgcscape.models.base import EvidenceLevel
from bgcscape.schemas.base import ORMReadModel


class CompoundRead(ORMReadModel):
    id: uuid.UUID
    name: str
    chemical_formula: str | None = None
    smiles: str | None = None
    compound_class: str | None = None
    mibig_compound_ref: str | None = None
    pubchem_cid: int | None = None
    source_id: uuid.UUID
    evidence_level: EvidenceLevel


class BGCCompoundLinkRead(ORMReadModel):
    id: uuid.UUID
    bgc_id: uuid.UUID
    compound_id: uuid.UUID
    reference: str | None = None
    source_id: uuid.UUID
    evidence_level: EvidenceLevel
