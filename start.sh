#!/usr/bin/env bash
# Run Phylo-BGC on your own computer with one command:
#
#     ./start.sh
#
# Works on macOS, Linux, and Windows under Git Bash (Windows users can also
# use start.ps1 from PowerShell). Needs Python 3.11+ and Node.js 20.9+.
#
# The first run installs everything (a few minutes); later runs start in
# seconds. It serves the bundled dataset (engine/gtdb_mibig_bundled.db): all
# 2,437 MIBiG 4.0 reference clusters on the GTDB and NCBI trees. No database
# server, Docker, or downloads beyond the Python and npm packages.
#
# Options (environment variables):
#     API_PORT=8000   port for the API
#     WEB_PORT=3000   port for the website
#     WITH_GTDB=1     also load the whole GTDB taxonomy, which turns on the
#                     "All GTDB genomes" toggle. Downloads ~300 MB from GTDB
#                     once and takes a few minutes; later runs skip it.
#     DEV=1           run the website in development mode (live reload)
#     FRESH=1         throw away your local copy of the data (and any
#                     uploads you made) and start again from the bundled one

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENGINE="$ROOT/engine"
WEB="$ROOT/web"
API_PORT="${API_PORT:-8000}"
WEB_PORT="${WEB_PORT:-3000}"

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
fail() { printf '\n\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }

# --- 1. Check prerequisites -------------------------------------------------

# `python3` first, then `python`. On Windows `python3` is often a Microsoft
# Store stub that exists but does not run, so each candidate is actually
# executed rather than just looked up.
PY=""
for cand in python3 python; do
  if command -v "$cand" >/dev/null 2>&1 \
     && "$cand" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' 2>/dev/null; then
    PY="$cand"; break
  fi
done
[ -n "$PY" ] || fail "Python 3.11 or newer is required. Get it from https://www.python.org/downloads/"

command -v node >/dev/null 2>&1 || fail "Node.js 20.9 or newer is required. Get it from https://nodejs.org/"
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>20||(a===20&&b>=9)?0:1)' \
  || fail "Node.js 20.9 or newer is required (you have $(node --version)). Get it from https://nodejs.org/"
command -v npm >/dev/null 2>&1 || fail "npm was not found. It comes with Node.js: https://nodejs.org/"

# --- 2. Python environment for the engine (first run only) -----------------

VENV="$ENGINE/.venv"
if [ -x "$VENV/bin/python" ]; then
  VPY="$VENV/bin/python"
elif [ -x "$VENV/Scripts/python.exe" ]; then
  VPY="$VENV/Scripts/python.exe"
else
  say "Creating a Python environment in engine/.venv (first run only)"
  "$PY" -m venv "$VENV"
  if [ -x "$VENV/bin/python" ]; then VPY="$VENV/bin/python"; else VPY="$VENV/Scripts/python.exe"; fi
fi

# Reinstall when pyproject.toml changes (e.g. after a `git pull`), not every run.
STAMP="$VENV/.installed-from"
if [ ! -f "$STAMP" ] || ! cmp -s "$ENGINE/pyproject.toml" "$STAMP"; then
  say "Installing the engine's Python packages"
  "$VPY" -m pip install --upgrade pip >/dev/null
  # Relative path on purpose: under Git Bash, $ENGINE is a /c/... path that a
  # Windows Python cannot read.
  (cd "$ENGINE" && "$VPY" -m pip install -e ".[api]")
  cp "$ENGINE/pyproject.toml" "$STAMP"
fi

# --- 3. Node packages for the website (first run only) ---------------------

if [ ! -d "$WEB/node_modules" ] || [ "$WEB/package-lock.json" -nt "$WEB/node_modules/.package-lock.json" ]; then
  say "Installing the website's Node packages"
  (cd "$WEB" && npm ci --no-audit --no-fund)
fi

# --- 4. Your working copy of the data --------------------------------------

# The API writes to its database when you upload antiSMASH results, so it
# runs on a copy. The bundled file stays untouched and `git pull` keeps working.
DB="$ENGINE/data/local.db"
if [ "${FRESH:-0}" = "1" ] || [ ! -f "$DB" ]; then
  say "Copying the bundled dataset to engine/data/local.db"
  mkdir -p "$ENGINE/data"
  rm -f "$DB" "$DB-wal" "$DB-shm" "$DB-journal"
  cp "$ENGINE/gtdb_mibig_bundled.db" "$DB"
