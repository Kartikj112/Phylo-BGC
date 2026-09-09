# Phylo-BGC — Build Progress

**Read this file first when resuming work in a new chunk.**

_Last updated: the pre-submission pass — a real BiG-SCAPE run ingested, the
placement grades re-audited against GTDB's own NCBI column, and the production
readiness work (legal, accessibility, discoverability, security, citation)
that stands between this and a journal submission._

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
| — | Pre-submission: policy, a11y, SEO, security, citation | ✅ Done, 4 facts deferred |

**Tests, as re-run this pass:** 398 engine tests pass on SQLite (4 skipped —
the Cairo/PDF paths, which have no libcairo2 on this machine) · 190 frontend
unit tests across 7 files · 69 Playwright specs in 11 files, **not re-run since
the production-readiness pass** (see "still unverified" item 1).

Real data is ingested and shipped: `engine/gtdb_mibig_bundled.db` holds all
2,437 active MIBiG 4.0 clusters mapped onto GTDB R11-RS232 — 1,542 genomes,
2,021 taxa, 1,849 recorded placements, 279 compound groups and, new this pass,
**281 real sequence families** from a BiG-SCAPE 2.0.3 run. Schema is at
`e2b6c04f8a13`.

## What this pass changed

**The corpus finally distinguishes "same compound" from "same sequence"**

- `bgc_family` held 279 compound groups and **zero** sequence families: every
  "these two clusters are the same" traced back to MIBiG recording the same
  named compound. A BiG-SCAPE 2.0.3 run over MIBiG 4.0 (Pfam-A, glocal/region,
  mix weights, cutoff 0.3) now supplies **281 sequence families over 747
  clusters**, 264 of them multi-member.
- The `AnalysisRun` matters as much as the families: SEQUENCE_CLUSTERING over
  the **505 genomes the run actually reached**, so "in no family" means
  "nothing similar was found" for those and still means nothing at all for the
  other 1,037.
- The families are coherent, not merely non-empty. The largest (FAM_00016, 27
  members) is polyketide-containing throughout — 22 `pks` plus 5 saccharide
  hybrids. **123 of the 264 multi-member families contain no member of any
  compound group**: sequence-coherent groupings curation never named, which is
  the case for ingesting this that compound groups could not make.

**An exact taxid match was the most confident wrong answer available**

- `ingest/link.py` graded an exact NCBI taxid match STRONG with no further
  test, but only one of the two identifiers is derived from the genome — GTDB
  reads the lineage off genome content, the NCBI taxid is typed in by the
  depositor. When the depositor was wrong, the cluster landed in the wrong
  phylum at the highest confidence the schema can express.
- `Genome.ncbi_taxonomy_conflict` is tri-state and set from GTDB's own adjacent
  `ncbi_taxonomy` column. On the bundle: **989 genomes compared, 6 conflicted,
  32 placements demoted strong → weak.** The 41 GTDB suffix splits
  (`Myxococcota` vs `Myxococcota_A`) are deliberately *not* conflicts.
- `bgcscape recheck-placements <bac120_metadata.tsv[.gz]>` re-grades an
  existing database, and is **symmetric**: a later GTDB release that resolves a
  conflict restores the placement.

**The pre-submission pass: policy, accessibility, security, citation**

- Four policy routes plus a 404, sitemap, robots, favicon and share card. The
  privacy story is clean and now says why — no cookies, no localStorage, no
  analytics, no embeds, fonts self-hosted — verified at the HTTP level rather
  than asserted.
- The upload form now discloses that an upload is a **publication into a
  shared corpus**, behind an unticked consent box, and is usable from the
  keyboard for the first time (it was a `div onClick` over a `display:none`
  input — no role, no tab stop, no way in at all).
- `ink-faint` was 2.56:1 on paper and used as *text* in 42 places. Now
  `#6C6E68`, 4.81:1.
- Security: an XXE in **our own** SVG pre-parsing (not, as first flagged, in
  cairosvg — which was already safe); rate limits on the two write endpoints;
  a request-body ceiling; security headers; a container that no longer runs as
  root.
