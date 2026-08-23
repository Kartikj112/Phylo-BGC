# BGC-scape — Build Progress

**Read this file first when resuming work in a new chunk.**

_Last updated: Chunk 4 (Phase 2 complete) — 2026-08-23_

## Status at a glance

| Phase | Scope | Status |
|---|---|---|
| 1a | Core scientific data model | ✅ Done |
| 1b | Curated reference dataset ingestion (MIBiG, GTDB) | ✅ Done |
| 2 | Visualization API | ✅ Done |
| 2 | Design prototype (interactive, sample data) | ✅ Done |
| 2 | **Production Next.js frontend** | ✅ **Done (this chunk)** |
| 1c | antiSMASH ingestion + BiG-SCAPE family clustering | ⏭️ Next candidate |
| 3 | BGC-family highlighting, comparative clade analysis | Not started |
| 4 | Publication-grade export suite | Not started |
| 5 | User uploads + novelty prioritization scoring | Not started |

**MVP v1 is now fully end-to-end**: real ingestion (MIBiG + GTDB) → real
API → real, running, tested frontend that renders an actual taxonomy tree
with BGC-class overlays, search, filtering, and a detail panel. This was
verified with both servers running simultaneously against real ingested
data — not just "the pieces exist," but "they actually talk to each other
correctly," including a real CORS check.

## What exists right now (additions since Chunk 3 in bold)

```
bgc-scape/
├── README.md, ARCHITECTURE.md, PROGRESS.md (this file) — all updated
├── engine/                                    (unchanged from Chunk 3)
│   └── src/bgcscape/cli/main.py                + **dump-openapi-schema command**
└── web/
    ├── design-prototype/                       (unchanged — the prototype
    │                                             this chunk ported from)
    ├── **package.json, tsconfig.json, next.config.mjs,**
    ├── **tailwind.config.ts, postcss.config.mjs, vitest.config.ts**
    ├── **src/fonts/**                           **self-hosted IBM Plex woff2 files**
    ├── **src/app/**
    │   ├── **layout.tsx**                        root layout, next/font/local
    │   ├── **page.tsx**                          main page, wires everything together
    │   └── **globals.css**
    ├── **src/components/**
    │   ├── **Header.tsx**                        wordmark + search
    │   ├── **ClassFilterRail.tsx**                BGC class filter checkboxes
    │   ├── **DetailPanel.tsx**                    fetches genome/BGC detail on selection
    │   └── **TreeCanvas.tsx**                     D3 tree rendering (the core visualization)
    ├── **src/hooks/useTaxonomyTree.ts**           data-fetching hook
    └── **src/lib/**
        ├── **api-schema.generated.ts**            generated from real OpenAPI, not hand-written
        ├── **api-types.ts**                       convenience aliases + DisplayNode union
        ├── **api-client.ts**                      typed fetch wrapper
        ├── **colors.ts**                           design tokens, ported from the prototype
        ├── **tree-logic.ts**                       pure tree/filter logic, ported + improved
        ├── **tree-logic.test.ts**                  **24 tests**, incl. the hybrid-filter regression
        └── **test-fixtures.ts**                    test data matching the real API shape
```

**59 engine tests + 24 frontend tests = 83 tests total, all passing.**

## What was actually verified this chunk, in order

Every step below was run for real, not assumed:

1. `npm install` — resolved to 0 vulnerabilities after upgrading
   Next.js 14→16 (14.x had no further stable patches) and force-upgrading
   Vitest to close a dev-only esbuild advisory.
2. `npx tsc --noEmit` — clean, after fixing one real type mismatch (see
   ARCHITECTURE.md).
3. `npx vitest run` — 24/24, including a direct automated regression test
   for the hybrid-BGC filtering bug found last chunk (previously only
   caught by manual verification of the prototype).
4. `next build` (production) — succeeded, after solving a real font-hosting
   problem (see below).
5. **Full end-to-end**: real `uvicorn` + real `next start`, both running
   simultaneously against real ingested fixture data, hit with real `curl`
   — confirmed correct HTML content, confirmed self-hosted fonts resolve,
   confirmed the API's CORS config actually permits the frontend's origin.