fi

# Bring an older local copy up to the current schema after a `git pull`.
# A no-op when it is already current.
(cd "$ENGINE" && BGCSCAPE_DATABASE_URL="sqlite+pysqlite:///./data/local.db" \
  "$VPY" -m alembic upgrade head >/dev/null 2>&1) \
  || echo "  (note: could not migrate data/local.db; if the site errors, rerun with FRESH=1)"

# --- 4b. Optional: the whole GTDB taxonomy ---------------------------------

if [ "${WITH_GTDB:-0}" = "1" ]; then
  if (cd "$ENGINE" && "$VPY" -c "import sqlite3,sys; c=sqlite3.connect('data/local.db'); sys.exit(0 if c.execute('select count(*) from backbone_node').fetchone()[0] else 1)" 2>/dev/null); then
    echo "  (GTDB backbone already loaded; skipping)"
  else
    say "Loading the whole GTDB taxonomy (downloads ~300 MB once; a few minutes)"
    (cd "$ENGINE" && BGCSCAPE_DATABASE_URL="sqlite+pysqlite:///./data/local.db"       "$VPY" -m bgcscape.cli.main fetch-gtdb-backbone)       || fail "Loading GTDB failed (see above). The tool still works without it: run without WITH_GTDB=1."
  fi
fi

# --- 5. Start both servers --------------------------------------------------

API_PID=""
cleanup() {
  if [ -n "$API_PID" ] && kill -0 "$API_PID" 2>/dev/null; then
    kill "$API_PID" 2>/dev/null || true
    wait "$API_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

say "Starting the API on http://127.0.0.1:$API_PORT"
(
  cd "$ENGINE"
  BGCSCAPE_DATABASE_URL="sqlite+pysqlite:///./data/local.db" \
  BGCSCAPE_CORS_ALLOW_ORIGINS="http://localhost:$WEB_PORT,http://127.0.0.1:$WEB_PORT" \
    exec "$VPY" -m uvicorn bgcscape.api.app:app --host 127.0.0.1 --port "$API_PORT" --log-level warning
) &
API_PID=$!

# Wait for the API to answer before opening the site, so the first page
# load does not show a connection error.
for _ in $(seq 1 60); do
  if "$VPY" -c "import urllib.request,sys; urllib.request.urlopen('http://127.0.0.1:$API_PORT/api/v1/health', timeout=1)" 2>/dev/null; then
    break
  fi
  kill -0 "$API_PID" 2>/dev/null || fail "The API stopped while starting. Is port $API_PORT already in use? Try API_PORT=8001 ./start.sh"
  sleep 1
done

# An environment variable overrides web/.env.local, so the site always
# talks to the API this script just started.
export NEXT_PUBLIC_API_URL="http://127.0.0.1:$API_PORT"
export NEXT_PUBLIC_SITE_URL="http://localhost:$WEB_PORT"
cd "$WEB"

if [ "${DEV:-0}" = "1" ]; then
  say "Starting the website (development mode). Open http://localhost:$WEB_PORT. Press Ctrl+C to stop."
  npx next dev --port "$WEB_PORT"
  exit
fi

# A production build: faster pages, and no developer overlay. The API URL is
# compiled into the build, so rebuild when it changes or the source does.
BUILD_STAMP=".next/.start-sh-build"
if [ ! -f .next/BUILD_ID ] || [ ! -f "$BUILD_STAMP" ] \
   || [ "$(cat "$BUILD_STAMP")" != "$NEXT_PUBLIC_API_URL $NEXT_PUBLIC_SITE_URL" ] \
   || [ -n "$(find src public package-lock.json next.config.mjs -newer "$BUILD_STAMP" -print -quit 2>/dev/null)" ]; then
  say "Building the website (about a minute; only when something changed)"
  npx next build
  echo "$NEXT_PUBLIC_API_URL $NEXT_PUBLIC_SITE_URL" > "$BUILD_STAMP"
fi

say "Ready. Open http://localhost:$WEB_PORT in your browser. Press Ctrl+C to stop."
npx next start --port "$WEB_PORT"
