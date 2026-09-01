"""Shared base for Phylo-BGC's Pydantic data contracts.

Each entity gets three schema classes:
  XBase    fields common to creating and reading (everything except the
           server-generated id/timestamps)
  XCreate  the input contract — currently identical to XBase, but kept as
           its own class so ingestion parsers have a stable name to target
           even if create-time validation ever needs to diverge from
           read-time shape
  XRead    XBase + id/created_at/updated_at, constructible from an ORM
           instance via `XRead.model_validate(orm_instance)`

Phase 1a shipped Read-only schemas because their shape was genuinely
unclear before any real ingestion format existed to design against. Phase
1b (ingestion parsers) is what actually consumes XCreate.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict


class ORMReadModel(BaseModel):
    """Base class for Pydantic schemas built from ORM instances via
    `SomeSchema.model_validate(orm_instance)`.
    """

    model_config = ConfigDict(from_attributes=True)


class PersistedReadMixin(BaseModel):
    """Fields present on every Read schema: the standard UUID primary key
    and TimestampMixin's created_at/updated_at, common to every ORM model.
    """

    id: uuid.UUID
    created_at: datetime
    updated_at: datetime

