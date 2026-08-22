from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel

from bgcscape.models.source import SourceType
from bgcscape.schemas.base import ORMReadModel, PersistedReadMixin


class SourceBase(BaseModel):
    name: str
    source_type: SourceType
    version: str | None = None
    url: str | None = None
    license: str | None = None
    citation: str | None = None
    retrieved_at: datetime | None = None


class SourceCreate(SourceBase):
    pass


class SourceRead(SourceBase, PersistedReadMixin, ORMReadModel):
    pass
