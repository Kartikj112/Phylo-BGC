# Deploying Phylo-BGC

Two independently deployed pieces:

| Piece | Host | Notes |
|---|---|---|
| `web/` Next.js frontend | **Vercel** | you already have this account; no card |
| `engine/` FastAPI API | **Render** or **Hugging Face Spaces** | both have a card-free free tier; pick one below |

The API image serves a **real read-only dataset** baked in
(`engine/gtdb_mibig_bundled.db`): all 2,437 active **MIBiG 4.0** reference
clusters mapped onto the **GTDB R11-RS232** tree. 1,849 (75%) are matched to a
specific GTDB genome; another 109 are placed at genus level, giving **80% on
the real domain-to-species backbone**. The remainder are
eukaryotes (GTDB is prokaryote-only) and sit in an "Unplaced organisms" group.
Only genomes that actually carry a characterized cluster are ingested -- 1,739
of GTDB's 879,000 -- which is what keeps the tree renderable. No database
service, no volume, no secrets required. Rebuilding that file, or moving to
antiSMASH + BiG-SCAPE on Postgres, is at the bottom of this file.

---

## 0. One-time setup

- **GitHub**: create an empty repo (private is fine), e.g. `bgc-scape`.
- **Vercel**: you have it.
- **API host** — one of:
  - **Render** — sign up with GitHub. Free web services currently need **no card**.
    If signup asks for one, use Hugging Face instead.
  - **Hugging Face** — sign up (GitHub or email). Never asks for a card.

## 1. Push the code to GitHub

From the repo root (`bgc-scape-v10/bgc-scape`):

```powershell
git add -A
git commit -m "GCF distribution UI + deploy config"
git branch -M main
git remote add origin https://github.com/<you>/bgc-scape.git
git push -u origin main
```

## 2a. Deploy the API — Render (recommended)

1. Render dashboard → **New → Blueprint** → connect the GitHub repo.
2. Render finds `render.yaml`, builds `engine/Dockerfile`, deploys.
3. You get `https://bgc-scape-api.onrender.com` (name may vary).

Verify:

```powershell
curl https://<your-service>.onrender.com/api/v1/health     # {"status":"ok"}
curl https://<your-service>.onrender.com/api/v1/provenance  # 2,437 BGCs
```

Free services spin down after ~15 min idle; the first request afterwards
takes ~30–60s while it restarts. Fine for a demo.

## 2b. Deploy the API — Hugging Face Spaces (alternative, never needs a card)

1. huggingface.co → **New Space** → SDK: **Docker** → blank template → Public.
2. The Space is a git repo. Put the API in it — from the repo root:

   ```powershell
   git clone https://huggingface.co/spaces/<you>/bgc-scape-api hf-space
   robocopy engine hf-space /E /XD .git __pycache__ /XF *.db
   cd hf-space
   ```

3. Add a `README.md` at the Space root with this frontmatter (Spaces require it):

   ```yaml
   ---
   title: Phylo-BGC API
   sdk: docker
   app_port: 7860
   pinned: false
   ---
   Read-only visualization API for Phylo-BGC. MIBiG 4.0 mapped onto GTDB.
   ```

4. In the Space's **Settings → Variables and secrets**, add a variable
   `PORT` = `7860` (the Dockerfile honours `$PORT`).
5. `git add -A && git commit -m "API" && git push`

The Space builds and serves at `https://<you>-bgc-scape-api.hf.space`.

## 3. Deploy the frontend to Vercel

Dashboard → **Add New… → Project** → import the GitHub repo:

| Setting | Value |
|---|---|
| **Root Directory** | `web` |
| Framework Preset | Next.js (auto) |

**Environment Variable** (add before the first deploy — it is inlined into the
client bundle at build time):

| Name | Value | Environments |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | your API URL from step 2 (no trailing slash) | Production, Preview |

Deploy → `https://<project>.vercel.app`.

## 4. (Optional) Lock the API's CORS to your frontend

The API defaults to `Access-Control-Allow-Origin: *`. To restrict it:

- **Render**: dashboard → the service → Environment → add
  `BGCSCAPE_CORS_ALLOW_ORIGINS` = `https://<project>.vercel.app` → it redeploys.
  (Or uncomment the block in `render.yaml`.)
- **Hugging Face**: Space Settings → Variables → add the same variable.

Comma-separate to also allow Vercel preview URLs.

## 4b. antiSMASH uploads (the one endpoint that writes)

