# Phylo-BGC — Build Progress

**Read this file first when resuming work in a new chunk.**

_Last updated: the analysis-coverage pass — modelling what was EXAMINED, not
just what was found — followed by a pass closing the reachable gaps in the
standing to-do list._

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

**Tests:** 364 engine tests (SQLite) / 363 (real Postgres 16) / 368 in the
production image, where Cairo exists and the PDF tests actually run ·
174 frontend unit tests · 69 Playwright browser tests (68 passing; see
"still unverified" item 6).

Real data is ingested and shipped: `engine/gtdb_mibig_bundled.db` holds all
2,437 active MIBiG 4.0 clusters mapped onto GTDB R11-RS232 (1,542 genomes,
2,021 taxa, 279 compound groups, 1,849 recorded placements).

## What this pass changed

The data model recorded what we believe, but not what was examined, by what,
with what coverage. Every flaw below traced to that.

**`AnalysisRun` — absence gets a denominator (new)**

- Which tool, which version, which parameters, **which genomes**, when.
  `AnalysisRunCoverage` is one row per genome examined, and `bgcscape.coverage`
  turns it into three states: **examined** (zero clusters is a finding),
  **curated only** (the count is a floor), **unexamined** (nothing looked).
- MIBiG ingestion records **no** run, deliberately: a curated entry is a
  report that one cluster exists, not a survey of a genome.
- `bgcscape record-analysis-run` declares coverage for the half that leaves
  no output — genomes a run examined and found nothing in. Stored as
  `HYPOTHESIZED`, because it is asserted rather than derived.
- Surfaced as `coverage` per genome, `examined_genome_count` per tree node,
  and a corpus line in the stats bar. Unexamined empty clades are hatched;
  examined-empty ones keep the hollow rectangle, which now means something.

**The scorer's denominators were wrong, and unstated**

- `class_rarity_in_clade` counted "genomes that happen to have a BGC row",
  which on a curated corpus is "genomes somebody published about". It is now
  computed over EXAMINED genomes and refuses below two of them.
- `unclustered` / `family_rarity` / `taxonomic_isolation` are answerable only
  for genomes a clustering run reached. **This was a live bug waiting for
  the first BiG-SCAPE ingest**: one run over ten genomes would have made
  every other cluster in the corpus score 1.0 on "no sufficiently similar
  cluster was found", having never been compared to anything.
- Every caveat now names its denominator (`DENOMINATOR: …`).

**Placement is a queryable relation**

- `bgc_organism_placement` replaces a JSON key inside `raw_annotation`, with
  `method` / `confidence` / `caveat` as CHECK-constrained columns. On the
  bundle: 1,589 strong, 40 moderate, **220 weak** — `WHERE confidence =
  'weak'` instead of a Python pass over 2,437 blobs. `bgcscape placements`
  reports it.
- The FK is `representative_genome_id`: the genome represents the organism,
  it is not the assembly the cluster was sequenced from, and every caveat
  says so in as many words.
- An undefined `match_method` is counted and skipped, never coerced.

**The last three consumers that pooled the two kinds of grouping**

`BGCFamily.kind` shipped in `725aba2` and the scorer has honoured it since;
`api/comparison.py`, `/api/v1/provenance` and the BGC detail panel had not.
The panel labelled every compound group "Gene cluster family" and offered
its distribution as a family's — on this corpus, every row.

## What this changes about the shipped bundle

Both are consequences, not regressions. Both are the point.

| | before | after |
|---|---|---|
| genomes reported as examined | (unrepresentable) | **0 of 1,542** |
| clusters the scorer scores | 2,052 of 2,437 | **0 of 2,437** |

The bundle contains 2,437 MIBiG clusters, `predicted_by_tool` NULL on every
one, and no antiSMASH run anywhere. So nothing in it has been surveyed, no
absence in it is evidence, and no rarity claim is supportable. The 2,052
scores were the artifact of counting curated clusters as a survey; the
refusal is the behaviour ARCHITECTURE.md's own "MIBiG-only: 2,437 / 2,437"
row always described.

The interface states this **once**, in the stats bar, rather than greying out
every glyph — on a corpus with no coverage, that would read as a broken app
rather than an honest one.

## Closing the reachable to-do items

A standing list tracked 16 known gaps. Twelve were actionable; the rest were
recorded facts (an upstream vocabulary has no siderophore category; a class
absent from this corpus; a deliberate MVP simplification). Seven are now
closed.

**`is_mag` had no source.** Every loader wrote False without grounds, and the
UI read it as "Isolate genome assembly" for all 1,542 genomes. Now tri-state
— see ARCHITECTURE.md.

**Prioritization had no interface.** The scorer, API and CLI all worked and
nothing called them. The new rail panel treats refusals as first-class,
which after the denominator work is the entire result on this corpus.

**The class filter rail could omit a class.** It iterated the hardcoded
palette, so a class in the corpus but not in `colors.ts` was counted and
then never rendered — unfilterable and invisible. It now asks the API.

**`contamination_pct` was ingested for 991 genomes and had no way out.**
Carried in the tree payload and paired with completeness in the filter,
because the two are read together.

**Search could report "no matches" over a filtered view.** The client-side
search stays primary; when it finds nothing, the header now says how many
records the database holds.

