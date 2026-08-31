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
pip install -e ".[dev,api,export]"   # export extra needs libcairo2
docker compose -f ../docker-compose.yml up -d postgres   # or use SQLite, see .env.example
cp ../.env.example ../.env
alembic upgrade head

# 2. Ingest some data (curated test fixtures ship with the repo; real
#    MIBiG/GTDB downloads are a separate step — see docs/DATA_SOURCES.md)
bgcscape ingest gtdb tests/fixtures/gtdb_metadata_test.tsv
bgcscape ingest mibig tests/fixtures/mibig/
bgcscape ingest antismash tests/fixtures/antismash_test_result.json \
    --genome-accession GCF_TEST900001.1
bgcscape ingest bigscape tests/fixtures/mix_clustering_c0.3.tsv
# Real Gene Cluster Families come from BiG-FAM's precomputed families, read
# rather than clustered: `bgcscape ingest bigfam <a GCF's member export>`.
# Its members must be on genomes you have ingested, so it is not part of
# this fixture-only walkthrough — see DEPLOY.md, "Getting real GCFs".

# 3. API
uvicorn bgcscape.api.app:app --reload   # http://127.0.0.1:8000

# 4. Frontend (in another terminal)
cd ../web
npm install
cp .env.local.example .env.local
npm run dev                              # http://localhost:3000

# Tests
cd ../engine && pytest -v          # 287 tests (4 skip without Cairo)
cd ../web && npm test               # 122 tests

# Browser-level end-to-end tests (real Chromium). These cover the paths unit
# tests cannot reach — the export button's download, a real CORS preflight,
# middle-drag pan, semantic zoom. Both servers must already be running.
cd ../web && npx playwright install chromium   # once
npm run e2e                                    # 12 tests

# Run the engine suite against real Postgres instead of SQLite:
#   BGCSCAPE_TEST_DATABASE_URL=postgresql+psycopg://user:pass@localhost:5432/bgcscape_test pytest -v
# (Note the _TEST_ in the variable name — it's deliberately distinct from
# BGCSCAPE_DATABASE_URL, because the test fixture drops and recreates the
# schema between tests.)
```

## Status

Phases 1a/1b/1c (data model; MIBiG, GTDB, antiSMASH, BiG-SCAPE ingestion),
Phase 2 (visualization API + production frontend), Phase 3 (BGC-family
highlighting + comparative clade analysis), Phase 4 (publication-grade
SVG/PDF export with embedded, replayable view configs), and Phase 5 (user
uploads + BGC prioritization scoring) are complete and tested — **against
both SQLite and real PostgreSQL 16**.

**All five roadmap phases are now implemented.** See `PROGRESS.md` for
what remains genuinely unverified, and `ARCHITECTURE.md` for design
rationale.
