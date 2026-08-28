# BGC-scape — Build Progress

**Read this file first when resuming work in a new chunk.**

_Last updated: correctness + performance pass following a full end-to-end
stress test of the shipped build._

## Status at a glance

| Phase | Scope | Status |
|---|---|---|
| 1a | Core scientific data model | ✅ Done |
| 1b | Curated reference ingestion (MIBiG, GTDB) | ✅ Done |
| 1c | antiSMASH + BiG-SCAPE ingestion | ✅ Done |
| 2 | Visualization API + production Next.js frontend | ✅ Done |
| 3 | BGC-family highlighting + comparative clade analysis | ✅ Done |
| 4 | Publication-grade export | ✅ Done |
| 5 | User uploads + BGC prioritization scoring | ✅ Done |

**Tests:** 212 engine tests (SQLite) / 211 (real Postgres 16), 4–5 skipped
where the Cairo system library is absent · 45 frontend unit tests ·
**11 Playwright browser tests** (new).

Real data is ingested and shipped: `engine/gtdb_mibig_bundled.db` holds all
2,437 active MIBiG 4.0 clusters mapped onto GTDB R11-RS232 (1,739 genomes,
1,899 taxa, 279 compound groups).

## What this pass changed

A full stress test against the shipped database found five broken and ten
misleading behaviours. All are fixed; each has a regression test that fails
without its fix. Full write-ups in ARCHITECTURE.md.

**Scientific correctness**

- **The missing-evidence guarantee was off in the shipped build.** Compound
  groups (`group-by-compound`) were being read as BiG-SCAPE sequence
  families, so the prioritization scorer emitted similarity claims about a
  corpus on which no clustering had run. On the bundle it declined to score
  **0** of 2,437 clusters; it now declines **783**, matching the corpus
  without compound groups exactly. `BGCFamily.kind` makes the distinction a
  typed, CHECK-constrained column.
- **Re-ingesting MIBiG destroyed the GTDB placement** — 1,629 clusters moved
  off real assemblies back onto locus stubs, reported as `created=0`.
- **`is_generic_product` was dead code, and wrong.** Now called, exposed
  through the API, shown in the UI, and correct for hyphenated names.
- **Provenance carried no licence.** GTDB is CC BY-SA 4.0 and requires
  attribution; every exported figure attributed nothing. Now populated.
- **Compound groups were typed `reference_database`.** They are `TOOL_RUN` —
  BGC-scape derives them.
- **Prioritization caveats described one row and were shown for all of them.**
  Corpus-level and per-cluster caveats are now separate.
- **The Sankey's `hybrid_double_counted` under-reported** by one per 3-way
  hybrid, so the flows did not reconcile.

**Robustness**

- `alembic revision --autogenerate` no longer emits CHECK-constraint drops.
  It previously took the schema from 12 constraints to 1 with no model
  changes, on both dialects.
- `/api/v1/prioritization?limit` is bounded; `limit=0` used to return the
  whole corpus and `limit=-1` everything-but-the-last-row.
- Missing Cairo returns 503 with an install hint, not a bare 500.
- `/api/v1/search` escapes LIKE wildcards and reports totals, truncation and
  a "query too short" message.

**Performance** (2,437-BGC bundle, measured before and after)

| endpoint | before | after |
|---|---|---|
| `/api/v1/taxonomy-tree` | 0.662 s / 1.10 MB | **0.149 s / 0.23 MB** |
| `/api/v1/tree?depth=1` | 0.587 s | **0.087 s** |
| `/api/v1/heatmap?rank=genus` | 0.432 s / 192 KB | **0.061 s / 24 KB** |
| `/api/v1/flows/taxonomy-class` | 0.457 s | **0.065 s** |

Cause: every one of these loaded mapped ORM objects, so SQLAlchemy decoded
~4,200 `BGC.raw_annotation` JSON blobs per request for data none of them
read — 41% of tree-build CPU. Plus gzip, which was simply absent.