- Every unresolved fact lives in `web/src/lib/project-info.ts` and renders as a
  visible oxblood marker if left unfilled. `CITATION.cff` and the site citation
  block read from the same place.

## What this changes about the shipped bundle

The scorer's refusal was total; it is now partial, and the partition is the
point.

| | before this pass | after |
|---|---|---|
| sequence families | 0 | **281** (747 clusters) |
| genomes under a clustering run | 0 | **505** |
| clusters that produce a score | 0 of 2,437 | **1,227 of 2,437** |
| placements graded strong | 1,589 | 1,557 (32 demoted) |

The 1,227 split cleanly by how much evidence exists for them:

- **747 clusters score on 4 of 5 components** — in a sequence family, on a
  genome the run reached.
- **480 score on 2 of 5** — on a covered genome, in no family (which is now a
  finding rather than a silence).
- **1,210 decline entirely** at 1 of 5, below the two-component threshold:
  nothing ever compared them.

`class_rarity_in_clade` is still uncomputable **for every cluster in the
corpus**, and `bgcscape coverage` still reports **0 of 1,542 genomes examined**
(1,521 curated-only, 21 unexamined). That is correct and unchanged: a
*sequence-clustering* run is not a *cluster-detection* run. Nothing here has
surveyed a genome, so no absence in this corpus is yet evidence. An antiSMASH
run remains the single highest-value thing to add.

## What is verified, and how

- **Engine suite on SQLite: 398 passed, 4 skipped** (Cairo absent locally).
  Postgres 16 was **not** re-run this pass — the last full dual-dialect run
  predates the security and placement work.
- The placement re-grade against the real bundle: 989 genomes compared, 6
  conflicted, 32 demotions, and the 31 Sorangium/Chondromyces placements under
  `Myxococcota_A` correctly left alone.
- The BiG-SCAPE ingest end to end: 3,459,765 edges → 282 components → 802
  records in 289 families; `created=747, updated=0, skipped=55`, where the 55
  are BGC0003xxx entries postdating this corpus's MIBiG snapshot and are
  counted separately from errors.
- The scorer against the migrated bundle: 1,227 of 2,437 score, with the
  4/5–2/5–1/5 split above, and every caveat naming its denominator.
- The XXE fix measured rather than assumed: a 359-byte billion-laughs document
  expands to 1,000,000 characters in 0.02s through stdlib `xml.etree`, and is
  refused through the shared `_parse_svg`. Parametrised over all three entry
  points.
- Rate limiting exercised **on** in the suite, with an autouse fixture clearing
  counters between tests, so what ships is what is tested.
- The built site in a real Chromium: five routes plus the 404 answer, every
  internal link 200, all six external links 200, exactly one `h1` per page with
  no level skipped, no missing alt, no horizontal overflow at 320/390/768/1440,
  and zero cookies, zero localStorage, zero CSP violations, zero console errors
  throughout.
- The citation block renders both authors with no placeholder object and no
  stray `undefined` — the two failure modes that look like finished copy.
- Everything carried forward from earlier passes: migrations empty → head →
  base → head on both dialects with CHECK constraints intact, ingestion
  idempotency by row count for all five sources, the placement backfill on real
  data, `inspect-figure` with `BGCSCAPE_DATABASE_URL` unset, and the suite
  inside the production image where the PDF tests actually run.

## What is still unverified — read this before trusting it

1. **The Playwright suite has not been re-run since the policy and security
   work.** 69 specs over 11 files, all written against the single-route app.
   The four policy pages, the 404, the consent checkbox and the rebuilt upload
   button have **no e2e coverage at all**, and the CSP and security headers are
   new since the last green run. This is the largest verification gap.
2. **Postgres has not been re-run this pass.** The new migration
   (`e2b6c04f8a13`) round-trips on SQLite here; the dual-dialect claim is
   inherited, not re-observed.