`POST /api/v1/ingest/antismash` takes result JSONs from the browser, ingests
the regions, and grafts the genome onto the GTDB backbone. It is the only
write in the API, and it is **unauthenticated** — anyone who can reach the
deployment can add genomes to the shared corpus.

Two knobs, both read at import time:

| Variable | Default | Effect |
|---|---|---|
| `BGCSCAPE_ALLOW_UPLOADS` | `1` | Set to `0` for a read-only public deployment. The route then answers 403 and the dialog shows the reason. |
| `BGCSCAPE_MAX_UPLOAD_MB` | `128` | Per-file cap. antiSMASH region JSON for one bacterial genome runs to tens of MB. |
| `BGCSCAPE_WRITE_RATE_LIMIT` | `20` | Requests per window per client, across `/api/v1/ingest/*` and `/api/v1/export`. Reads are never limited. |
| `BGCSCAPE_RATE_LIMIT_WINDOW` | `300` | Rate-limit window, in seconds. |
| `BGCSCAPE_MAX_REQUEST_MB` | `160` | Outer ceiling on any request body, refused on `Content-Length` before the body is read. |

**What the rate limiter is and is not.** It is an in-process, in-memory
counter (`engine/src/bgcscape/api/security.py`). It resets when the container
restarts, and two containers behind a load balancer each get their own
allowance. That is a real limit for the single-container deployments above,
and it is **not** a defence against a distributed flood — that has to be
handled at the platform or CDN. It exists to stop casual abuse and runaway
scripts.

**CORS is not what protects this route.** Every endpoint is unauthenticated
and carries no cookie, so an allow-list only governs what other *pages* may
read in a browser; a script or a server-side request reaches the upload
endpoint regardless. Setting `BGCSCAPE_CORS_ALLOW_ORIGINS` is still worth
doing, but the controls that actually bound abuse are the three above plus
`BGCSCAPE_ALLOW_UPLOADS=0`. The API logs a warning at startup if it is left
open in production.

### Frontend environment

| Variable | Needed? | Effect |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | yes | The API origin. Also named in the page's `connect-src` CSP directive, so it must be the real origin or every fetch is blocked. |
| `NEXT_PUBLIC_SITE_URL` | yes in production | The site's own origin, e.g. `https://phylo-bgc.vercel.app`. Without it `og:image` is emitted relative (and dropped by most crawlers, so the share card silently disappears) and `sitemap.xml` advertises `localhost`. On Vercel it falls back to `VERCEL_PROJECT_PRODUCTION_URL`. |

**Uploads do not survive a restart on Render or Hugging Face.** The image
copies the bundled SQLite file to a container-local path (`/app/data/`), so
writes go to an ephemeral filesystem: they work for the life of the
container and are gone when the free tier spins down (~15 min idle) or
redeploys. That is fine for trying the feature out, and wrong for anything
you want to keep. For durable uploads, point `BGCSCAPE_DATABASE_URL` at a
managed Postgres and run `bgcscape init-db` against it once.

---

## 5. Redeploys

- **Frontend**: push to `main` → Vercel auto-deploys.
- **API on Render**: push to `main` → auto-deploys (`autoDeploy: true`).
- **API on HF**: push to the Space repo.

---

## If you get a card later: Fly.io

`engine/fly.toml` is already written. `cd engine && fly launch --no-deploy && fly deploy`.
Fly stays warm better than Render's free tier and has no per-request cold start.

## Rebuilding the bundled GTDB + MIBiG dataset

`engine/gtdb_mibig_bundled.db` is checked in. Rebuild it with the script —
**not** by hand:

```bash
cd engine

# 1. Pick the GTDB genomes MIBiG entries resolve to, and write the mapping.
#    Scans all ~879,000 GTDB rows; takes a few minutes.
python scripts/build_gtdb_subset.py     --gtdb    ../../../bac120_metadata.tsv.gz     --mibig   ../../../data/mibig_json_4.0/mibig_json_4.0     --out     data/gtdb_mibig_subset.tsv     --map-out data/mibig_gtdb_map.tsv

# 2. Build the database (schema via Alembic, then every ingest step).
python scripts/build_bundled_db.py     --mibig ../../../data/mibig_json_4.0/mibig_json_4.0     --out   gtdb_mibig_bundled.db

# 3. Eukaryotes. GTDB is prokaryote-only, so MIBiG's fungi and plants need
#    NCBI Taxonomy. Download taxdump.tar.gz from
#    https://ftp.ncbi.nlm.nih.gov/pub/taxonomy/ and extract at least
#    nodes.dmp, names.dmp and merged.dmp.
BGCSCAPE_DATABASE_URL=sqlite+pysqlite:///./gtdb_mibig_bundled.db \
  bgcscape ingest ncbi-taxonomy ../../../data/taxdump --version 2026-08-28
```

