# Data sources: licensing and versioning notes

Phylo-BGC's `Source` table (see `engine/src/bgcscape/models/source.py`) requires
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
- **Code license (if Phylo-BGC ever vendors MIBiG tooling):** the
  `mibig-html` repo is AGPL-3.0; the `mibig-api` REST server is Apache-2.0.
  These are two different repos with two different licenses — check the
  specific one you're touching.
- **Action for Phylo-BGC:** treat MIBiG data as safe to ingest and
  redistribute in derived/transformed form (that is the resource's explicit
  purpose), but do not vendor `mibig-html`/AGPL code into Phylo-BGC's own
  codebase without separately satisfying AGPL's terms.
- **URL:** https://mibig.secondarymetabolites.org/

## GTDB (Genome Taxonomy Database)

- **Current release observed:** R11-RS232 (15 April 2026), 901,341 genomes.
  An earlier release, R10-RS226, is the one described in GTDB's most recent
  Nucleic Acids Research paper — releases roll faster than papers publish,
  so always take the live site/download page as the source of truth for
  "current."
- **Data license:** **CC BY-SA 4.0**, stated explicitly on GTDB's own
  `/licenses` page. This is a ShareAlike license: any Phylo-BGC view or
  derived dataset built from GTDB taxonomy must itself be redistributable
  under CC BY-SA 4.0 (or a compatible license) and must carry attribution.
  This is a real constraint on Phylo-BGC's own output licensing for
  taxonomy-derived data, not just an ingestion footnote.
- **Toolkit license (GTDB-Tk):** GPL-3.0 — separate from the data license
  above, applies only if Phylo-BGC ever bundles GTDB-Tk itself rather than
  shelling out to / calling a separately-installed copy.
- **URL:** https://gtdb.ecogenomic.org/ · downloads at
  https://gtdb.ecogenomic.org/downloads

## antiSMASH / antiSMASH DB

- **Code license:** AGPL-3.0. Per the original Phylo-BGC report (§9): if
  Phylo-BGC ever incorporates antiSMASH *source code* directly, AGPL's
  network-use copyleft terms apply. The safer, already-chosen architecture
  is to treat antiSMASH as an external analysis dependency invoked as a
  subprocess/service and to store only its *output* (predictions), not its
  code.
- **Data (antiSMASH DB predictions):** predicted, not curated — every BGC
  row ingested from antiSMASH output carries
  `evidence_level = PREDICTED`, never `OBSERVED_CURATED`.
- **antiSMASH is the only source that establishes cluster-detection
  coverage.** Ingesting its output records an `AnalysisRun` over the genome
  it examined (see `engine/src/bgcscape/models/analysis.py`), which is what
  makes "this genome has no clusters" a finding rather than a gap. A run that
  found nothing still records coverage, with `bgcs_recorded = 0` — that row
  is the whole point. MIBiG deliberately records none: a curated entry is a
  report that one cluster exists, not a survey of a genome.
- **Phylo-BGC does not vendor any antiSMASH code** —
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

## NCBI Taxonomy

- **Used for:** eukaryote lineages. GTDB is prokaryote-only, so MIBiG's fungi
  and plants (*Aspergillus*, *Penicillium*, *Fusarium*, *Arabidopsis* —
  roughly a fifth of the characterized clusters) have no GTDB representation
  at all and arrive as bare species with nothing above them. Every one
  already carries an `ncbi_taxid` from MIBiG, so placement is a direct
  lookup, not a name match.
- **Data license:** public domain (a US Government work). NCBI requests
  citation but imposes no restriction on use or redistribution.
- **Version pinning:** `taxdump.tar.gz` is a rolling file with no version
  number, so `bgcscape ingest ncbi-taxonomy --version` records the download
  date and that string lands on the `Source` row and in exported figures.
- **Files needed:** `nodes.dmp`, `names.dmp`, `merged.dmp` (the last one
  matters: NCBI retires taxids by merging them, and MIBiG entries can predate
  a merge).
