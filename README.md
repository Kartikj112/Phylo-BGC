# BGC-scape

**Interactive exploration of biosynthetic diversity across the tree of life.**

BGC-scape connects four layers that are normally analyzed in disconnected
tools: organismal phylogeny → BGC repertoire → BGC families → known/putative
products. It is not another BGC predictor or clustering algorithm — it's the
exploration and interpretation layer over established tools and databases
(MIBiG, antiSMASH, GTDB, BiG-SCAPE, CORASON, MAFFT, IQ-TREE).

See `ARCHITECTURE.md` for design rationale and `PROGRESS.md` for what's
actually built vs. planned. **Read `PROGRESS.md` first if you're resuming
work on this project.**

## Repository layout

```
bgc-scape/
├── engine/          Python scientific engine — the data model + (future)
│                     ingestion/analysis pipelines. No web framework code
│                     lives here; see ARCHITECTURE.md §Separation of concerns.
├── web/              Frontend (Next.js/React/D3) — not yet built.
├── docs/
│   └── DATA_SOURCES.md   Per-source licensing/versioning notes.
├── docker-compose.yml    Local Postgres + Adminer for development.
└── PROGRESS.md           Build status and phase tracker.
```

## Quickstart (engine)

```bash
cd engine
pip install -e ".[dev]"

# Option A — real Postgres (recommended, matches production target):
docker compose -f ../docker-compose.yml up -d postgres
cp ../.env.example ../.env   # then edit if needed
alembic upgrade head

# Option B — zero-setup SQLite for a quick look:
export BGCSCAPE_DATABASE_URL="sqlite+pysqlite:///./bgcscape_dev.db"
bgcscape init-db

# Run the test suite (uses in-memory SQLite regardless of the above):
pytest -v
```

## Status

Phase 1a (core data model) is complete and tested. Everything else —
ingestion, API, frontend, novelty scoring, user uploads — is planned but not
yet built. Full detail in `PROGRESS.md`.