Step 3 is separate from `build_bundled_db.py` because it needs a 78 MB
download the build script cannot fetch for you. It takes unplaced clusters
from **491 to 25** — what remains are metagenomes, plasmids and
"uncultured X", which no taxonomy can place.

The result is served as its own view (the **Eukaryotes** tab), NOT grafted
onto the GTDB backbone: the two taxonomies use different methodologies and
disagree, so a merged tree would be a hybrid a reader could not pick apart.
The header names whichever taxonomy is on screen.

The build is a script rather than a list of commands here for a reason: when
it was prose, the prose drifted. The documented sequence omitted
`group-by-compound` while the shipped database plainly contained 279 compound
groups, and this file simultaneously claimed the bundle had "no gene cluster
families" while `/api/v1/families` served them. Nobody could have reproduced
the artifact from the instructions, and nothing detected the divergence.
`scripts/build_bundled_db.py` is now the single definition of the pipeline;
it prints row counts, family kinds, the Alembic stamp and any missing
licence at the end so a drift is visible immediately.

The script builds the schema **through `alembic upgrade head`**, so the
artifact is stamped and inside migration control. Earlier bundles were
created with `init-db` (`create_all`) and never stamped, which meant
`alembic upgrade head` against a deployed database failed with "table source
already exists" — there was no upgrade path at all.

Commit the new `.db` and redeploy.

### Upgrading a database built before this change

A bundle from an older build has no `alembic_version` table and no
`bgc_family.kind` column. The API will return 500 on `/api/v1/families` and
`/api/v1/prioritization` until it is migrated:

```bash
export BGCSCAPE_DATABASE_URL=sqlite+pysqlite:///./gtdb_mibig_bundled.db
alembic stamp fd9be220c0d2      # the revision that schema actually matches
alembic upgrade head            # adds `kind` and backfills it
bgcscape group-by-compound      # re-stamps the Source row as TOOL_RUN
```

The `upgrade` step classifies every existing family: rows whose
`clustering_method` is `MIBiG shared compound` become `compound_group`,
everything else `sequence_family`. That backfill is the point of the
migration — without it every compound group would default to
`sequence_family` and would keep contaminating prioritization scores.

Running to `head` also applies `b8c2d5e71a30`, which adds `analysis_run`,
`analysis_run_coverage` and `bgc_organism_placement`, and **backfills every
placement out of `BGC.raw_annotation`** into the new table (1,849 rows on the
shipped bundle). The migration prints the count it moved and names any
`match_method` it did not recognise; unrecognised methods are skipped rather
than coerced, so their clusters stay linked but carry no confidence claim.
Re-run `bgcscape link-mibig` to record those properly once the vocabulary in
`models/placement.py` covers them.

Verify with:

```bash
bgcscape coverage      # examined / curated-only / unexamined, and the runs
bgcscape placements    # strong / moderate / weak, and by method
```

### `is_mag` becomes tri-state

Migration `c9f1a4d83b57` makes `genome.is_mag` nullable and sets every
unverified `False` to NULL. Nothing in this project ever had a source for
that False — GTDB's loader said so in its own comment — so the interface was
reporting "Isolate genome assembly" for genomes nothing had established
anything about. Rows already at `assembly_level = 'mag'` are promoted to
True, since that level does come from GTDB's metadata.

Expect the genome panel to read "MAG status not established" for most of a
GTDB-derived corpus, and "MAGs only" in the filter rail to match only
genomes something actually asserted.

### Re-grading placements against NCBI's own taxonomy

Migration `e2b6c04f8a13` adds `genome.ncbi_taxonomy_conflict` — **as NULL
everywhere**, deliberately. The comparison it records needs a column that lives
in GTDB's metadata TSV and not in this database, so the migration cannot
establish the answer and does not assert one.

Why it exists: an exact NCBI taxid match used to be graded STRONG with no
further test. Only one of those two identifiers is derived from the genome —
GTDB reads the lineage off genome content, while the NCBI taxid is typed in by
whoever deposited the assembly. When the depositor was wrong, the cluster
landed in the wrong phylum at the highest confidence the schema can express.

Fill the column and re-grade in one step, against the same metadata file you
built the corpus from:

```bash
bgcscape recheck-placements bac120_metadata.tsv.gz   # .gz is read directly
```

