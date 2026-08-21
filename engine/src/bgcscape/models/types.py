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
JSONVariant = JSON().with_variant(JSONB(), "postgresql")
