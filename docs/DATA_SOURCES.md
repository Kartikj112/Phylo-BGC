# Data sources: licensing and versioning notes

BGC-scape's `Source` table (see `engine/src/bgcscape/models/source.py`) requires
every ingested row to name its origin, version, and license explicitly. This
document is the human-readable companion to that table: the place to check
*before* writing an ingestion pipeline against a new resource, and the place
to update whenever a source's terms or release numbering changes.

Verified 2026-08-21 (searches cited below). **Re-check before any ingestion
run** — reference database releases and licensing pages change independently
of this repo.

## MIBiG (Minimum Information about a Biosynthetic Gene cluster)

- **Current version:** MIBiG 4.0 (3,059 curated entries as of the 4.0
  publication — a "rolling release," so the live site will have moved on).
- **Data license:** Not pinned to a single named license badge on the
  repository itself, but the MIBiG 2.0/3.0 papers state explicitly that
  there is "no access restriction for academic or commercial use of the
  repository and its data," and the source code, JSON data-standard schema,
  and SQL schema are published on GitHub under OSI-approved licenses. The
  MIBiG 4.0 paper itself (the description of the resource, not the dataset)
  is CC BY 4.0.
- **Code license (if BGC-scape ever vendors MIBiG tooling):** the
  `mibig-html` repo is AGPL-3.0; the `mibig-api` REST server is Apache-2.0.
  These are two different repos with two different licenses — check the
  specific one you're touching.
- **Action for BGC-scape:** treat MIBiG data as safe to ingest and
  redistribute in derived/transformed form (that is the resource's explicit
  purpose), but do not vendor `mibig-html`/AGPL code into BGC-scape's own
  codebase without separately satisfying AGPL's terms.
- **URL:** https://mibig.secondarymetabolites.org/

## GTDB (Genome Taxonomy Database)

- **Current release observed:** R11-RS232 (15 April 2026), 901,341 genomes.
  An earlier release, R10-RS226, is the one described in GTDB's most recent
  Nucleic Acids Research paper — releases roll faster than papers publish,
  so always take the live site/download page as the source of truth for
  "current."
- **Data license:** **CC BY-SA 4.0**, stated explicitly on GTDB's own
  `/licenses` page. This is a ShareAlike license: any BGC-scape view or
  derived dataset built from GTDB taxonomy must itself be redistributable
  under CC BY-SA 4.0 (or a compatible license) and must carry attribution.
  This is a real constraint on BGC-scape's own output licensing for
  taxonomy-derived data, not just an ingestion footnote.
- **Toolkit license (GTDB-Tk):** GPL-3.0 — separate from the data license
  above, applies only if BGC-scape ever bundles GTDB-Tk itself rather than
  shelling out to / calling a separately-installed copy.
- **URL:** https://gtdb.ecogenomic.org/ · downloads at
  https://gtdb.ecogenomic.org/downloads

## antiSMASH / antiSMASH DB

- **Code license:** AGPL-3.0. Per the original BGC-scape report (§9): if
  BGC-scape ever incorporates antiSMASH *source code* directly, AGPL's
  network-use copyleft terms apply. The safer, already-chosen architecture
  is to treat antiSMASH as an external analysis dependency invoked as a
  subprocess/service and to store only its *output* (predictions), not its
  code.
- **Data (antiSMASH DB predictions):** predicted, not curated — every BGC
  row ingested from antiSMASH output carries
  `evidence_level = PREDICTED`, never `OBSERVED_CURATED`.
- **BGC-scape does not vendor any antiSMASH code** —
  `engine/src/bgcscape/ingest/antismash.py` is an independently-written
  parser for antiSMASH's *output format*, not a derivative of the
  AGPL-licensed program itself.
- **Output format, verified 2026-08-24** against the `antismash/antismash`
  GitHub source (read directly, not assumed from an older version):
  - Top-level result JSON: `version`, `input_file`, `taxon`, `schema`
    (currently 4), `records[]` — defined in
    `antismash/common/serialiser.py`.
  - Per-record: `id`, `description`, `areas[]` (the regions).
  - Per-area: `start`, `end`, `products[]`, `protoclusters{}`,
    `candidates[]`, `subregions[]`.
  - **Important, and a real trap:** `area["products"]` holds antiSMASH's
    *specific rule names* ("T1PKS", "NRPS-like", "lanthipeptide-class-i",
    …) — dozens of possible values. The broad 7-value category vocabulary
    that maps onto `BGCClass` lives one level down, on each protocluster's
    `category` field, defined in
    `antismash/detection/hmm_detection/data/categories.json`: PKS, NRPS,
    RiPP, terpene, saccharide, alkaloid, other. Mapping from `products`
    instead produces wrong classifications — this project made exactly
    that mistake and caught it in testing.
  - **antiSMASH's JSON has no assembly-accession field at all.** Its
    output is organized per-run over input sequences, not per-assembly.
    Linking a run back to a `GCA_`/`GCF_` accession is the caller's job;
    `bgcscape ingest antismash` therefore requires `--genome-accession`
    explicitly rather than guessing.
  - Per-region GenBank filename convention:
    `f"{record.id}.region{number:03d}.gbk"`, from
    `antismash/common/secmet/features/region/structures.py`. This is the
    join key to BiG-SCAPE output (see below).

## NCBI / GenBank

- Public sequence data; standard NCBI usage terms apply (no login required
  for bulk download, but an NCBI API key raises rate limits significantly
  for automated retrieval — flagged in the original report and still
  relevant for any Phase 1b ingestion at scale).

## BiG-SCAPE

- Analysis tool invoked as an external dependency, per the architecture's
  separation-of-concerns principle. Its *outputs* (family assignments) are
  stored as `evidence_level = COMPUTED` rows with
  `Source.source_type = TOOL_RUN`, carrying the specific tool version and
  cutoff used, since a re-run at a different cutoff is a materially
  different scientific claim.
- **Output format, verified 2026-08-24** against the
  `medema-group/BiG-SCAPE` GitHub source
  (`big_scape/output/legacy_output.py`):
  - Clustering file: `{bin_label}_clustering_c{cutoff}.tsv`, columns
    `Record`, `GBK`, `Record_Type`, `Record_Number`, `CC`, `Family`.
  - `GBK` is the per-region GenBank filename *stem* — i.e. exactly
    antiSMASH's `{record_id}.region{NNN:03d}` convention above. This is
    the real cross-tool join key, stored on `BGC.external_ref` by
    antiSMASH ingestion and matched directly by BiG-SCAPE ingestion. No
    transformation needed, and no convention invented by BGC-scape.
  - A `Family` label is only meaningful **within one cutoff** — the same
    label at a different cutoff is a different grouping. BGC-scape keys
    families on `(source_id, label, clustering_cutoff)` accordingly.
  - Real BiG-SCAPE runs commonly mix in MIBiG reference BGCs for
    comparison. Those rows won't match any `external_ref` (MIBiG
    ingestion has no antiSMASH filename to derive one from), so they're
    reported as `skipped`, distinctly from errors.

## CORASON

- Analysis tool invoked as an external dependency, same treatment as
  BiG-SCAPE above. Not yet integrated.

## Search provenance for this document

- MIBiG version/entry counts and license language: MIBiG 4.0 paper
  (Nucleic Acids Research, 2024/2025 rolling description) and MIBiG 2.0/3.0
  papers (PMC), plus the `mibig-secmet` GitHub organization.
- GTDB release number and license: gtdb.ecogenomic.org (live site and
  `/licenses` page) and Wikipedia's Genome Taxonomy Database summary infobox.