On the shipped bundle this compared **989 genomes, found 6 conflicted, and
demoted 32 placements from strong to weak**, each with a caveat naming the
reason. Genomes it could not compare stay NULL and are **not** demoted —
unknown is not suspicion.

Two things worth knowing before you run it:

- It is **symmetric**. A placement demoted by a conflict is restored if a later
  GTDB release resolves that conflict. A one-way ratchet would leave a
  corrected assembly penalised forever, which is the mirror of the bug this
  fixes.
- A **GTDB suffix split is not a conflict**. The comparison is at phylum rank
  only. `Myxococcota` vs `Myxococcota_A` is nomenclatural, and the 41 such
  cases in the bundle are correctly left alone; genus and species disagreements
  are routine (GTDB reclassifies 27% of MIBiG's organism labels) and are not
  flagged either.

`bgcscape placements` afterwards shows the new distribution — on the bundle,
1,557 strong / 40 moderate / 252 weak.

### After upgrading: what the tool will now say about your data

Two changes are visible immediately and are *not* faults:

- **Genomes report as unexamined** unless an `AnalysisRun` covers them. A
  database of curated MIBiG entries has no coverage, so the stats bar says
  so. This is the point: a cluster count over unexamined genomes is not a
  survey result, and an empty clade in such a corpus is not evidence.
- **The prioritization scorer refuses on a curated-only corpus.** With no
  detection coverage, class rarity is uncomputable; with no clustering, the
  three similarity components are too. That leaves one component, below the
  two-component threshold, so no score is produced. Ingesting an antiSMASH
  run (or declaring one with `bgcscape record-analysis-run`) is what makes
  rarity answerable again — see ARCHITECTURE.md, "The scorer's denominators
  were 'rows somebody loaded'".

To record a run whose output you already have, `bgcscape ingest antismash`
registers coverage automatically. For genomes the run examined and found
nothing in — which produce no file to ingest, and are the more informative
half — declare them:

```bash
bgcscape record-analysis-run examined.txt   --tool antiSMASH --tool-version 7.1.0   --notes "run externally; these genomes reported no regions"
```

### How entries are placed on the tree

MIBiG records an organism name and an NCBI taxid but no lineage, so placement
comes from matching that organism to a GTDB genome. Precedence, strongest first:

| Method | What it matched | Entries |
|---|---|---|
| `ncbi_taxid` | MIBiG's taxid equals GTDB's `ncbi_taxid` | 1,589 |
| `ncbi_species_taxid` | MIBiG's taxid equals GTDB's `ncbi_species_taxid` | 9 |
| `gtdb_species` | binomial names agree | 31 |
| `ncbi_species_name` | binomial agrees with GTDB's `ncbi_organism_name` | 220 |
| genus only | no genome for the organism; grafted to its genus | 109 |
| unplaced | organism absent from GTDB (fungi and plants) | 479 |

`ncbi_species_name` exists because **GTDB reclassifies organisms**. A genome
can be in GTDB while the name MIBiG uses no longer appears anywhere in
`gtdb_taxonomy` — *Salinispora arenicola* is the clean case: GTDB moved the
genus, so a `gtdb_taxonomy` lookup misses it entirely even though the genome
is right there under `ncbi_organism_name`. Matching that column as a last
resort moved 220 entries to genome-level placement: 75% of the corpus is now
placed on a specific genome, up from 66%.

The cluster still lands on GTDB's own lineage for the matched genome — so it
appears under GTDB's *current* name for the organism, not the name MIBiG
records. MIBiG's organism name stays on the entry, and the placement method
is shown in the UI, so the two can be told apart.

A match says *this cluster was characterized in this organism, and this is
GTDB's genome for that organism*. It does **not** say the cluster was called on
that assembly -- MIBiG's own locus accession stays on `BGC.contig`, and the
method is shown in the UI so a reader can judge the placement.

Commit the new `.db` and redeploy.

## Deep links (for the planned antiSMASH button)

The frontend reads these URL parameters on load:

| URL | Effect |
|---|---|
| `?bgc=BGC0000123` | select that MIBiG cluster's organism, frame the tree on its clade, highlight its biosynthetic class across the tree |
| `?taxon=Streptomyces` | focus that clade |
| `?class=nrps` | filter to that biosynthetic class |

So an antiSMASH KnownClusterBlast hit (`BGC…`) becomes
`https://<your-site>/?bgc=BGC0000123`.

## Cluster groups: what ships, and how to get real GCFs

Two different groupings can live in this database at once, and the UI names
whichever it has rather than calling both "families".

**What ships today — both kinds.** Alongside the 281 BiG-SCAPE sequence
families described under "Going bigger" below, `bgcscape group-by-compound`
groups clusters that MIBiG records as producing the same named compound: 279 groups
over 576 clusters, 209 of them spanning more than one organism. This is a
curated experimental link, not a sequence clustering. Groups are labelled
`CMPD_*` with `clustering_method = "MIBiG shared compound"` and no cutoff, so
they can never be mistaken for BiG-SCAPE output.

**What it is not.** A Gene Cluster Family in the BiG-SCAPE / BiG-SLiCE sense
groups clusters by gene content and domain architecture. That needs the
sequences and a real clustering run.

### Getting real GCFs, one family at a time (minutes)

`bgcscape ingest bigfam` reads the per-GCF member export from a BiG-FAM GCF
detail page — the "export BGC list" link, i.e.
`/api/gcf/get_member_links?gcf_id=<id>`. BiG-FAM publishes BiG-SLiCE's
precomputed families, so this needs no clustering run at all: pick a family,
save its export into `data/bigslice/`, and ingest it.

```bash
# after saving the export as data/bigslice/gcf_200948.tsv
bgcscape ingest bigfam data/bigslice/gcf_200948.tsv
```

The GCF id is inferred from the filename; pass `--gcf-id` if it isn't in
there. Putative members (BiG-FAM radius > 900) are excluded by default —
`--include-putative` keeps them.

**Read the coverage line the command prints.** A BiG-FAM family is defined
over 1.2M BGCs and this corpus holds ~1,500 genomes, so most families will
have only a handful of members here:

```
GCF_200948: 3 of 6 member(s) are on genomes in this corpus (50%), spanning
3 genome(s). 3 member(s) sit on assemblies this corpus does not hold and
are not shown.
```

Members on assemblies this database doesn't have are counted, never
invented — creating the genome would mean inventing the taxonomy that places
it on the tree. If nothing places at all, the command says so and exits 1
rather than leaving an empty family behind. The family panel in the UI
repeats the caveat for any BiG-FAM family.

### Getting real GCFs over the whole corpus (a few hours, one time)

MIBiG's corpus is small enough that BiG-SCAPE over it is very tractable —
roughly 2,400 clusters, not the 1.2 million in BiG-FAM. This is the route to
take first: it covers **100% of this corpus by construction**, needs no
download, and is what turns "MIBiG names the same compound" into a claim
about sequences. The bulk BiG-FAM route below answers a different question
and is the better second step, not the better first one.

1. Download **MIBiG 4.0 GenBank files** from the MIBiG download page (the
   GenBank bundle, not the JSON one you already have).
2. Install BiG-SCAPE and the Pfam database it needs:
   ```bash
   conda install -c bioconda bigscape        # or follow the BiG-SCAPE README
   wget https://ftp.ebi.ac.uk/pub/databases/Pfam/current_release/Pfam-A.hmm.gz
   gunzip Pfam-A.hmm.gz && hmmpress Pfam-A.hmm
   ```
3. Run it over the MIBiG GenBanks:
   ```bash
   bigscape cluster -i mibig_gbk/ -o bigscape_out/ -p Pfam-A.hmm --mibig
   ```
4. Ingest the clustering output — it joins automatically:
   ```bash
   bgcscape ingest bigscape bigscape_out/<...>_clustering_c0.30.tsv
   ```

Step 4 works with no extra mapping because MIBiG ingestion sets
`BGC.external_ref` to each entry's accession, and BiG-SCAPE identifies every
input record by its GenBank filename stem — which for MIBiG's own files *is*
the accession. Both groupings then coexist; a cluster can belong to a compound
group and a GCF at the same time, which is why `family_ids` is a list.

### Getting BiG-FAM's families in bulk (17 GB, plus an extractor to write)

"The BiG-FAM bulk download is 189 GB" is the number everyone quotes and it
sends people away. It is three components, and only one of them is GCF data:

```
https://www.bioinformatics.nl/~kauts001/ltr/bigslice/paper_data/
  bigslice_supplementary_data.all.tar.gz  189 GB  all three, don't
  data/
    subpfam_sources.zip                   144 GB  HMM training material
    full_input_data.zip                    28 GB  the input GenBanks
    full_run_result.zip                    17 GB  <- the GCF data
    full_run_result/result/data.db         42 GB  <- same, served unpacked
```

So the real cost is **17 GB**, not 189. The server exposes the unpacked tree,
so `wget -c .../full_run_result/result/data.db` also works and skips the
unzip — at the price of verifiability: `MD5SUMS_data.txt` has one checksum
per zip and none for the files inside. On a transfer this size, take the zip.

**It does not plug in as-is.** `bgcscape ingest bigfam` reads BiG-FAM's *web
export TSV*; this is a BiG-SLiCE *SQLite database*, and nothing in `engine/`
reads that. The cheap bridge is an extractor, not a new ingest module —
`data.db` carries what the existing TSV parser already wants:

```sql
gcf(id, id_in_run, clustering_id)
gcf_membership(gcf_id, bgc_id, membership_value, rank)
bgc(id, dataset_id, name, type, orig_folder, orig_filename, length_nt)
```

`orig_folder`/`orig_filename` is the `GCF_000156695.2` +
`NZ_ABYX02000001.region019` pair that `ingest/bigfam.py` already documents
and splits, so a script emitting the export TSV shape reuses every join, the
accession normalisation, and the coverage line unchanged.

**Verify one thing before trusting the output.** The ingest drops
`RADIUS > 900` as putative; `data.db` calls the column `membership_value`.
Confirm they are the same scale by pulling GCF 200948 both ways — the web
export for it is already checked in at
`engine/tests/fixtures/bigfam_gcf_200948_members.tsv` — before mapping one to
the other.

**And check overlap before spending the bandwidth.** This is BiG-SLiCE 1.0
output from **July 2020**: 1.2M BGCs over 209,206 genomes *as they existed
then*. GTDB here is R11-RS232 (April 2026). Long-sequenced cultured producers
will be present; recent MAGs will not (`GCA_963591685.1` is a 2023 assembly).
Query the BiG-FAM API for a dozen of this corpus's accessions first — minutes,
against a 17 GB commitment.

## Going bigger: full GTDB + antiSMASH + BiG-SCAPE

The bundled dataset ships with **279 compound groups and 281 sequence
families** — the latter from a BiG-SCAPE 2.0.3 run over MIBiG 4.0 at cutoff
0.3, covering 747 clusters on 505 genomes. `bgcscape ingest bigscape` (a run
of your own) or `bgcscape ingest bigfam` (BiG-FAM's precomputed families) is
what adds more. The distinction matters and is enforced by `BGCFamily.kind`:

- a **compound group** (`kind = compound_group`) links clusters that MIBiG
  records as making the same named compound. A curated chemical fact; no
  sequences are compared.
- a **sequence family** (`kind = sequence_family`) is a BiG-SCAPE/BiG-SLiCE
  GCF: clusters grouped by gene content and domain architecture. Either read
  from BiG-FAM's precomputed families (`bgcscape ingest bigfam`, minutes) or
  produced by your own clustering run over antiSMASH output (hours to days).

The family panel shows both kinds and the UI labels each as what it is. The
prioritization scorer's three similarity components (`unclustered`,
`family_rarity`, `taxonomic_isolation`) are defined over sequence families
**only**, and are answerable exactly as far as a recorded clustering run
reached. On this bundle that is 505 genomes, so:

- 747 clusters score on 4 of 5 components (in a family, on a covered genome),
- 480 score on 2 of 5 (covered, but in no family — now a finding, not a
  silence),
- **1,210 decline entirely** at 1 of 5, below the two-component threshold,
  because nothing ever compared them.

That refusal is the design: it emits nothing rather than a confident number
from a proxy that measures something else. `class_rarity_in_clade` remains
uncomputable for every cluster here, because a *sequence-clustering* run is not
a *cluster-detection* run — only antiSMASH coverage changes that. See
ARCHITECTURE.md, "Two kinds of grouping" and "'Same BGC' finally has a sequence
meaning".

When you have antiSMASH + BiG-SCAPE output:

1. Provision Postgres (Neon and Supabase have card-free free tiers).
2. Set `BGCSCAPE_DATABASE_URL=postgresql+psycopg://user:pass@host:5432/db` on the API host.
3. Point the Dockerfile at Postgres instead of the bundled SQLite (delete the
   `cp gtdb_mibig_bundled.db …` line and the SQLite `BGCSCAPE_DATABASE_URL`).
4. `alembic upgrade head`, then `bgcscape ingest gtdb/mibig/antismash/bigscape …`
   and `bgcscape graft-taxonomy` (see the root `README.md`). Large trees also
   need the frontend switched to the lazy `/api/v1/tree` endpoint.