- **Ranks kept:** the canonical Linnaean set only — domain, kingdom, phylum,
  class, order, family, genus, species. Measured across the 271 organisms
  this actually places, `clade` alone appears 958 times and `no rank` 70;
  keeping them would triple the depth of every lineage without adding a rank
  a biologist would cite. Organisms NCBI ranks below species (62 are `strain`,
  e.g. *Aspergillus nidulans* FGSC A4) hang under their species.
- **NOT merged with GTDB.** The two are different methodologies that
  disagree, so the interface serves them as separate views — the "Tree" tab
  is GTDB, "Eukaryotes" is NCBI, and the header names whichever is on screen.
  A merged tree would be a hybrid a reader could not pick apart.
- **URL:** https://www.ncbi.nlm.nih.gov/taxonomy · dumps at
  https://ftp.ncbi.nlm.nih.gov/pub/taxonomy/

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
    transformation needed, and no convention invented by Phylo-BGC.
  - A `Family` label is only meaningful **within one cutoff** — the same
    label at a different cutoff is a different grouping. Phylo-BGC keys
    families on `(source_id, label, clustering_cutoff)` accordingly.
  - Ingesting a clustering records a `SEQUENCE_CLUSTERING` `AnalysisRun`
    over the genomes whose regions the file actually matched — **not** the
    whole corpus. Without that scoping, one run over ten genomes would make
    every other cluster in the database read as "no similar cluster found",
    which is a similarity claim about clusters nothing ever compared.
  - Real BiG-SCAPE runs commonly mix in MIBiG reference BGCs for
    comparison. These now match: MIBiG ships one GenBank per entry named
    `<accession>.gbk`, and BiG-SCAPE reports that filename stem in `GBK`,
    so MIBiG ingestion sets `external_ref` to the accession and the rows
    join directly. Rows matching nothing at all are still reported as
    `skipped`, distinctly from errors.

## BiG-SLiCE / BiG-FAM

- **Two names, one dataset.** BiG-FAM 1.0 publishes the Gene Cluster
  Families produced by the BiG-SLiCE paper run; the web database and the
  bulk files are the same clustering. Phylo-BGC *reads* those families
  rather than computing any, which is the only reason a real GCF can be
  shown here at all — see `ingest/bigfam.py`.
- **Licence: CC-BY**, stated on the paper-data index. Attribution therefore
  travels on the `Source` row, and any figure drawing on these families
  must cite the BiG-SLiCE paper. This is a *more* permissive licence than
  the corpus's other sources, not a waiver of attribution.
- **Snapshot date: July 2020** (`data.db` mtime 2020-07-17). 1,225,071 BGCs
  over 209,206 genomes **as they existed then**. This matters for joins:
  GTDB here is R11-RS232 (April 2026), so assemblies deposited after 2020
  cannot appear — the five mislabelled MAGs behind the placement audit
  included. Coverage against this corpus is partial by construction and
  must be reported, never assumed.
- **Bulk location and real size**, verified 2026-09-03 against the live
  index at `www.bioinformatics.nl/~kauts001/ltr/bigslice/paper_data/`:
  the widely-quoted 189 GB is `subpfam_sources` (144 GB, HMM training
  material) plus `full_input_data` (28 GB, input GenBanks) plus
  `full_run_result` (17 GB). Only the last holds families. Serving is
  Apache directory-listing over `https://www.bioinformatics.nl` — note the
  `www.`, the bare hostname's certificate does not cover it.
- **Checksums are per-zip only.** `MD5SUMS_data.txt` is 162 bytes: one
  entry for each of the three archives, none for the unpacked tree the
  server also exposes. Fetching `result/data.db` (42 GB) directly is
  faster but unverifiable.
