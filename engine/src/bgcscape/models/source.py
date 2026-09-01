"""The `Source` table is the root of Phylo-BGC's provenance graph.

Every row governed by `ProvenanceMixin` points back to exactly one `Source`,
which records what produced it (a reference database, a specific tool run,
or a user upload), which version, and under what license/citation. See
docs/DATA_SOURCES.md for the human-readable per-source licensing notes this
table is meant to operationalize.
"""
from __future__ import annotations

import enum
import uuid
from datetime import datetime

from sqlalchemy import DateTime, String, Uuid
from sqlalchemy import Enum as SAEnum
from sqlalchemy.orm import Mapped, mapped_column

from bgcscape.models.base import Base, TimestampMixin


class SourceType(str, enum.Enum):
    """Broad category of provenance."""

    REFERENCE_DATABASE = "reference_database"  # e.g. MIBiG, GTDB, NCBI
    TOOL_RUN = "tool_run"  # e.g. one specific antiSMASH/BiG-SCAPE/IQ-TREE execution
    USER_UPLOAD = "user_upload"  # a user-supplied genome/MAG or annotation


class Source(Base, TimestampMixin):
    """A single, versioned origin of data ingested into Phylo-BGC.

    Examples::

        Source(name="MIBiG", source_type=REFERENCE_DATABASE, version="4.0")
        Source(name="antiSMASH", source_type=TOOL_RUN, version="7.1.0")
        Source(name="GTDB", source_type=REFERENCE_DATABASE, version="R11-RS232")
    """

    __tablename__ = "source"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
    source_type: Mapped[SourceType] = mapped_column(
        SAEnum(
            SourceType,
            native_enum=False,
            length=32,
            validate_strings=True,
            create_constraint=True,
            values_callable=lambda enum_cls: [member.value for member in enum_cls],
            name="ck_source_source_type_valid",
        ),
        nullable=False,
    )
    version: Mapped[str | None] = mapped_column(String(64), nullable=True)
    url: Mapped[str | None] = mapped_column(String(512), nullable=True)
    license: Mapped[str | None] = mapped_column(String(128), nullable=True)
    citation: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    retrieved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    def __repr__(self) -> str:  # pragma: no cover - debug helper
        return f"<Source {self.name} {self.version or ''} ({self.source_type.value})>"