3. **Four facts are deferred by construction**, and render as visible markers
   until supplied: the Zenodo DOI (needs an archived release), the paper
   citation (needs a paper), the hosting providers/regions and the
   platform-cookie check (both need a live domain). None can be resolved from
   this repository.
4. **No cluster-detection coverage anywhere in the corpus.** `class_rarity_in_
   clade` is uncomputable for all 2,437 clusters and `coverage` reports 0
   examined. Only an antiSMASH run — or `record-analysis-run` over one already
   performed — changes this.
5. **The scoring weights remain uncalibrated, by design.** Uniform, because
   choosing otherwise encodes a scientific judgement that belongs to the
   researcher.
6. **The unclustered-scores-high-by-construction bias is named, not fixed.** It
   now bites in a new place: the 480 clusters scoring on 2 of 5 components are
   scoring high on "unclustered" precisely because nothing matched them.
   Surfaced in a per-cluster caveat.
7. **One browser test fails and predates all of this.** `mobile.spec.ts ›
   pinch zooms the canvas` — the CDP multi-touch gesture produces no scale
   change; confirmed pre-existing by reverting `TreeCanvas.tsx` and watching it
   fail identically. Likely Playwright/Chromium drift.
8. **E2E tests are still not in CI.** They need a workflow that starts both
   servers and a database.
9. **The frontend still uses the eager `/taxonomy-tree`.** The lazy endpoint is
   6.7x faster, but porting is real work (fetch-on-expand, cache invalidation,
   focus interaction) and export needs a complete figure either way.
10. **BiG-FAM's bulk `membership_value` scale is unverified** against the web
    export's RADIUS, which the ingest thresholds at 900. The checked-in GCF
    200948 fixture is the way to settle it before paying for a 17 GB download.

## Deferred by choice

CORASON integration · phylogeny (needs MAFFT/IQ-TREE orchestration) ·
sequence-level divergence and domain-architecture scoring components ·
full per-field multi-source provenance · `similarity_score` on family
memberships (BiG-SCAPE's clustering TSV carries no pairwise distances).

## Environment notes

- Postgres for tests: `BGCSCAPE_TEST_DATABASE_URL` (note the `_TEST_` — the
  fixture drops and recreates the schema). A container is enough:
  `docker run -d -e POSTGRES_PASSWORD=bgcscape -e POSTGRES_USER=bgcscape -e POSTGRES_DB=bgcscape -p 55432:5432 postgres:16`
- The `export` extra needs Cairo system libraries (`libcairo2`); `defusedxml`
  is a **core** dependency and must not be moved into that extra.
- Browser tests: `npx playwright install chromium`, start uvicorn and
  `next start`, then `npm run e2e` from `web/`.
- Rate limits are on by default: `BGCSCAPE_WRITE_RATE_LIMIT` (20) per
  `BGCSCAPE_RATE_LIMIT_WINDOW` (300s), and `BGCSCAPE_MAX_REQUEST_MB` (160).
- `NEXT_PUBLIC_SITE_URL` must be set for a real deploy, or `og:image` goes
  relative and `sitemap.xml` advertises localhost.
- **A database built before this pass must be migrated** — see DEPLOY.md,
  "Upgrading a database built before this change" and "Re-grading placements
  against NCBI's own taxonomy".

## How to resume

1. **Re-run the Playwright suite and extend it to the new routes** (item 1).
   This is the cheapest way to close the largest gap, and the policy pages
   were verified by hand in a browser but never pinned by a test.
2. **Ingest a real antiSMASH run.** Still the single highest-value data action:
   it is what makes any absence in this database evidence, and what makes class
   rarity computable at all. For genomes a run examined and found nothing in,
   use `bgcscape record-analysis-run`.
3. **Re-run the engine suite against Postgres 16** to restore the dual-dialect
   claim (item 2).
4. **Resolve the DOI** by cutting a GitHub release with Zenodo enabled — it is
   the only one of the four deferred facts that is entirely in your hands, and
   it unblocks the citation block, `CITATION.cff` and the availability
   statement together.
5. **Wire the e2e tests into CI**, and diagnose the pinch failure (item 7).
