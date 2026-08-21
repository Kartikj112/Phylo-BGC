from __future__ import annotations

import uuid
from collections.abc import Iterator

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from bgcscape.models import Base, Source, SourceType


@pytest.fixture()
def engine():
    eng = create_engine("sqlite+pysqlite:///:memory:", future=True)
    Base.metadata.create_all(eng)
    yield eng
    eng.dispose()


@pytest.fixture()
def session(engine) -> Iterator[Session]:
    with Session(engine, future=True) as sess:
        yield sess


@pytest.fixture()
def gtdb_source(session) -> Source:
    """A stand-in for a real GTDB `Source` row.

    NOTE: version/license here reflect what was verified as current for
    GTDB at the time this test suite was written (R11-RS232, CC BY-SA 4.0
    — see docs/DATA_SOURCES.md) but this fixture exists to exercise the
    schema, not to assert today's real GTDB state. Real ingestion code
    (Phase 1b) should fetch this from GTDB itself, not hardcode it.
    """
    src = Source(
        id=uuid.uuid4(),
        name="GTDB",
        source_type=SourceType.REFERENCE_DATABASE,
        version="R11-RS232",
        url="https://gtdb.ecogenomic.org",
        license="CC-BY-SA-4.0",
    )
    session.add(src)
    session.commit()
    return src


@pytest.fixture()
def mibig_source(session) -> Source:
    """A stand-in for a real MIBiG `Source` row. See `gtdb_source` note."""
    src = Source(
        id=uuid.uuid4(),
        name="MIBiG",
        source_type=SourceType.REFERENCE_DATABASE,
        version="4.0",
        url="https://mibig.secondarymetabolites.org",
        license="unrestricted for academic/commercial reuse (see docs/DATA_SOURCES.md)",
    )
    session.add(src)
    session.commit()
    return src


@pytest.fixture()
def antismash_tool_source(session) -> Source:
    """A stand-in for one specific antiSMASH tool run (a TOOL_RUN source,
    not a REFERENCE_DATABASE — antiSMASH output is PREDICTED, not curated).
    """
    src = Source(
        id=uuid.uuid4(),
        name="antiSMASH",
        source_type=SourceType.TOOL_RUN,
        version="7.1.0",
        url="https://antismash.secondarymetabolites.org",
        license="AGPL-3.0 (code); output is derived data, see docs/DATA_SOURCES.md",
    )
    session.add(src)
    session.commit()
    return src


@pytest.fixture()
def bigscape_tool_source(session) -> Source:
    """A stand-in for one specific BiG-SCAPE clustering run."""
    src = Source(
        id=uuid.uuid4(),
        name="BiG-SCAPE",
        source_type=SourceType.TOOL_RUN,
        version="2.0.0",
        url="https://github.com/medema-group/BiG-SCAPE",
    )
    session.add(src)
    session.commit()
    return src
