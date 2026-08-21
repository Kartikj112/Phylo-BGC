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
  row ingested from antiSMASH output should carry
  `evidence_level = PREDICTED`, never `OBSERVED_CURATED`.

## NCBI / GenBank

- Public sequence data; standard NCBI usage terms apply (no login required
  for bulk download, but an NCBI API key raises rate limits significantly
  for automated retrieval — flagged in the original report and still
  relevant for any Phase 1b ingestion at scale).

## BiG-SCAPE / CORASON

- Analysis tools invoked as external dependencies, per the architecture's
  separation-of-concerns principle. Their *outputs* (family assignments,
  BGC-family phylogenies) are stored as `evidence_level = COMPUTED` rows
  with `Source.source_type = TOOL_RUN`, carrying the specific tool version
  and parameters used, since a re-run with different parameters is a
  materially different scientific claim.

## Search provenance for this document

- MIBiG version/entry counts and license language: MIBiG 4.0 paper
  (Nucleic Acids Research, 2024/2025 rolling description) and MIBiG 2.0/3.0
  papers (PMC), plus the `mibig-secmet` GitHub organization.
- GTDB release number and license: gtdb.ecogenomic.org (live site and
  `/licenses` page) and Wikipedia's Genome Taxonomy Database summary infobox.