- **Format: a BiG-SLiCE SQLite**, schema at
  `bigslice/modules/data/schema.sql` in the tool's own source (Zenodo
  record 3975432 is that source code, *not* data — nothing in it is
  ingestible). Relevant tables:
  `gcf(id, id_in_run, clustering_id)`,
  `gcf_membership(gcf_id, bgc_id, membership_value, rank)`,
  `bgc(id, dataset_id, name, type, orig_folder, orig_filename, length_nt)`.
  `orig_folder`/`orig_filename` carries the assembly + region pair that
  `ingest/bigfam.py` already splits, so the practical path is a script that
  emits the web export's TSV shape rather than a second ingest module.
- **Unverified, and load-bearing:** whether `membership_value` here is on
  the same scale as the web export's `RADIUS`, which the ingest thresholds
  at 900 to exclude putative members. Check against
  `tests/fixtures/bigfam_gcf_200948_members.tsv` before relying on either.

## CORASON

- Analysis tool invoked as an external dependency, same treatment as
  BiG-SCAPE above. Not yet integrated.

## Search provenance for this document

- MIBiG version/entry counts and license language: MIBiG 4.0 paper
  (Nucleic Acids Research, 2024/2025 rolling description) and MIBiG 2.0/3.0
  papers (PMC), plus the `mibig-secmet` GitHub organization.
- GTDB release number and license: gtdb.ecogenomic.org (live site and
  `/licenses` page) and Wikipedia's Genome Taxonomy Database summary infobox.
- BiG-SLiCE/BiG-FAM bulk layout, sizes and dates: the live Apache index at
  `www.bioinformatics.nl/~kauts001/ltr/bigslice/paper_data/`, walked
  2026-09-03 down to `data/full_run_result/result/data.db`. Schema read
  from `medema-group/bigslice`, `bigslice/modules/data/schema.sql`.
  BGC/genome counts from the BiG-FAM paper (PMC7778980).

---

## MIBiG: two live schemas, verified by ingesting the real repository

**Verified 2026-08-26 by ingesting all 2,745 entries from
`mibig-secmet/mibig-json` (commit 20979549, 2024-03).**

The bulk repository ships **MIBiG 3.x**, while the website serves 4.0.
Both are live, so the parser detects and handles both. The differences
are not cosmetic:

| | 3.x (bulk repo) | 4.0 (website) |
|---|---|---|
| envelope | `{changelog, cluster:{...}}` | flat |
| accession | `cluster.mibig_accession` | `accession` |
| classes | `biosyn_class: ["Polyketide","NRP"]` | `biosynthesis.classes[].class: ["PKS","NRPS"]` |
| loci | single object | list |
| taxid | `ncbi_tax_id` as **string** | `taxonomy.ncbiTaxId` as int |
| compounds | `compound`/`chem_struct`/`molecular_formula` | `name`/`structure`/`formula` |

Note the vocabulary shift: 3.x names the **product** ("Polyketide",
"NRP"), 4.0 names the **machinery** ("PKS", "NRPS"). A parser that
assumed one vocabulary silently classes the other as `OTHER`.

Real distribution across 2,526 active entries: PKS 612, hybrid 476,
NRPS 472, RiPP 331, other 302, terpene 150, saccharide 130, alkaloid 53.
519 entries are multi-class. Only 51% carry coordinates, and coordinates
can be **half-present** — 1,408 entries have `start_coord` but only 1,407
have `end_coord`.

### MIBiG alone gives no taxonomic hierarchy

This is the finding that matters most for anyone loading real data.
MIBiG records `organism_name` and `ncbi_tax_id` — a species name and
nothing above it. Ingesting MIBiG by itself therefore produces **1,527
species nodes all directly under the root, with a maximum tree depth of
1**. It is not a tree; it is a fan.

GTDB (or NCBI taxonomy) is what supplies domain → phylum → class → order
→ family → genus. The two sources are complementary by design, and the
cross-source merge built in Phase 1b is what joins them — MIBiG's
`ncbi_taxid` against GTDB's `(rank, name)`.

A useful real corpus therefore needs GTDB ingested *as well as* MIBiG,
not instead of it.
