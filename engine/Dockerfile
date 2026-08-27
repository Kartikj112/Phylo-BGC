# BGC-scape API image (FastAPI + the `api` and `export` extras).
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

# Serve the pre-built GTDB + MIBiG database (checked in, see header).
ENV BGCSCAPE_DATABASE_URL=sqlite+pysqlite:////app/data/bgcscape.db \
    BGCSCAPE_ENVIRONMENT=production
RUN mkdir -p /app/data && cp gtdb_mibig_bundled.db /app/data/bgcscape.db

# Listen on $PORT when the platform provides one (Render sets it; Hugging
# Face Spaces expects 7860 — set a PORT=7860 Space variable), else 8080.
EXPOSE 8080
CMD ["sh", "-c", "uvicorn bgcscape.api.app:app --host 0.0.0.0 --port ${PORT:-8080}"]
