"""Alembic environment.

The database URL is pulled from `bgcscape.config.Settings` (i.e. the
`BGCSCAPE_DATABASE_URL` env var / `.env` file) rather than hardcoded into
`alembic.ini`, so the same migration set targets dev SQLite, local Postgres,
and production Postgres without editing this file.
"""
from __future__ import annotations

import sys
from logging.config import fileConfig
from pathlib import Path

from alembic import context
from sqlalchemy import engine_from_config, pool

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import bgcscape.models  # noqa: E402, F401 - registers all mapped classes
from bgcscape.config import get_settings  # noqa: E402
from bgcscape.models.base import Base  # noqa: E402

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def get_url() -> str:
    return get_settings().database_url


def run_migrations_offline() -> None:
    url = get_url()
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        render_as_batch=url.startswith("sqlite"),
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    configuration = config.get_section(config.config_ini_section) or {}
    configuration["sqlalchemy.url"] = get_url()
    connectable = engine_from_config(
        configuration,
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        # SQLite has no real ALTER TABLE DROP/ADD CONSTRAINT — Alembic's
        # autogenerate needs batch mode (recreate-table-and-copy) to
        # actually implement a constraint change on SQLite at all.
        # Without this, a real bug this project's own migration caught:
        # autogenerate happily emits plain op.drop_constraint() calls that
        # don't work on SQLite, and — worse — doesn't recreate the
        # constraint afterward in upgrade() at all, silently discarding
        # every CHECK constraint's enforcement rather than erroring. Only
        # matters for SQLite; Postgres supports real ALTER TABLE ADD/DROP
        # CONSTRAINT and doesn't need batch mode.
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            render_as_batch=connection.dialect.name == "sqlite",
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
