# Phylo-BGC

**Interactive exploration of biosynthetic diversity across the tree of life.**

Phylo-BGC connects four layers that are normally analyzed in disconnected
tools: organismal phylogeny → BGC repertoire → BGC families → known/putative
products. It is not another BGC predictor or clustering algorithm — it's the
exploration and interpretation layer over established tools and databases
(MIBiG, antiSMASH, GTDB, BiG-SCAPE, CORASON, MAFFT, IQ-TREE).

See `ARCHITECTURE.md` for design rationale and `PROGRESS.md` for what's
actually built vs. planned. **Read `PROGRESS.md` first if you're resuming
work on this project.**

## Use it online

No installation: **https://phylo-bgc.vercel.app**. The free API behind it
sleeps when idle, so the first visit after a quiet spell can take up to a
minute to load.

## Run it on your computer

The whole tool runs on your own computer, with its dataset included: all
2,437 MIBiG 4.0 reference clusters, placed on the GTDB tree (bacteria and
archaea) and the NCBI tree (fungi and plants). You do not need to download
data or set up a database. One optional extra, the **"All GTDB genomes"**
view, downloads GTDB's taxonomy the first time you ask for it (see below).

### What you need

| | Required | Notes |
|---|---|---|
| **Python** | 3.11 or newer | [python.org/downloads](https://www.python.org/downloads/). On Windows, tick *Add python.exe to PATH* in the installer. |
| **Node.js** | 20.9 or newer | The LTS version from [nodejs.org](https://nodejs.org/). npm comes with it. |
| **Disk space** | about 1.5 GB | Most of it is the website's packages. Add about 0.5 GB for the GTDB view. |
| **Memory** | 2 GB free | Loading GTDB needs about 0.5 GB more for a few minutes. |
| **Internet** | first run only | To install packages, and once to fetch GTDB if you want it. After that it runs offline. |
| Git | optional | Or download the code as a ZIP. |

Works on Windows 10/11, macOS and Linux. Instead of Python and Node.js you
can use [Docker Desktop](https://www.docker.com/products/docker-desktop/)
(Option B).

### Option A: one script (recommended)

1. **Get the code.** Either `git clone https://github.com/Kartikj112/Phylo-BGC.git`,
   or on GitHub click the green **Code** button → **Download ZIP** and unzip it.
2. **Open a terminal in that folder** (the one with `start.sh` in it) and run:

   | Your computer | Command |
   |---|---|
   | macOS / Linux | `bash start.sh` |
   | Windows (PowerShell) | `powershell -ExecutionPolicy Bypass -File .\start.ps1` |
   | Windows (Git Bash) | `bash start.sh` |

3. **Open http://localhost:3000** in your browser. Press **Ctrl+C** in the
   terminal to stop.

The first run installs everything and builds the website, which takes about
5 minutes. Later runs start in seconds. The script keeps its Python packages
in `engine/.venv`, so your system Python is not touched.

#### Turn on "All GTDB genomes" (optional)

By default the tree shows the organisms this dataset records clusters for,
about 1,100 genomes. The **All GTDB genomes** button draws the rest of
GTDB's ~900,000 genomes behind them, so you can see how much of the tree
nobody has examined. Start once with:

| Your computer | Command |
|---|---|
| macOS / Linux / Git Bash | `WITH_GTDB=1 bash start.sh` |
| Windows (PowerShell) | `powershell -ExecutionPolicy Bypass -File .\start.ps1 -WithGtdb` |

This downloads about 300 MB from GTDB (checked against GTDB's published
checksums) and loads it, which takes 3 to 10 minutes. It only happens once;
after that the button is there on every start, with or without the option.
The downloaded files are kept in `~/.cache/bgcscape/gtdb` so a reload does
not download them again. You can delete that folder once loading is done.
The button appears on the **Prokaryotes** tab; eukaryotes have no
whole-taxonomy view yet.

#### Other options

| What | macOS / Linux / Git Bash | Windows (PowerShell) |
|---|---|---|
| Start again from the original data (throws away your uploads and GTDB) | `FRESH=1 bash start.sh` | `.\start.ps1 -Fresh` |
| Use other ports, if 3000 or 8000 is taken | `WEB_PORT=3100 API_PORT=8100 bash start.sh` | `.\start.ps1 -WebPort 3100 -ApiPort 8100` |
| Live-reloading development mode | `DEV=1 bash start.sh` | `.\start.ps1 -Dev` |

Your antiSMASH uploads are saved in `engine/data/local.db`, a working copy of
the bundled data. The bundled file itself is never changed, so `git pull`
keeps working.

### Option B: Docker

With [Docker Desktop](https://www.docker.com/products/docker-desktop/) you
need nothing else. In the code folder:

```bash
docker compose up --build
```

Then open **http://localhost:3000**. To add the "All GTDB genomes" view, run
this once while it is up (downloads ~300 MB, takes a few minutes):

```bash
docker compose exec api bgcscape fetch-gtdb-backbone
```

Then reload the page. Uploads and GTDB are kept between runs;
`docker compose down -v` resets everything to the bundled data.

### What works on your computer

Everything the website does works locally: browsing, search, the family
browser, the comparison and prioritization panels, antiSMASH upload, "All
GTDB genomes" and SVG export. **PDF export** needs the Cairo graphics library.
The Docker option includes it. With the script, install Cairo yourself
(`brew install cairo` on macOS, `sudo apt install libcairo2` on Debian/Ubuntu)
and then run `engine/.venv/bin/pip install -e "engine[export]"`.

### If something goes wrong

- **"Python 3.11 or newer is required"** or **"Node.js 20.9 or newer is
  required"**: install it from the link in the table above, then open a *new*
  terminal so it is found.
- **"Is port 8000 already in use?"**: another program is using that port.
  Choose different ports as shown above.
- **PowerShell says running scripts is disabled**: use the exact command
  above; `-ExecutionPolicy Bypass` allows this one script only.
- **"Loading GTDB failed"**: usually a dropped connection. Run the same
  command again; files already downloaded and verified are not fetched twice.
  The tool works without GTDB in the meantime.
- **No "All GTDB genomes" button**: it only appears on the Prokaryotes tab,
  and only after GTDB has been loaded (see above).
- **The page loads but the tree is empty**: the API may have stopped. Look at
  the terminal for an error, then run the script again.

## Developer setup

The rest of this file is for people changing the code. To just use the tool,
see **Run it on your computer** above.

### Repository layout

```
Phylo-BGC/
├── engine/                Python scientific engine: data model, ingestion,
│                           visualization API. No biological logic lives in
│                           the frontend; see ARCHITECTURE.md's separation
│                           of concerns.
├── web/                   Next.js/TypeScript/D3 frontend.
│   └── design-prototype/   Interactive design prototype (not production code).
├── docs/
│   └── DATA_SOURCES.md    Per-source licensing/versioning notes.
├── start.sh / start.ps1  One-command local run (see above).
├── docker-compose.yml     The whole app in Docker; Postgres + Adminer on request.
└── PROGRESS.md            Build status and phase tracker.
```

### Quickstart (developers)

```bash
# 1. Engine + database
cd engine
pip install -e ".[dev,api,export]"   # export extra needs libcairo2
docker compose -f ../docker-compose.yml up -d postgres   # or use SQLite, see .env.example
cp ../.env.example ../.env
alembic upgrade head

# 2. Ingest some data (curated test fixtures ship with the repo; real
#    MIBiG/GTDB downloads are a separate step — see docs/DATA_SOURCES.md)
bgcscape ingest gtdb tests/fixtures/gtdb_metadata_test.tsv
bgcscape ingest mibig tests/fixtures/mibig/
bgcscape ingest antismash tests/fixtures/antismash_test_result.json \
    --genome-accession GCF_TEST900001.1
bgcscape ingest bigscape tests/fixtures/mix_clustering_c0.3.tsv
# Real Gene Cluster Families come from BiG-FAM's precomputed families, read
# rather than clustered: `bgcscape ingest bigfam <a GCF's member export>`.
# Its members must be on genomes you have ingested, so it is not part of
# this fixture-only walkthrough — see DEPLOY.md, "Getting real GCFs".
# The whole GTDB taxonomy for the "All GTDB genomes" view (optional; ~300 MB
# download, a few minutes): `bgcscape fetch-gtdb-backbone`.

# 3. API
uvicorn bgcscape.api.app:app --reload   # http://127.0.0.1:8000

# 4. Frontend (in another terminal)
cd ../web
npm install
cp .env.local.example .env.local
npm run dev                              # http://localhost:3000

# Tests
cd ../engine && pytest -v          # 452 tests (4 skip without Cairo)
cd ../web && npm test               # 225 tests

# Browser-level end-to-end tests (real Chromium). These cover the paths unit
# tests cannot reach — the export button's download, a real CORS preflight,
# middle-drag pan, semantic zoom. Both servers must already be running.
cd ../web && npx playwright install chromium   # once
npm run e2e                                    # 69 tests

# Run the engine suite against real Postgres instead of SQLite:
#   BGCSCAPE_TEST_DATABASE_URL=postgresql+psycopg://user:pass@localhost:5432/bgcscape_test pytest -v
# (Note the _TEST_ in the variable name — it's deliberately distinct from
# BGCSCAPE_DATABASE_URL, because the test fixture drops and recreates the
# schema between tests.)
```

## Citing Phylo-BGC

If you use Phylo-BGC in published work, please cite it. Machine-readable
metadata is in [`CITATION.cff`](CITATION.cff) — GitHub renders a "Cite this
repository" button from it, and Zenodo reads it when minting a DOI.

**Also cite the resources your result depends on.** Phylo-BGC detects no
clusters and clusters no sequences; it integrates MIBiG, GTDB, NCBI Taxonomy,
antiSMASH and BiG-SCAPE. GTDB is CC BY-SA 4.0, which *requires* attribution and
places ShareAlike conditions on redistributing taxonomy-derived output — worth
checking against your journal's figure-licensing terms. Per-source licences are
listed at `/data-sources` on the running site and in
[`docs/DATA_SOURCES.md`](docs/DATA_SOURCES.md).

**Reproducibility.** Every exported figure embeds a machine-readable record of
the exact source versions and corpus counts it was drawn from, and the same
record is served live at `/api/v1/provenance`. The schema requires every stored
fact to name its source and evidence level, so a figure cannot be produced from
rows whose provenance is unrecorded.

**Before submitting anywhere**, resolve the remaining `TODO` items in
`CITATION.cff` and `web/src/lib/project-info.ts`. Authors, ORCIDs, affiliation
and contact are filled in; what is left is a **Zenodo DOI** (cut a GitHub
release with Zenodo enabled) and a **paper citation** once one exists. Two
further markers — hosting providers/regions on `/privacy`, and the
platform-cookie check on `/cookies` — can only be resolved against a live
domain. Those files drive the citation block, the availability statement and
the policy pages, so filling them completes all of it at once.

## Status

Phases 1a/1b/1c (data model; MIBiG, GTDB, antiSMASH, BiG-SCAPE ingestion),
Phase 2 (visualization API + production frontend), Phase 3 (BGC-family
highlighting + comparative clade analysis), Phase 4 (publication-grade
SVG/PDF export with embedded, replayable view configs), and Phase 5 (user
uploads + BGC prioritization scoring) are complete and tested — **against
both SQLite and real PostgreSQL 16**.

**All five roadmap phases are now implemented**, and a pre-submission pass has
added the policy pages, accessibility fixes, security controls (rate limits,
body caps, an XXE fix in the SVG pre-parser, a non-root container) and
machine-readable citation metadata that a journal submission needs.

The shipped corpus now carries **real sequence families** — 281 of them over
747 clusters, from a BiG-SCAPE 2.0.3 run — alongside the 279 curated compound
groups, and the two are never pooled. 1,227 of 2,437 clusters now produce a
prioritization score; the rest correctly decline, because nothing has compared
them. No genome in the corpus has been covered by a *cluster-detection* run
yet, so no absence in it is evidence — ingesting antiSMASH output is the next
high-value step.

See `PROGRESS.md` for what remains genuinely unverified, and `ARCHITECTURE.md`
for design rationale.

## Acknowledgements

The author gratefully acknowledges the Director, CSIR–National Institute of
Oceanography (CSIR-NIO), Goa, for institutional support and access to
facilities, and Dr. Narsinh L. Thakur for his guidance, encouragement and
support throughout the development of this work.