Frontend: the pan/zoom transform is no longer React state, so a pan does not
reconcile 3,528 nodes per mouse-move. **3 long tasks → 0** over a 40-step drag.

## What is verified, and how

- Engine suite on **SQLite and real Postgres 16**.
- Migrations empty → head → base → head on **both dialects**, 13 CHECK
  constraints intact.
- Ingestion idempotency for **all five sources** by row count, three runs each.
- Prioritization on **MIBiG-only, GTDB-only, and both**, with and without
  compound groups.
- **Browser tests (Playwright/Chromium)**: initial load, middle-drag pan,
  wheel zoom, every "Show down to" level, radial/horizontal toggle, search
  match counts, filter fallback, the SVG download and its embedded
  provenance, the PDF error path, and a real cross-origin preflight on the
  export POST. These cover the interactions previous passes could only mark
  as unverified.
- Round trip: `bgcscape inspect-figure` on an exported SVG **with
  `BGCSCAPE_DATABASE_URL` unset**.

## What is still unverified — read this before trusting it

1. **PDF rendering is untested on this machine.** The Cairo system library is
   not installable here, so the four PDF tests skip. The Docker image installs
   `libcairo2`, and the browser test asserts the *error* path is actionable,
   but "a real PDF comes out" has not been observed in this pass. Run the
   suite in the container to close it.
2. **The scoring weights remain uncalibrated, by design.** Uniform because
   choosing otherwise encodes a scientific judgement that belongs to the
   researcher. Calibrating them needs real data at volume and is a scientific
   task, not a coding one.
3. **The unclustered-scores-high-by-construction bias is named, not fixed.**
   An unclustered cluster scores 1.0 on one component while making three
   uncomputable, so its mean is over few, high signals. Correcting it means
   either inventing evidence or making a weighting judgement; it is surfaced
   in a per-cluster caveat instead.
4. **No sequence families in the bundle.** Everything family-shaped in the
   shipped corpus is a compound group. The three sequence-similarity
   components are uncomputable corpus-wide, which is why 783 clusters decline
   to score. A BiG-SCAPE run is the only thing that changes this.
5. **E2E tests are not in CI.** They need a workflow that starts both servers
   and a database.
6. **The frontend still uses the eager `/taxonomy-tree`.** Now that the lazy
   endpoint is genuinely fast (6.7x), porting is worthwhile — but it is a real
   piece of work (fetch-on-expand, cache invalidation, focus interaction) and
   export needs a complete figure either way.

## Deferred by choice

CORASON integration · sequence-level divergence and domain-architecture
scoring components (need MAFFT/HMMER) · full per-field multi-source
provenance · `similarity_score` on family memberships (BiG-SCAPE's clustering
TSV doesn't carry pairwise distances).

## Environment notes

- Postgres for tests: `BGCSCAPE_TEST_DATABASE_URL` (note the `_TEST_` — the
  fixture drops and recreates the schema). A container is enough:
  `docker run -d -e POSTGRES_PASSWORD=bgcscape -e POSTGRES_USER=bgcscape -e POSTGRES_DB=bgcscape -p 55432:5432 postgres:16`
- The `export` extra needs Cairo system libraries (`libcairo2`).
- Browser tests: `npx playwright install chromium`, start uvicorn and
  `next start`, then `npm run e2e` from `web/`.
- **A database built before this pass must be migrated** — see DEPLOY.md,
  "Upgrading a database built before this change". Without it,
  `/api/v1/families` and `/api/v1/prioritization` return 500.

## How to resume

1. **Run the engine suite in Docker** to close the PDF gap (item 1 above).
2. **Wire the e2e tests into CI.**
3. **Ingest antiSMASH + BiG-SCAPE output** to get real sequence families —
   the single change that most improves what the scorer can say.
4. **Port the frontend to the lazy tree endpoint** when the corpus outgrows
   the eager payload.
