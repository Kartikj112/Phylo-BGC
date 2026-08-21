"""Environment-driven configuration.

A single `Settings` object, loaded once and cached. Reads from process
environment variables prefixed `BGCSCAPE_`, or from a `.env` file in the
current working directory. Production should set `BGCSCAPE_DATABASE_URL`
explicitly rather than relying on the SQLite default below, which exists
purely so the CLI/tests have a working fallback with zero setup.
"""
from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="BGCSCAPE_", env_file=".env", extra="ignore")

    database_url: str = "sqlite+pysqlite:///./bgcscape_dev.db"
    environment: str = "development"


@lru_cache
def get_settings() -> Settings:
    return Settings()
