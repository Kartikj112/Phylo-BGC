from __future__ import annotations

import os
import uuid
from collections.abc import Iterator

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session

from bgcscape.models import Base, Source, SourceType

# Tests default to in-memory SQLite (fast, zero setup). Setting
# BGCSCAPE_TEST_DATABASE_URL points the same suite at another database —
# which is how it gets run against real Postgres, both locally and in CI
# (.github/workflows/ci.yml).
#
# This exists because the CI workflow *claimed* to run the suite twice,
# once per dialect, by setting BGCSCAPE_DATABASE_URL — but conftest
# hardcoded SQLite, so that second job silently tested SQLite again.
# Verified fixed by actually running the suite against a real Postgres 16
# instance. A deliberately distinct variable name from the application's
# BGCSCAPE_DATABASE_URL, so that pointing the *app* at a database can
# never cause a test run to drop and recreate its tables.
_TEST_DATABASE_URL = os.environ.get("BGCSCAPE_TEST_DATABASE_URL")


@pytest.fixture(autouse=True)
def _clear_rate_limits():
    """Give every test its own rate-limit allowance.

    The API's limiter is per-process and the suite shares one app, so without
    this the twenty-first test to touch /api/v1/export or the upload route
    gets a 429 for the sins of the twenty before it — a failure with nothing
    to do with what that test asserts, and one that moves when tests are
    reordered. The limiter itself stays switched ON so the middleware under
    test is the one that ships; only the counters are reset.
    """
    from bgcscape.api.security import reset_rate_limits

    reset_rate_limits()
    yield
    reset_rate_limits()


@pytest.fixture()
def engine():
    if _TEST_DATABASE_URL:
        eng = create_engine(_TEST_DATABASE_URL, future=True)
        # A real server-backed database persists between tests, unlike a
        # fresh :memory: SQLite per test — so each test needs a clean slate
        # explicitly. DROP SCHEMA is used rather than drop_all() because it
        # also clears alembic_version, keeping a test-created schema from
        # colliding with a migration-created one in the same database.
        with eng.begin() as conn:
            conn.execute(text("DROP SCHEMA IF EXISTS public CASCADE"))
            conn.execute(text("CREATE SCHEMA public"))
    else:
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


def _pdf_renderer_available() -> bool:
    """Whether this machine can actually render PDF.

    The `export` extra's cairosvg needs the Cairo *system* library, which is
    not present on every developer machine (notably Windows) even when the
    Python package is installed. Tests that assert real PDF bytes can only
    fail for an environmental reason without it, which made the whole suite
    un-runnable off Docker. Skipping keeps the signal honest: they still run
    everywhere Cairo exists — CI and the production image — which is where
    the assertion actually matters.
    """
    try:
        from bgcscape.export.renderer import PdfRendererUnavailable, render_pdf

        render_pdf('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>')
    except PdfRendererUnavailable:
        return False
    except Exception:
        # Any other failure is a real bug in the renderer, not a missing
        # system library — let the test run and report it.
        return True
    return True


requires_pdf_renderer = pytest.mark.skipif(
    not _pdf_renderer_available(),
    reason="Cairo system library not installed; PDF rendering unavailable here",
)