**Uploads vanish on redeploy without saying so.** The result panel now
leads with it.

**`?taxon=` and `?class=` deep links were untested.** Six specs, each
against a control that loads the same page without the parameter.

Left undone, deliberately: phylogeny (needs MAFFT/IQ-TREE orchestration),
ingesting antiSMASH and BiG-SCAPE output (data acquisition, not a build
task — and the single highest-value thing to do next), the lazy-tree
switchover (a scaling path with no current need; the eager endpoint answers
in 0.149 s over this corpus), and per-field provenance (a schema change of
its own).

## What is verified, and how

- Engine suite on **SQLite and real Postgres 16** (359 / 358).
- Migrations empty → head → base → head on **both dialects**, **18** CHECK
  constraints intact (13 before, +5 from the two new tables), and the
  migrated schema compared column-by-column against the models' own metadata.
- **The placement backfill run against real data on both dialects.** It
  shipped a dialect-shaped UUID bug that the empty-database round trip could
  not see, because an empty database has no rows to insert. Also verified
  against the real 2,437-cluster bundle: 1,849 placements backfilled,
  downgrade leaves all 1,849 recoverable from `raw_annotation`.
- Ingestion idempotency for **all five sources** by row count, three runs each.
- Prioritization on **MIBiG-only, GTDB-only, and both**, with and without
  compound groups, and with and without recorded coverage.
- **Browser tests (Playwright/Chromium)**: initial load, middle-drag pan,
  wheel zoom, every "Show down to" level, radial/horizontal toggle, search
  match counts, filter fallback, the SVG download and its embedded
  provenance, the PDF error path, and a real cross-origin preflight on the
  export POST. These cover the interactions previous passes could only mark
  as unverified.
- Round trip: `bgcscape inspect-figure` on an exported SVG **with
  `BGCSCAPE_DATABASE_URL` unset**.
- **The suite inside the production image**, which is what finally exercises
  PDF rendering — see item 1 below.
- The `is_mag` migration against the real bundle: 1,542 unverified `False`
  values became NULL, and the round trip holds on both dialects with the
  same 18 CHECK constraints.
- **The prioritization panel in a real browser**, which is how its
  `loading`-in-the-dependency-array bug was found: the panel hung on
  "Scoring the corpus…" against an endpoint answering in 0.9 s.
- The coverage flip end to end: `record-analysis-run` over five cluster-free
  genomes moves them from `unexamined` to `examined`, and the CLI reports the
  five as examined-and-empty.
- The frontend against the migrated bundle in a real browser: stats bar reads
  `0 / 1,542 EXAMINED` with the corpus sentence, genome panels report their
  state, `/api/v1/prioritization` returns unscored rows with components.

## What is still unverified — read this before trusting it

1. ~~**PDF rendering is untested on this machine.**~~ **Closed this pass.**
   The suite was run inside the built image, where `libcairo2` is present:
   **362 passed, 1 skipped** (the skip is `test_accession.py`'s GTDB
   reference-tree test, which wants `bac120.tree` on disk). The four PDF
   tests that skip locally all pass there, so "a real PDF comes out" is now
   observed rather than assumed.
2. **The scoring weights remain uncalibrated, by design.** Uniform because
   choosing otherwise encodes a scientific judgement that belongs to the
   researcher. Calibrating them needs real data at volume and is a scientific
   task, not a coding one.
3. **The unclustered-scores-high-by-construction bias is named, not fixed.**
   An unclustered cluster scores 1.0 on one component while making three
   uncomputable, so its mean is over few, high signals. Correcting it means
   either inventing evidence or making a weighting judgement; it is surfaced
   in a per-cluster caveat instead.
4. **No sequence families and no analysis runs in the bundle.** Everything
   family-shaped in the shipped corpus is a compound group, and nothing has
   ever been surveyed. Every component but `mibig_distance` is uncomputable,
   which is why **all 2,437** clusters decline to score. An antiSMASH run
   (for rarity) and a BiG-SCAPE run (for similarity) are the only things that
   change this — and both now record their own coverage when ingested.
5. **E2E tests are not in CI.** They need a workflow that starts both servers
   and a database.
6. **One browser test fails, and predates both passes.** `mobile.spec.ts ›
   pinch zooms the canvas` — the CDP multi-touch gesture produces no scale
   change. Confirmed pre-existing by reverting `TreeCanvas.tsx` to its
   committed state and watching it fail identically; 62 of 63 pass either
   way. Likely Playwright/Chromium drift, not a product bug, but it is
   unfixed and therefore listed here.
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

1. **Ingest a real antiSMASH run.** This is now the single highest-value
   action by a wide margin: it is what makes any absence in this database
   evidence, and what makes rarity computable at all. Both the CLI and the
   browser upload record coverage automatically; for genomes a run found
   nothing in, use `bgcscape record-analysis-run`.
2. **Ingest BiG-SCAPE or BiG-FAM output** for real sequence families — the
   other half of what the scorer needs, and the thing that makes "the same
   cluster, found elsewhere" a sequence claim rather than a chemical one.
3. **Wire the e2e tests into CI**, and diagnose the pinch failure (item 6).
4. **Port the frontend to the lazy tree endpoint** when the corpus outgrows
   the eager payload.
