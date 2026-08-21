from __future__ import annotations

import uuid
from datetime import datetime

from bgcscape.models.source import SourceType
from bgcscape.schemas.base import ORMReadModel


class SourceRead(ORMReadModel):
    id: uuid.UUID
    name: str
    source_type: SourceType
    version: str | None = None
    url: str | None = None
    license: str | None = None
    citation: str | None = None
    retrieved_at: datetime | None = None
