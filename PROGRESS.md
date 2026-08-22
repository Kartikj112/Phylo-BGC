# BGC-scape — Build Progress

**Read this file first when resuming work in a new chunk.**

_Last updated: Chunk 3 (Phase 2, in progress) — 2026-08-22_

## Status at a glance

| Phase | Scope | Status |
|---|---|---|
| 1a | Core scientific data model | ✅ Done |
| 1b | Curated reference dataset ingestion (MIBiG, GTDB) | ✅ Done |
| 2 | Visualization API | ✅ **Done (this chunk)** |
| 2 | Design prototype (interactive, sample data) | ✅ **Done (this chunk)** |
| 2 | **Production Next.js frontend** | ⏭️ **Queued — the concrete next chunk** |
| 1c | antiSMASH ingestion + BiG-SCAPE family clustering | Not started |
| 3 | Layered BGC overlays, filtering, MIBiG/family integration | Not started |
| 4 | Comparative analysis + publication-grade export suite | Not started |
| 5 | User uploads + novelty prioritization scoring | Not started |

Phase 2 is split into three pieces on purpose: API (backend, testable the
same way every prior chunk has been) → design prototype (fast, interactive,
gets real feedback before committing to a production implementation) →
production frontend (the actual deliverable). The first two are done and
verified; the third is now unambiguous — no more "pick a direction" framing
like last chunk, this chunk locked in the direction and built toward it.

## What exists right now (additions since Chunk 2 in bold)

```
bgc-scape/
├── README.md, ARCHITECTURE.md, PROGRESS.md (this file)
├── docs/DATA_SOURCES.md
├── docker-compose.yml, .env.example, .github/workflows/ci.yml
├── engine/
│   ├── src/bgcscape/
│   │   ├── models/, schemas/, ingest/, db/, cli/    (unchanged this chunk)
│   │   ├── **api/**                                  **new this chunk**
│   │   │   ├── **schemas.py**                         UI-shaped response models
│   │   │   ├── **tree_builder.py**                    aggregates Taxon+Genome+BGC into one tree
│   │   │   └── **app.py**                              FastAPI: tree, genome/BGC detail, search
│   │   └── cli/main.py                                (unchanged)
│   └── tests/
│       ├── **test_api.py**                            **new — 11 tests, real TestClient**
│       └── (existing 48 tests, unchanged, still passing)
└── **web/**
    └── **design-prototype/**
        ├── **tree-explorer-demo.jsx**    interactive React/D3 prototype (see its README)
        └── **README.md**                  what it is, what was verified, real bug found
```

**59 engine tests total, all passing, zero warnings.** API endpoints were
also hit with `curl` against a live `uvicorn` process (not just
`TestClient`) — real HTTP, real ingested fixture data, correct responses.

## Real bugs found this chunk (full detail in ARCHITECTURE.md)

1. **SQLite `:memory:` is per-connection** — an API test fixture's seed
   data was invisible to the API's own DB session (different pooled
   connection). Fixed with `poolclass=StaticPool`.
2. **Hybrid-BGC filtering bug in the design prototype** — the class-count
   panel correctly attributed a hybrid (NRPS+PKS) BGC to both component
   classes, but the tree's dim/highlight logic checked the literal string
   `"hybrid"` against the active filter set, which can never match. A
   genome whose only NRPS activity came via a hybrid BGC would've been
   wrongly dimmed when filtering to NRPS-only. Fixed with a shared
   decomposition helper; locked in with a targeted logic test.
3. The design prototype's sample data initially had **no species-level
   taxon nodes at all** (genomes attached directly under genus) — meaning
   the italic-species-name styling (a real nomenclature convention) never
   actually rendered. Caught by an automated render-content check, not by
   inspection; fixed by restructuring the sample tree to match how the
   real data model actually works (species Taxon → genomes).

## Key design decisions made this chunk

1. **`bgcscape.api` is a separate, optional (`[api]` extra) subpackage** —
   keeps core engine/ingest/CLI free of a web-framework dependency.
2. **API response schemas are distinct from the engine's Create/Read
   schemas** — they're UI-shaped aggregates (rolled-up counts), not 1:1
   table mirrors.
3. **The tree API explicitly renders GTDB taxonomy, not a phylogeny** —
   said out loud in both code comments and this file, since nothing
   populates `PhylogeneticTree` yet and presenting one as the other would
   be a real epistemic-rigor violation, not just an imprecise label.
4. **Prototype before production frontend code** — an interactive,
   immediately-viewable design artifact, built and *verified* (real Babel
   transpile, real React SSR, targeted logic tests — not just "looks
   right in my head") before writing TypeScript against a real API.
5. **Visual direction follows the brief's explicit instruction** ("calm
   precise scientific instrument... Nature/Cell") rather than a generic
   template — see ARCHITECTURE.md for the specific choices and reasoning.

## Explicitly deferred / not yet built

The production Next.js frontend itself · antiSMASH/BiG-SCAPE ingestion ·
novelty scoring · user uploads · full per-field multi-source provenance ·
publication-grade export · Web Worker offloading (premature at current
data scale).

## Known constraints from this build environment

- Everything from Chunks 1–2 still applies (no direct network access to
  MIBiG/GTDB/NCBI from `bash_tool`; GitHub *is* reachable and was used
  again this chunk conceptually — the design prototype's sample data
  deliberately mirrors the real API shape rather than being ingested from
  anywhere).
- This sandbox has no browser or screenshot capability — the design
  prototype's *actual visual appearance* was never seen by anything in
  this build process, only its rendered HTML content and its pure-logic
  correctness. Look at it yourself before treating the visual direction as
  settled, not just the interaction logic.
- `uvicorn` was run manually as a background process to smoke-test the API
  over real HTTP, then killed — there's no persistent running service.

## How to resume

Say "continue" and this project will build the **production Next.js
frontend**: a TypeScript port of the prototype's D3 tree-layout logic,
wired to actually `fetch()` from `GET /api/v1/taxonomy-tree` instead of
reading hardcoded sample data, with a real `package.json`/build verified
to succeed in this sandbox the same way every other deliverable has been.
Look at `web/design-prototype/tree-explorer-demo.jsx` yourself first if
you want to redirect the visual/interaction direction before it's ported —
changing it now is a lot cheaper than changing it after.
