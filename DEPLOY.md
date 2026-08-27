# Deploying BGC-scape

Two independently deployed pieces:

| Piece | Host | Notes |
|---|---|---|
| `web/` Next.js frontend | **Vercel** | you already have this account; no card |
| `engine/` FastAPI API | **Render** or **Hugging Face Spaces** | both have a card-free free tier; pick one below |

The API image regenerates its demo database at build time (`bgcscape seed-demo`,
deterministic). No database service, no volume, no secrets required. Swapping in
real data / Postgres is a later step (bottom of this file).

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
curl https://<your-service>.onrender.com/api/v1/families    # 71 families
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
   Read-only visualization API for BGC-scape. Synthetic demo data.
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

## Serving real data instead of the demo corpus

The demo corpus is fabricated (`SYN_` accessions, `evidence_level=HYPOTHESIZED`,
source "SYNTHETIC DEMO DATA (not real)"). For real data:

1. Provision Postgres (Neon and Supabase both have card-free free tiers).
2. Set `BGCSCAPE_DATABASE_URL=postgresql+psycopg://user:pass@host:5432/db` on the API host.
3. Remove the `bgcscape init-db && bgcscape seed-demo` line (and the SQLite
   `BGCSCAPE_DATABASE_URL`) from `engine/Dockerfile`.
4. Run `alembic upgrade head`, then `bgcscape ingest gtdb/mibig/antismash/bigscape …`
   against that database (see the root `README.md`).
