# BGC-scape — Build Progress

**Read this file first when resuming work in a new chunk.**

_Last updated: Chunk 6 (Phase 3 + Postgres verification) — 2026-08-24_

## Status at a glance

| Phase | Scope | Status |
|---|---|---|
| 1a | Core scientific data model | ✅ Done |
| 1b | Curated reference ingestion (MIBiG, GTDB) | ✅ Done |
| 1c | antiSMASH + BiG-SCAPE ingestion | ✅ Done |
| 2 | Visualization API + production Next.js frontend | ✅ Done |
| 3 | **BGC-family highlighting** | ✅ **Done (this chunk)** |
| 3 | Comparative clade analysis | ⏭️ Remaining Phase 3 work |
| 4 | Publication-grade export suite | Not started |
| 5 | User uploads + novelty prioritization scoring | Not started |

**Postgres is no longer an untested assumption** — see below. That was the
project's longest-standing known risk, carried across four chunks, and
it's now closed.

**91 engine tests (passing on BOTH SQLite and real Postgres) + 30 frontend
tests = 121 total.**

## The big one this chunk: real Postgres verification

Every database check in this project had run against SQLite. Postgres 16
turned out to be installable in the build sandbox, so it got tested
properly:

- Both migrations apply cleanly via Postgres's real transactional-DDL path
  (a genuinely different code path from SQLite's batch/recreate strategy).
- The schema is really Postgres-native: `uuid` columns, `jsonb` (not plain
  `json`), all 12 CHECK constraints present in `pg_constraint`. The
  dual-dialect design from Phase 1a did exactly what it claimed.
- Full four-source ingestion produces byte-identical results to SQLite.
- **The entire test suite passes on both dialects.**

### …which exposed that CI had been verifying nothing

The "Run test suite against real Postgres" CI step has existed since Chunk
1. It set `BGCSCAPE_DATABASE_URL` — but `conftest.py` hardcoded SQLite and
ignored it. That step re-ran the SQLite suite and reported success: **a
green check mark verifying nothing, for four chunks.**

Fixed via a new `BGCSCAPE_TEST_DATABASE_URL` variable that conftest
actually honors. Deliberately a different name from the app's variable, so
pointing the app at a database can never cause a test run to
`DROP SCHEMA public CASCADE` on it.

Worth keeping in mind generally: a CI step that *can't* fail is worse than
no CI step, because it converts "untested" into "believed tested."

## Phase 3 (family features) — what's new

```
engine/src/bgcscape/api/
├── schemas.py       + BGCFamilySummary / BGCFamilyMember / BGCFamilyDetail
│                    + BGCSummary.family_ids
├── app.py           + GET /api/v1/families, GET /api/v1/families/{id}
└── tree_builder.py  + family_ids threaded through the tree response

web/src/
├── components/FamilyRail.tsx    NEW — family list + selection
├── components/TreeCanvas.tsx    + family highlighting (dim + ring)
└── lib/tree-logic.ts            + bgcInFamily / genomeHasFamily / nodeHasFamily
```

Design notes (fuller reasoning in ARCHITECTURE.md):

1. **`family_ids` is a list, not a single value** — the same BGC is
   legitimately in different families at different BiG-SCAPE cutoffs.
2. **`taxon_names` on the family summary** answers the report's core
   question directly (confined to one clade, or scattered across distant
   organisms?) — visible in the list, not behind a click.
3. **Family highlight uses a ring, not a color change** — the tick's fill
   already encodes BGC class and must stay readable.
4. **Membership predicates are pure, unit-tested functions** — the
   hybrid-class bug in Phase 2 happened precisely because one decision
   lived in two places that drifted.

## Also found this chunk

**A test that had been passing by accident.**
`test_bgc_detail_includes_compounds` grabbed "the first BGC in the tree"
and asserted it had compounds — true only while the fixture was
MIBiG-only. Adding antiSMASH data (which predicts boundaries and class but
says nothing about products) broke it correctly. Now two explicit tests:
MIBiG BGCs must carry curated compounds; antiSMASH BGCs must report an
empty list rather than anything invented.

## Verified end-to-end this chunk

Against **real Postgres**, not SQLite: migrations → four-source ingestion →
live `uvicorn` API → production `next build` + `next start` → real HTTP.
Confirmed the families endpoints return correct rolled-up data, the page
renders the family rail, and CORS permits the frontend origin (with a real
GET, after an initial `curl -I` 405 turned out to be just HEAD-vs-GET).

## Explicitly deferred / not yet built

Comparative clade analysis (the rest of Phase 3) · CORASON integration ·
publication-grade SVG/PDF export · novelty scoring · user uploads · full
per-field multi-source provenance · `similarity_score` on family
memberships (column exists; BiG-SCAPE's clustering TSV doesn't carry
pairwise distances — they're in a separate network file, not yet ingested).

## Known constraints from this build environment

- **No browser** — the frontend's actual visual rendering has still never
  been seen by anything in this build process, only its HTML content and
  logic. This is now the single most important unverified thing left.
- Real bulk data has never been ingested — only schema-accurate synthetic
  fixtures. The parsers are written against verified real formats, but
  "verified format" ≠ "verified at volume against real data."
- Postgres runs from a sandbox-local cluster on port 5433
  (`/tmp/pgdata`), not the docker-compose setup. It does not persist
  between chunks; restart with:
  `su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /tmp/pgdata -l /tmp/pg.log -o '-p 5433 -k /tmp' start"`
- GitHub Actions CI still hasn't run on an actual runner, though what it
  runs is now verified correct in substance.

## How to resume

Say "continue" and, absent other direction, this project will proceed with
**comparative clade analysis** — selecting two or more clades and asking
what biosynthetic capabilities distinguish them (report §4.7). It's the
natural next step now that families exist end-to-end, and it's the last
substantial piece of Phase 3.

Alternatives worth considering: **publication-grade SVG/PDF export**
(Phase 4 — the report's "Publication-First" principle, still entirely
unbuilt, and arguably what makes this tool citable); or **ingesting real
data at volume** (would validate the parsers against reality rather than
fixtures, and is the kind of thing best done where there's real network
access and real compute).
