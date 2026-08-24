# BGC-scape — Build Progress

**Read this file first when resuming work in a new chunk.**

_Last updated: Chunk 7 (Phase 3 complete) — 2026-08-25_

## Status at a glance

| Phase | Scope | Status |
|---|---|---|
| 1a | Core scientific data model | ✅ Done |
| 1b | Curated reference ingestion (MIBiG, GTDB) | ✅ Done |
| 1c | antiSMASH + BiG-SCAPE ingestion | ✅ Done |
| 2 | Visualization API + production Next.js frontend | ✅ Done |
| 3 | BGC-family highlighting | ✅ Done |
| 3 | **Comparative clade analysis** | ✅ **Done (this chunk)** |
| 4 | Publication-grade export suite | ⏭️ **Next** |
| 5 | User uploads + novelty prioritization scoring | Not started |

**Phases 1–3 are complete.** Everything in the original report's MVP v1
and v2 scope now exists end-to-end: four-source ingestion → API →
interactive tree with class filtering, family highlighting, and clade
comparison.

**104 engine tests (passing on BOTH SQLite and real Postgres) + 30
frontend tests = 134 total.**

## What's new this chunk

```
engine/src/bgcscape/api/
├── comparison.py    NEW — subtree collection, clade profiling, caveat logic
├── schemas.py       + CladeComparison / CladeSummary / ClassProfileEntry / FamilyRef
└── app.py           + GET /api/v1/compare

engine/tests/
└── test_api_comparison.py   NEW — 13 tests, incl. the rigor caveats

web/src/components/
├── ComparisonPanel.tsx      NEW — comparison table + prominent caveats
├── TreeCanvas.tsx           + shift-click clade selection
└── Header.tsx               + discoverability hint
```

## The design work that mattered here

Comparing clades is where a tool like this most easily produces confident
nonsense, so most of the effort went into rigor rather than statistics
(fuller reasoning in ARCHITECTURE.md):

1. **Every count is paired with a per-genome rate** — raw counts between
   differently-sized clades mostly measure sampling effort.
2. **`comparable: false` when sampling is thin (<3 genomes) or lopsided
   (>10x imbalance)** — the response is still returned; the flag governs
   presentation. The UI shows a prominent warning *above* the table.
3. **`only_in_this_clade`, never `absent_from_others`** — the naming
   decision that matters most. Missing from a profile means "not found in
   this dataset," which conflates true absence with sampling depth,
   assembly gaps, and prediction sensitivity. That caveat is returned on
   *every* comparison and rendered above the numbers.
4. **No p-values** — enrichment testing needs a model of phylogenetic
   non-independence this doesn't have; a naive p-value would be worse
   than none.
5. **Families in some-but-not-all clades land in neither bucket** — "in
   two of three" is genuinely distinct from universal or unique.

## Real bug found this chunk

`partition_families()` initially filtered to clades that *have* families
before intersecting — so a clade with no families was silently excluded
from the "shared by all" calculation, and a family could be reported as
universal even when a compared clade plainly lacked it. Caught by both the
three-clade test and the empty-clade test. Fixed to intersect over every
profile.

## Verified end-to-end this chunk

Against **real Postgres**: migrations → ingestion → live `uvicorn` →
`/api/v1/compare` over real HTTP, comparing two real species clades.
Confirmed correct per-genome rates, correct hybrid attribution to
component classes, and — notably — that the endpoint correctly returned
`comparable: false` with the thin-sampling caveat naming both clades,
rather than presenting one-genome-per-clade numbers as meaningful.
Frontend `tsc` clean, 30 tests passing, production build succeeds.

## Explicitly deferred / not yet built

Publication-grade SVG/PDF export (Phase 4) · CORASON integration · novelty
scoring (Phase 5) · user uploads (Phase 5) · full per-field multi-source
provenance · `similarity_score` on family memberships (column exists;
BiG-SCAPE's clustering TSV doesn't carry pairwise distances — they're in a
separate network file, not yet ingested).

## Known constraints from this build environment

- **No browser** — the frontend's actual visual rendering has still never
  been seen by anything in this build process, only its HTML content and
  logic. With Postgres now closed out, **this is the single most important
  unverified thing left**, and it's grown more significant as the UI has
  gained a filter rail, family rail, detail panel, and now a comparison
  table competing for the same screen.
- Real bulk data has never been ingested — only schema-accurate synthetic
  fixtures. "Verified format" ≠ "verified at volume."
- Postgres runs from a sandbox-local cluster on port 5433 (`/tmp/pgdata`),
  not docker-compose, and does not persist between chunks. Restart with:
  `su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /tmp/pgdata -l /tmp/pg.log -o '-p 5433 -k /tmp' start"`
  (install first if the sandbox is fresh: `apt-get update && apt-get install -y postgresql`)
- GitHub Actions CI still hasn't run on a real runner, though what it runs
  is now verified correct in substance.

## How to resume

Say "continue" and, absent other direction, this project will proceed with
**Phase 4: publication-grade export** — SVG/PDF export of the tree and
comparison views, plus the declarative JSON view-configuration the
original brief calls for ("visualizations must be reproducible via
declarative configuration and exportable to publication-ready vector
formats"). It's the last major piece of the original brief's core
principles that remains entirely unbuilt, and it's what makes the tool
citable rather than merely usable.

Alternatives: **look at the UI yourself and redirect** (the highest-value
thing only you can do right now); **ingest real data at volume**; or
**Phase 5 novelty prioritization scoring**, though that one benefits from
real data existing first.