## Real problems found and fixed this chunk

1. **`next/font/google` can't build in this sandbox.** It fetches font
   files from `fonts.googleapis.com` at *build time* to self-host them —
   that domain isn't in this sandbox's network allow-list, so the first
   `next build` failed outright. Same *class* of issue as MIBiG/GTDB not
   being reachable from `bash_tool` in earlier chunks, hit again in a
   different subsystem. Fixed by fetching the real IBM Plex Sans/Mono
   `.woff2` files from IBM's own open-source GitHub repo and switching to
   `next/font/local` — the functional equivalent of what
   `next/font/google` would have produced, actually verified to build.
2. **A real TypeScript type mismatch**: `classColor()`'s `subtype`
   parameter was typed `string | null`, but the generated OpenAPI type for
   an `Optional[str] = None` Pydantic field is `string | null |
   undefined` (optional property, not just nullable). Fixed by widening
   the function signature to match the real generated type.
3. **A test-design bug, not a code bug**: the first version of a
   "collapsing reduces tree height" test used a fixture tree too small to
   clear the layout's `MIN_TREE_HEIGHT` floor in either state, so both
   sides of the comparison were equal by coincidence. Rewritten with a
   purpose-sized tree so the test actually exercises the scaling logic.

## Key design decisions made this chunk

1. **Generated, not hand-maintained, API types** — `openapi-typescript`
   against the real FastAPI schema, via a new `bgcscape dump-openapi-schema`
   CLI command. Direct response to this project's own history of
   shape-assumption bugs (see ARCHITECTURE.md).
2. **`d3.hierarchy(root, childrenAccessor)` instead of pre-pruning** — an
   architecture improvement found *while porting* the prototype, not a
   mechanical copy. The accessor function checks collapse state itself,
   avoiding a parallel "pruned tree" data shape recomputed on every toggle.
3. **Self-hosted local fonts** over `next/font/google`, for the reason
   above — also arguably the more genuinely "production-grade" choice
   regardless of this sandbox's constraints (no runtime dependency on
   Google's font CDN).
4. **`bgcscape dump-openapi-schema` is a lazy-imported CLI command** — so
   the core CLI keeps working without the `api` extra installed; only this
   one command needs it.

## Explicitly deferred / not yet built

antiSMASH/BiG-SCAPE ingestion · BGC-family highlighting in the tree ·
comparative clade analysis · publication-grade SVG/PDF export · Web Worker
offloading (premature at current data scale) · novelty scoring · user
uploads · full per-field multi-source provenance.

## Known constraints from this build environment

- Everything from Chunks 1–3 still applies.
- **No browser in this sandbox** — actual visual rendering has never been
  seen by anything in this build process, only HTML content correctness
  and logical behavior. This is the single most important thing to check
  yourself before trusting the visual result.
- `next dev`/`uvicorn --reload` weren't left running as persistent
  services — background processes don't survive across separate tool
  calls in this environment (confirmed directly: an E2E check split across
  two calls failed with "connection refused" on the second, because the
  first call's background servers had already been torn down when that
  call's shell session ended). All multi-service verification this chunk
  was done within single, combined tool calls for exactly this reason.

## How to resume

MVP v1 is functionally complete end-to-end. Reasonable next directions,
genuinely different in kind:

- **antiSMASH + BiG-SCAPE ingestion (Phase 1c)** — completes the MVP v2
  backend data layer (predicted BGCs at scale, family clustering), which
  the frontend's BGC-family-highlighting features would then have
  something real to render.
- **Frontend polish** — the production app covers MVP v1's core loop but
  not everything the prototype demonstrated (e.g. refined interaction
  details); worth comparing the two side by side.
- **Deploy something** — Postgres via docker-compose has still never been
  tested against real Postgres (only SQLite, repeatedly, in this sandbox);
  worth doing before trusting the Postgres path.

Say "continue" and, absent other direction, this project will proceed with
antiSMASH + BiG-SCAPE ingestion — it's the more clearly-scoped unit of
work and unblocks real (if still fixture-scale) predicted-BGC data at
volume, which several already-built frontend pieces (the class filter
rail, especially) would benefit from having more of to work with.
