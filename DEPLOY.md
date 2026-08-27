# Deploying BGC-scape

Two independently deployed pieces:

| Piece | Host | Notes |
|---|---|---|
| `web/` Next.js frontend | **Vercel** | you already have this account; no card |
| `engine/` FastAPI API | **Render** or **Hugging Face Spaces** | both have a card-free free tier; pick one below |

The API image serves a **real read-only dataset** baked in
(`engine/gtdb_mibig_bundled.db`): all 2,437 active **MIBiG 4.0** reference
clusters mapped onto the **GTDB R11-RS232** tree. 1,629 (66%) are matched to a
specific GTDB genome by NCBI taxonomy ID; another 284 are placed at genus level,
giving **78% on the real domain-to-species backbone**. The remainder are
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
   title: BGC-scape API
   sdk: docker
   app_port: 7860
   pinned: false
   ---
   Read-only visualization API for BGC-scape. MIBiG 4.0 mapped onto GTDB.
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

## 5. Redeploys

- **Frontend**: push to `main` → Vercel auto-deploys.
- **API on Render**: push to `main` → auto-deploys (`autoDeploy: true`).
- **API on HF**: push to the Space repo.

---

## If you get a card later: Fly.io

`engine/fly.toml` is already written. `cd engine && fly launch --no-deploy && fly deploy`.
Fly stays warm better than Render's free tier and has no per-request cold start.

## Rebuilding the bundled GTDB + MIBiG dataset

`engine/gtdb_mibig_bundled.db` is checked in. To regenerate it (e.g. after a new
MIBiG or GTDB release), from `engine/`:

```bash
# 1. Pick the GTDB genomes MIBiG entries resolve to, and write the mapping.
#    Scans all ~879,000 GTDB rows; takes a few minutes.
python scripts/build_gtdb_subset.py \
    --gtdb    ../../../bac120_metadata.tsv.gz \
    --mibig   ../../../data/mibig_json_4.0/mibig_json_4.0 \
    --out     data/gtdb_mibig_subset.tsv \
    --map-out data/mibig_gtdb_map.tsv

# 2. Build the database.
export BGCSCAPE_DATABASE_URL=sqlite+pysqlite:///./gtdb_mibig_bundled.db
bgcscape init-db
bgcscape ingest gtdb  data/gtdb_mibig_subset.tsv
bgcscape ingest mibig ../../../data/mibig_json_4.0/mibig_json_4.0 --version 4.0
bgcscape link-mibig   data/mibig_gtdb_map.tsv   # attach clusters to GTDB genomes
bgcscape graft-taxonomy                          # genus-level fallback for the rest
```

### How entries are placed on the tree

MIBiG records an organism name and an NCBI taxid but no lineage, so placement
comes from matching that organism to a GTDB genome. Precedence, strongest first:

| Method | What it matched | Entries |
|---|---|---|
| `ncbi_taxid` | MIBiG's taxid equals GTDB's `ncbi_taxid` | 1,589 |
| `ncbi_species_taxid` | MIBiG's taxid equals GTDB's `ncbi_species_taxid` | 9 |
| `gtdb_species` | binomial names agree | 31 |
| genus only | no genome for the organism; grafted to its genus | 284 |
| unplaced | genus absent from GTDB (mostly fungi and plants) | 524 |

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

## Going bigger: full GTDB + antiSMASH + BiG-SCAPE

The bundled dataset has **no gene cluster families** — those require a BiG-SCAPE
run over antiSMASH output, which is a real compute pipeline (large downloads,
hours–days), not a build step. Until then the family panel is empty, and a
`?bgc=` deep link highlights the cluster's *biosynthetic class* across the tree
-- the honest signal MIBiG + GTDB alone can support. When you have those files:

1. Provision Postgres (Neon and Supabase have card-free free tiers).
2. Set `BGCSCAPE_DATABASE_URL=postgresql+psycopg://user:pass@host:5432/db` on the API host.
3. Point the Dockerfile at Postgres instead of the bundled SQLite (delete the
   `cp gtdb_mibig_bundled.db …` line and the SQLite `BGCSCAPE_DATABASE_URL`).
4. `alembic upgrade head`, then `bgcscape ingest gtdb/mibig/antismash/bigscape …`
   and `bgcscape graft-taxonomy` (see the root `README.md`). Large trees also
   need the frontend switched to the lazy `/api/v1/tree` endpoint.
