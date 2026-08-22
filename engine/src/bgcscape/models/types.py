"""Cross-dialect column type helpers.

BGC-scape targets PostgreSQL in production but runs its automated test suite
against in-memory SQLite for speed and zero-setup CI. These helpers pick the
best native type per dialect while staying usable everywhere, so model code
never has to branch on which database it's talking to.
"""
from __future__ import annotations

from sqlalchemy import JSON
from sqlalchemy.dialects.postgresql import JSONB

# Generic JSON everywhere; upgrades to native JSONB specifically on Postgres
# (binary storage, indexable). SQLite gets SQLAlchemy's JSON emulation.
#
# KNOWN ALEMBIC QUIRK: `alembic revision --autogenerate` reliably renders
# this as `postgresql.JSONB(astext_type=Text())` in the generated migration
# WITHOUT adding `from sqlalchemy import Text` to that file's imports —
# confirmed to happen on every regeneration (Phase 1a and Phase 1b both hit
# it), not a one-off. After any autogenerate that touches a column using
# JSONVariant, check the new migration file's imports and add
# `from sqlalchemy import Text` by hand if it's missing, or the migration
# will fail with NameError the first time anyone runs `alembic upgrade`.
JSONVariant = JSON().with_variant(JSONB(), "postgresql")
