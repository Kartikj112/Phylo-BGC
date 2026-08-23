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
├── engine/                Python scientific engine: data model, ingestion,
│                           visualization API. No biological logic lives in
│                           the frontend; see ARCHITECTURE.md's separation
│                           of concerns.
├── web/                   Next.js/TypeScript/D3 frontend.
│   └── design-prototype/   Interactive design prototype (not production code).
├── docs/
│   └── DATA_SOURCES.md    Per-source licensing/versioning notes.
├── docker-compose.yml     Local Postgres + Adminer for development.
└── PROGRESS.md            Build status and phase tracker.
```

## Quickstart

```bash
# 1. Engine + database
cd engine
pip install -e ".[dev,api]"
docker compose -f ../docker-compose.yml up -d postgres   # or use SQLite, see .env.example
cp ../.env.example ../.env
alembic upgrade head

# 2. Ingest some data (curated test fixtures ship with the repo; real
#    MIBiG/GTDB downloads are a separate step — see docs/DATA_SOURCES.md)
bgcscape ingest gtdb tests/fixtures/gtdb_metadata_test.tsv
bgcscape ingest mibig tests/fixtures/

# 3. API
uvicorn bgcscape.api.app:app --reload   # http://127.0.0.1:8000

# 4. Frontend (in another terminal)
cd ../web
npm install
cp .env.local.example .env.local
npm run dev                              # http://localhost:3000

# Tests
cd ../engine && pytest -v          # 59 tests
cd ../web && npm test               # 24 tests
```

## Status

Phases 1a/1b (data model, MIBiG+GTDB ingestion) and Phase 2 (visualization
API + production frontend) are complete and tested. See `PROGRESS.md` for
the full phase tracker and what's next.
