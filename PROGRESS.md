# BGC-scape — Build Progress

**Read this file first when resuming work in a new chunk.**

_Last updated: Chunk 8 (Phase 4 complete) — 2026-08-25_

## Status at a glance

| Phase | Scope | Status |
|---|---|---|
| 1a | Core scientific data model | ✅ Done |
| 1b | Curated reference ingestion (MIBiG, GTDB) | ✅ Done |
| 1c | antiSMASH + BiG-SCAPE ingestion | ✅ Done |
| 2 | Visualization API + production Next.js frontend | ✅ Done |
| 3 | BGC-family highlighting + comparative clade analysis | ✅ Done |
| 4 | **Publication-grade export** | ✅ **Done (this chunk)** |
| 5 | User uploads + novelty prioritization scoring | ⏭️ **Next — the last phase** |

**Phases 1–4 are complete.** Every core principle in the original brief is
now implemented, including the "Publication-First & FAIR" one that had
remained entirely unbuilt until this chunk.

**127 engine tests (passing on BOTH SQLite and real Postgres) + 45
frontend tests = 172 total.**

## What's new this chunk

```
engine/src/bgcscape/export/       NEW
├── view_config.py    versioned, replayable figure description w/ required provenance
└── renderer.py       SVG metadata embedding, provenance caption, vector PDF

engine/src/bgcscape/
├── api/app.py        + GET /api/v1/provenance, POST /api/v1/export
└── cli/main.py       + inspect-figure, render-figure

engine/tests/test_export.py       NEW — 17 tests
web/src/lib/export.ts             NEW — config assembly + SVG serialization
web/src/lib/export.test.ts        NEW — 15 tests (jsdom)
web/src/components/ExportButton.tsx  NEW
```

## The idea worth keeping

**A figure carries its own provenance.** The `ViewConfig` — filters,
collapsed nodes, highlighted family, compared clades, *and* which
MIBiG/GTDB/antiSMASH versions produced the data — is embedded in the
exported SVG's `<metadata>` element. Six months later:

```
$ bgcscape inspect-figure figure3.svg
Title:          Figure 3: NRPS distribution
Dataset:        3 genomes, 3 BGCs, 8 taxa, 2 families
Sources:        BiG-SCAPE 2.0.0 · GTDB R11-RS232 · antiSMASH 7.1.0
View state:     BGC class filter: nrps, terpene
                Search query: 'Streptomyces'
```

No database, no browser session, no memory required. `bgcscape
render-figure` regenerates the PDF from that file alone.

Design decisions behind it (fuller reasoning in ARCHITECTURE.md):

1. **`dataset` provenance is required, not optional** — a config recording
   filters but not data versions is reproducible in appearance only.
2. **Version mismatches refuse rather than degrade** — a config from a
   newer build is rejected outright; partially applying it would silently
   change the figure.
3. **PDF conversion is server-side** — browser print-to-PDF varies by
   platform and silently rasterizes; a test asserts the output contains no
   `/Subtype /Image`, i.e. that it really is vector.
4. **"All classes selected" records as an empty filter** — the UI default
   is everything-on, so recording all eight names would make every default
   export look deliberately filtered.

## Verified end-to-end this chunk

Against **real Postgres**: exported a figure over real HTTP through the
live API in both SVG and PDF, then interrogated the SVG with `bgcscape
inspect-figure` and regenerated the PDF with `bgcscape render-figure` —
with the database connection unset, proving the figure is genuinely
self-describing. Confirmed the visible caption reads:
`BGC-scape 0.1.0 · 2026-08-24 · 3 genomes, 3 BGCs · Sources: BiG-SCAPE 2.0.0; GTDB R11-RS232; antiSMASH 7.1.0`

## Explicitly deferred / not yet built

Phase 5 (user uploads, novelty prioritization scoring) · CORASON
integration · full per-field multi-source provenance · `similarity_score`
on family memberships (column exists; BiG-SCAPE's clustering TSV doesn't
carry pairwise distances — they're in a separate network file).

## Known constraints from this build environment

- **No browser.** The frontend's actual visual rendering has still never
  been seen by anything in this build process — only HTML content and
  logic. This remains the single most important unverified thing, and it
  now includes the export button's download behavior (`URL.createObjectURL`
  + synthetic click), which is exercised only by unit tests of the pure
  functions around it, not the browser path itself.
- Real bulk data has never been ingested — only schema-accurate synthetic
  fixtures.
- The `export` extra needs Cairo system libraries (`libcairo2`). Present in
  this sandbox; verify on any deployment target.
- Postgres runs from a sandbox-local cluster on port 5433 (`/tmp/pgdata`),
  not docker-compose, and does not persist between chunks. Restart with:
  `su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /tmp/pgdata -l /tmp/pg.log -o '-p 5433 -k /tmp' start"`
  (fresh sandbox: `apt-get update && apt-get install -y postgresql`, then `initdb`)
- GitHub Actions CI still hasn't run on a real runner.

## How to resume

Say "continue" and this project will proceed with **Phase 5** — the last
phase in the roadmap: user-uploaded genomes/MAGs and the BGC
prioritization score (report §8).

A note on that scoring feature, worth deciding deliberately rather than
by momentum: the original report is explicit that it must be presented as
a **prioritization score, never a novelty claim**, and it depends on
several signals (phylogenetic rarity, distance from MIBiG, unusual domain
architecture) whose weighting is a scientific judgement call, not a
technical one. It's also the feature that most benefits from real data
existing first — a scoring formula tuned against three synthetic fixture
genomes would be meaningless. Consider whether ingesting real data at
volume should come first.
