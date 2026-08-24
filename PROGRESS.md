# BGC-scape — Build Progress

**Read this file first when resuming work in a new chunk.**

_Last updated: Chunk 9 (Phase 5 complete) — 2026-08-25_

## Status at a glance

| Phase | Scope | Status |
|---|---|---|
| 1a | Core scientific data model | ✅ Done |
| 1b | Curated reference ingestion (MIBiG, GTDB) | ✅ Done |
| 1c | antiSMASH + BiG-SCAPE ingestion | ✅ Done |
| 2 | Visualization API + production Next.js frontend | ✅ Done |
| 3 | BGC-family highlighting + comparative clade analysis | ✅ Done |
| 4 | Publication-grade export | ✅ Done |
| 5 | **User uploads + BGC prioritization scoring** | ✅ **Done (this chunk)** |

**All five roadmap phases are implemented.** 149 engine tests (passing on
BOTH SQLite and real Postgres) + 45 frontend tests = **194 total**.

The remaining work is no longer "build the next phase" — it's validation
against reality. See "What's actually unverified" below, which is now the
most important section of this file.

## What's new this chunk

```
engine/src/bgcscape/scoring/      NEW
└── prioritization.py    component-wise scoring; missing evidence never scored as evidence

engine/src/bgcscape/
├── api/app.py           + GET /api/v1/prioritization
└── cli/main.py          + `bgcscape prioritize`, `bgcscape ingest upload`

engine/tests/test_scoring.py      NEW — 17 tests
```

## The design decision that mattered

The report requires a **prioritization score, never a novelty claim**.
Three properties enforce that structurally rather than by comment:

1. **Components are never collapsed into a bare number.** Every result
   carries its per-component breakdown with plain-language explanations.
2. **Weights are uniform by default and overridable.** An unequal default
   would encode a scientific judgement that belongs to the researcher, not
   this module. Every result says so in its caveats.
3. **Missing evidence is never scored as evidence.** If MIBiG hasn't been
   ingested, "no close MIBiG relative" is a fact about the database, not
   the cluster — scoring it as maximal distance would rank every cluster
   in an empty corpus as maximally interesting. Uncomputable components
   return `None`, are excluded from the mean (not zeroed, not maxed), and
   are named. Below two available components, **no score is produced at
   all** — an honest refusal beats a confident number from one proxy.

The central test in `test_scoring.py` is
`test_absent_mibig_does_not_inflate_scores`; everything else supports it.

## Verified end-to-end this chunk

Against **real Postgres**: full pipeline → user upload via
`bgcscape ingest upload` (recorded as `SourceType.USER_UPLOAD`, not
`TOOL_RUN`) → `bgcscape prioritize --show-components`. Confirmed
unavailable components render as `unavailable`, not as zeroes, and that a
MIBiG reference entry correctly scores 0.00 on distance.

## What's actually unverified — read this before trusting anything

The build is complete; the **validation is not**. In rough order of how
much it should worry you:

1. **No one has ever looked at the UI.** This sandbox has no browser. The
   frontend builds, serves, type-checks, and its logic is unit-tested —
   but its actual rendered appearance has never been seen by anything in
   this entire project. Five phases of interface decisions rest on this.
   **This is the single highest-value thing only you can do.**
2. **The scoring weights are uncalibrated, by design.** They're uniform
   because picking otherwise would be inventing a scientific claim. Tuning
   them requires real data at volume; weights fitted against fixture
   genomes would encode the fixtures, not the biology.
3. **No real data has ever been ingested.** Only schema-accurate synthetic
   fixtures. The parsers were written against verified real formats (read
   from the tools' own source), but "verified format" ≠ "works on a real
   50,000-genome GTDB release."
4. **The export button's browser path is untested.**
   `URL.createObjectURL` + synthetic click is exercised only through unit
   tests of the pure functions around it.
5. **GitHub Actions CI has never run on a real runner** — though what it
   runs is now verified correct in substance.

## Deferred by choice

CORASON integration · sequence-level divergence and domain-architecture
scoring components (need MAFFT/HMMER, treated as external analysis
dependencies — adding them means adding components, not restructuring the
scorer) · full per-field multi-source provenance · `similarity_score` on
family memberships (BiG-SCAPE's clustering TSV doesn't carry pairwise
distances; they're in a separate network file).

## Environment notes

- Postgres: sandbox-local cluster, port 5433 (`/tmp/pgdata`), does not
  persist between chunks. Fresh sandbox:
  `apt-get update && apt-get install -y postgresql`, `initdb`, then
  `su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /tmp/pgdata -l /tmp/pg.log -o '-p 5433 -k /tmp' start"`
- The `export` extra needs Cairo system libraries (`libcairo2`).
- Run the engine suite against Postgres with `BGCSCAPE_TEST_DATABASE_URL`
  (note the `_TEST_` — deliberately distinct from the app's variable,
  because the fixture drops and recreates the schema).

## How to resume

There is no obvious "next phase" — the roadmap is done. The highest-value
next steps, in order:

1. **Look at the UI and tell me what's wrong with it.** Genuinely the
   biggest gap, and I can't close it from here.
2. **Ingest real MIBiG/GTDB data at volume** somewhere with real network
   access, and report what breaks. The parsers are the most likely thing
   to surface surprises.
3. **Calibrate the scoring weights** once (2) exists — a real scientific
   task, not a coding one, and one I'd want your judgement on.
4. Deploy: docker-compose is written but never run; CI never executed.
