# Phylo-BGC API image (FastAPI + the `api` and `export` extras).
#
# Ships with a REAL read-only dataset baked in: the GTDB genus backbone for
# the genera MIBiG covers, with all 2,526 active MIBiG reference clusters
# grafted onto it (`engine/gtdb_mibig_bundled.db`). Rebuild that file with:
#
#   python scripts/build_gtdb_subset.py --gtdb <bac120_metadata.tsv[.gz]> \
#       --mibig <mibig-json/data> --out data/gtdb_mibig_subset.tsv
#   BGCSCAPE_DATABASE_URL=sqlite+pysqlite:///./gtdb_mibig_bundled.db \
#       bgcscape init-db && bgcscape ingest gtdb data/gtdb_mibig_subset.tsv \
#       && bgcscape ingest mibig <mibig-json/data> && bgcscape graft-taxonomy
#
# For a larger tree or live data, point BGCSCAPE_DATABASE_URL at Postgres
# and run the full ingestion pipeline (antiSMASH + BiG-SCAPE) against it.

FROM python:3.13-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# libcairo2: runtime dependency of cairosvg (the `export` extra), used to
# render publication PDFs server-side.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libcairo2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install the package first so the dependency layer caches independently of
# source edits.
COPY pyproject.toml ./
COPY src ./src
RUN pip install ".[api,export]"

COPY . .

# Drop root.
#
# The container ran as root, which is the default and is worth changing here
# specifically: this image accepts file uploads from anonymous callers and
# parses them, so the blast radius of a parser bug is the difference between
# a compromised unprivileged process and a compromised root one.
#
# /app/data must be writable by that user, not just readable: uploads write
# to the SQLite file, and SQLite also needs to create `-wal`/`-journal`
# siblings in the same DIRECTORY, so chowning the file alone would fail at
# the first write with a confusing "readonly database".
#
# The user and directory are made BEFORE the database is written, and the
# database is then written as that user. Chowning it afterwards, as this
# file used to, copies the whole database into one more image layer, which
# measured 300 MB extra once the GTDB backbone was in it.
RUN useradd --create-home --uid 10001 bgcscape \
    && mkdir -p /app/data \
    && chown bgcscape:bgcscape /app/data
USER bgcscape

# Serve the pre-built GTDB + MIBiG database (checked in, see header), brought
# to the current schema. The bundled file is committed at whatever revision
# it was built with; without the upgrade, a newer API would query tables
# that file does not have (the backbone tables, most recently) and answer
# 500.
#
# Optional: bake the whole GTDB taxonomy into the image, which turns on the
# "All GTDB genomes" toggle. Off by default because it downloads ~300 MB
# from GTDB at build time, needs ~500 MB of memory to load, and grows the
# database from 17 MB to ~140 MB. Enable with
#   docker build --build-arg WITH_GTDB_BACKBONE=1 ...
# (or `docker compose build --build-arg WITH_GTDB_BACKBONE=1 api`).
#
# One RUN on purpose: every step that rewrites the database in a separate
# layer leaves a full copy of it behind in the image.
ENV BGCSCAPE_DATABASE_URL=sqlite+pysqlite:////app/data/bgcscape.db \
    BGCSCAPE_ENVIRONMENT=production
ARG WITH_GTDB_BACKBONE=0
RUN cp gtdb_mibig_bundled.db /app/data/bgcscape.db \
    && alembic upgrade head \
    && if [ "$WITH_GTDB_BACKBONE" = "1" ]; then \
        bgcscape fetch-gtdb-backbone --cache-dir /tmp/gtdb && rm -rf /tmp/gtdb; \
    fi

# Listen on $PORT when the platform provides one (Render sets it; Hugging
# Face Spaces expects 7860 — set a PORT=7860 Space variable), else 8080.
EXPOSE 8080
#
# Migrate again at start: a Docker volume mounted over /app/data keeps the
# database from whichever image first created it, so the build-time upgrade
# above never reaches it. A no-op when already current.
CMD ["sh", "-c", "alembic upgrade head && uvicorn bgcscape.api.app:app --host 0.0.0.0 --port ${PORT:-8080}"]
