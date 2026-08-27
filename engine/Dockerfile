# BGC-scape API image (FastAPI + the `api` and `export` extras).
#
# Ships with the synthetic demo corpus generated AT BUILD TIME by
# `bgcscape seed-demo` (deterministic — fixed seed), so the container is
# self-contained and needs no database service. The data is fabricated and
# labelled as such throughout the API (see cli/main.py seed-demo docstring).
# To serve real data instead, point BGCSCAPE_DATABASE_URL at a Postgres
# instance and run the ingestion pipeline against it.

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

# Generate the bundled demo database at the path the app will read at
# runtime. init-db creates the schema; seed-demo fills it (~80 genomes /
# ~400 BGCs / ~70 families).
ENV BGCSCAPE_DATABASE_URL=sqlite+pysqlite:////app/data/demo.db \
    BGCSCAPE_ENVIRONMENT=production
RUN mkdir -p /app/data \
    && bgcscape init-db \
    && bgcscape seed-demo

# Listen on $PORT when the platform provides one (Render sets it; Hugging
# Face Spaces expects 7860 — set a PORT=7860 Space variable), else 8080.
EXPOSE 8080
CMD ["sh", "-c", "uvicorn bgcscape.api.app:app --host 0.0.0.0 --port ${PORT:-8080}"]
