# BGC-scape — Build Progress

**Read this file first when resuming work in a new chunk.**

_Last updated: Chunk 2 (Phase 1b) — 2026-08-22_

## Status at a glance

| Phase | Scope | Status |
|---|---|---|
| 1a | Core scientific data model (SQLAlchemy + Pydantic contracts) | ✅ Done |
| 1b | Curated reference dataset ingestion (MIBiG, GTDB) | ✅ **Done (this chunk)** |
| 1c | antiSMASH region-JSON ingestion + BiG-SCAPE family clustering | ⏭️ Queued |
| 2 | High-performance interactive phylogenetic tree (frontend) | ⏭️ Queued |
| 3 | Layered BGC overlays, filtering, MIBiG/family integration | Not started |
| 4 | Comparative analysis + publication-grade export suite | Not started |
| 5 | User uploads + novelty prioritization scoring | Not started |

**MVP v1 (per the original product report: "MIBiG + representative genomes +
GTDB taxonomy") is now data-complete** — ingestion for both sources works,
is tested, and is idempotent. What's *not* done yet for a demoable MVP v1
is the tree visualization itself (Phase 2) — there's real data to look at
now, but no way to look at it. See "Recommendation for next chunk" below.

## What exists right now (additions since Chunk 1 in bold)

```
bgc-scape/
├── README.md, ARCHITECTURE.md, PROGRESS.md (this file)
├── docs/DATA_SOURCES.md
├── docker-compose.yml, .env.example, .github/workflows/ci.yml
└── engine/
    ├── alembic.ini, migrations/          regenerated clean this chunk (see below)
    ├── src/bgcscape/
    │   ├── models/                        + AssemblyLevel.LOCUS; all 5 enum
    │   │                                    columns fixed (see "Bugs fixed")
    │   ├── schemas/                        refactored: Base/Create/Read per
    │   │                                    entity (Create schemas are new)
    │   ├── ingest/                         new this chunk
    │   │   ├── _util.py                    get_or_create_or_update + IngestReport
    │   │   ├── mibig.py                    MIBiG 4.0 JSON parser + loader
    │   │   └── gtdb.py                     GTDB metadata TSV parser + loader
    │   ├── db/session.py
    │   └── cli/main.py                     + `bgcscape ingest mibig|gtdb`
    └── tests/                              48 tests, all passing, zero warnings
        ├── fixtures/                        new: schema-accurate, content-
        │                                      synthetic MIBiG/GTDB fixtures
        ├── test_ingest_mibig.py             new
        ├── test_ingest_gtdb.py              new
        ├── test_ingest_cross_source.py      new — see "Bugs fixed" #3
        └── (6 Phase 1a test files, unchanged in count, still passing)
```

**Verified in this sandbox, not just written:** all 48 tests pass with
SQLAlchemy warnings promoted to errors; the regenerated initial migration
applies and downgrades cleanly; an invalid enum value was rejected via raw
SQL that bypasses the ORM entirely (proving the CHECK constraint fix is
real, not just tested through the ORM that would enforce it anyway); the
CLI (`bgcscape ingest mibig`, `bgcscape ingest gtdb`) was run directly
against fixture data in *both* orderings, confirming idempotency and the
cross-source merge fix outside of pytest too.

## Real bugs found and fixed this chunk (full detail in ARCHITECTURE.md)

Flagging these prominently because they're the kind of thing that would
otherwise resurface confusingly later:

1. **CHECK constraints were never actually being created** in Phase 1a
   despite `ARCHITECTURE.md` claiming they were — `SAEnum(...,
   native_enum=False)` needs `create_constraint=True` explicitly in
   SQLAlchemy 2.0. Fixed on all 5 enum columns; verified by rejecting an
   invalid value via raw SQL.
2. **Enum columns stored the Python member name** (`"OBSERVED_CURATED"`),
   not the lowercase `.value` every enum was deliberately defined with —
   silently inconsistent with what Pydantic schemas emit in JSON. Fixed
   with `values_callable` on all 5 enum columns.
3. **A cross-source data-loss bug**: ingesting GTDB after MIBiG (or vice
   versa) for the same organism silently nulled out fields the *other*
   source had already recorded, because the generic upsert helper blindly
   overwrote every field including with `None`. Fixed with a "don't let
   None overwrite non-None" guard, plus a `fallback_lookups` mechanism so
   the merge works regardless of which source runs first. Two regression
   tests lock this in (`test_ingest_cross_source.py`).
4. **A batch-transaction bug**: one bad record's `session.rollback()`
   would have silently discarded every good record processed earlier in
   the same ingestion run. Fixed by committing per-record instead of
   per-batch.
5. Alembic's autogenerate still drops the `Text` import for
   `JSONB(astext_type=Text())` — confirmed recurring (not a Phase-1a
   one-off) on this chunk's independent regeneration. Now documented
   directly in `models/types.py`.

Because of bugs #1 and #2, **the initial migration was regenerated from
scratch this chunk** rather than patched incrementally — there was no real
deployment to preserve compatibility with, and a clean initial migration
beats a two-step "create wrong, then immediately fix" history.

## Key design decisions made this chunk

1. **Parse/load separation** in every ingestion module — pure parsers,
   DB-touching loaders, orchestration on top. See ARCHITECTURE.md.
2. **`AssemblyLevel.LOCUS`** — MIBiG loci are GenBank locus deposits, not
   whole-genome assemblies; modeling them as `Genome` rows with assembly-
   level QC fields would have been a category error.
3. **Idempotency via natural-key upsert**, not primary-key merge — see
   `get_or_create_or_update()`.
4. **One commit per ingested record**, not one per batch.
5. **MIBiG status filtering**: retired/pending/embargoed entries are
   skipped by default (`include_non_active=True` to load them anyway).
6. **Schemas refactored to Base/Create/Read** — Create schemas didn't
   exist in Phase 1a because their shape was genuinely unclear before a
   real ingestion format existed to design against.

## Explicitly deferred / not yet built

antiSMASH region-JSON ingestion · BiG-SCAPE family-clustering ingestion ·
any HTTP/API layer · the frontend · novelty scoring · user uploads · full
per-field multi-source provenance (source_id/evidence_level currently
reflect "last source to touch this row," documented as a known
simplification, not fixed this chunk).

## Known constraints from this build environment

- Still true from Chunk 1: this sandbox can't reach
  mibig.secondarymetabolites.org or gtdb.ecogenomic.org directly. This
  chunk worked around it differently than planned — rather than
  `web_fetch`-ing individual example records, it cloned
  `mibig-secmet/python-mibig` and `Ecogenomics/GTDBTk` from GitHub (which
  *is* reachable from `bash_tool`) to read the real schema/column-name
  source code directly, then built clearly-synthetic-content fixtures
  matching that real schema. Real bulk ingestion against the live
  databases still needs to happen somewhere with broader network access.
- A couple of GTDB metadata TSV column names (`gc_percentage`,
  `ncbi_assembly_level`) are lower-confidence than the rest (`gtdb_taxonomy`,
  `checkm_completeness`, `checkm_contamination`, `genome_size` are
  confirmed against real tooling source code) — flagged in
  `ingest/gtdb.py`'s module docstring. Check against a real downloaded
  header before a production run.
- GitHub Actions CI still hasn't run on an actual runner.
- Alembic upgrade/downgrade re-verified against file-based SQLite this
  chunk; still not verified against real Postgres.

## Recommendation for next chunk

Two reasonable directions from here — flagging rather than silently
picking, since they're genuinely different in kind, not just sequential:

- **(a) Phase 2, tree visualization.** The original roadmap sequences this
  right after the data model, and there's now real (if fixture-scale)
  data to render. Gets to a demoable, if minimal, end-to-end MVP v1
  fastest.
- **(b) Phase 1c, antiSMASH + BiG-SCAPE ingestion.** Completes the full
  backend data layer (MVP v2 territory) before any frontend work starts.

Say "continue" and, absent other direction, this project will proceed with
**(a)** — it's what the roadmap in the original spec suggests, and seeing
something on screen after two backend-only chunks is worth more than it
might look like on a task list. Say which you'd prefer if that's wrong.
