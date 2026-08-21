"""Shared base for BGC-scape's Pydantic data contracts.

These are the engine's public "read" contracts: typed, validated shapes
that any consumer (CLI output, tests, a future API layer) can rely on
without touching SQLAlchemy directly. Write/input schemas are deliberately
not included in this chunk — their shape depends on source data formats
(MIBiG JSON, GTDB TSV columns, antiSMASH region JSON) that Phase 1b
(ingestion) will define alongside the parsers that produce them.
"""
from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class ORMReadModel(BaseModel):
    """Base class for Pydantic schemas built from ORM instances via
    `SomeSchema.model_validate(orm_instance)`.
    """

    model_config = ConfigDict(from_attributes=True)
