# Phylo-BGC web

Next.js/TypeScript frontend for the taxonomy tree + BGC overlay explorer.
Consumes the engine's read-only API (`engine/src/bgcscape/api`) — contains
no biological logic of its own, per `ARCHITECTURE.md`'s separation of
concerns. See `design-prototype/README.md` for the interactive design
prototype this was built from.

## Quickstart

```bash
# 1. Start the API (from engine/, with data already ingested — see the
#    root README's engine quickstart if you haven't ingested anything yet)
cd ../engine
pip install -e ".[api]"
uvicorn bgcscape.api.app:app --reload   # http://127.0.0.1:8000

# 2. Start the frontend (from web/, in another terminal)
cd web
npm install
cp .env.local.example .env.local   # points at http://127.0.0.1:8000 by default
npm run dev                         # http://localhost:3000
```

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Development server |
| `npm run build` | Production build (verified to succeed in the build sandbox — see PROGRESS.md) |
| `npm start` | Run a production build |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest — `src/lib/tree-logic.test.ts`, including the hybrid-BGC filtering regression test |
| `npm run generate-api-types` | Regenerate `src/lib/api-schema.generated.ts` from a fresh OpenAPI dump — see below |

## Regenerating API types after a backend schema change

The type boundary between backend and frontend is **generated, not
hand-maintained** — `src/lib/api-schema.generated.ts` comes straight from
the FastAPI app's own OpenAPI schema via `openapi-typescript`, specifically
so the two can't silently drift the way hand-written mirror types could.
Whenever `engine/src/bgcscape/api/schemas.py` changes:

```bash
cd ../engine
bgcscape dump-openapi-schema --output openapi.json   # needs the `api` extra
cd ../web
npm run generate-api-types
```

`engine/openapi.json` itself isn't committed (regeneratable build output);
the generated TypeScript file is.

## Fonts are self-hosted, not `next/font/google`

IBM Plex Sans/Mono `.woff2` files live in `src/fonts/` and are loaded via
`next/font/local`, not `next/font/google`. This wasn't a design choice —
the build sandbox that produced this code can't reach
`fonts.googleapis.com` at build time (same class of network restriction as
MIBiG/GTDB in earlier chunks), so `next/font/google` failed the build
outright. The real font files were fetched from IBM's own open-source
repository (github.com/IBM/plex, SIL Open Font License — see
`src/fonts/IBM-Plex-LICENSE.txt`) instead, which is functionally what
`next/font/google` would have produced anyway (it downloads once at build
time and self-hosts). If you'd rather use `next/font/google` directly in
an environment with normal internet access, swap it back in
`src/app/layout.tsx` — nothing else depends on the local-font approach
specifically.
