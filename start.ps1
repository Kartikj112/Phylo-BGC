# Run Phylo-BGC on your own computer with one command (Windows PowerShell):
#
#     powershell -ExecutionPolicy Bypass -File .\start.ps1
#
# The same thing as start.sh, for people who are not using Git Bash. Needs
# Python 3.11+ and Node.js 20.9+. The first run installs everything (a few
# minutes); later runs start in seconds.
#
# Options:
#     -ApiPort 8000   port for the API
#     -WebPort 3000   port for the website
#     -WithGtdb       also load the whole GTDB taxonomy, which turns on the
#                     "All GTDB genomes" toggle. Downloads ~300 MB from GTDB
#                     once and takes a few minutes; later runs skip it.
#     -Dev            run the website in development mode (live reload)
#     -Fresh          throw away your local copy of the data (and any
#                     uploads you made) and start again from the bundled one

param(
    [int]$ApiPort = 8000,
    [int]$WebPort = 3000,
    [switch]$WithGtdb,
    [switch]$Dev,
    [switch]$Fresh
)

# Not "Stop": in Windows PowerShell 5.1 that turns any line a native program
# writes to stderr (pip, alembic and npm all log there) into a fatal error.
# Failures are caught by checking $LASTEXITCODE after each step instead.
$ErrorActionPreference = "Continue"
$Root = $PSScriptRoot
$Engine = Join-Path $Root "engine"
$Web = Join-Path $Root "web"

function Say($msg) { Write-Host ""; Write-Host "==> $msg" -ForegroundColor Cyan }
function Fail($msg) { Write-Host ""; Write-Host "Error: $msg" -ForegroundColor Red; exit 1 }

# --- 1. Check prerequisites -------------------------------------------------

# `py` (the Windows launcher) first, then `python`. `python3` is skipped: on
# Windows it is usually a Microsoft Store stub that does not run.
$Py = $null
foreach ($cand in @("py", "python")) {
    if (Get-Command $cand -ErrorAction SilentlyContinue) {
        & $cand -c "import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)" 2>$null
        if ($LASTEXITCODE -eq 0) { $Py = $cand; break }
    }
}
if (-not $Py) { Fail "Python 3.11 or newer is required. Get it from https://www.python.org/downloads/ (tick 'Add python.exe to PATH')." }

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail "Node.js 20.9 or newer is required. Get it from https://nodejs.org/" }
node -e "const [a,b]=process.versions.node.split('.').map(Number); process.exit(a>20||(a===20&&b>=9)?0:1)"
if ($LASTEXITCODE -ne 0) { Fail "Node.js 20.9 or newer is required (you have $(node --version)). Get it from https://nodejs.org/" }

# --- 2. Python environment for the engine (first run only) -----------------

$Venv = Join-Path $Engine ".venv"
$VPy = Join-Path $Venv "Scripts\python.exe"
if (-not (Test-Path $VPy)) {
    Say "Creating a Python environment in engine\.venv (first run only)"
    & $Py -m venv $Venv
    if ($LASTEXITCODE -ne 0) { Fail "Could not create the Python environment." }
}

# Reinstall when pyproject.toml changes (e.g. after a `git pull`), not every run.
$Stamp = Join-Path $Venv ".installed-from"
$Pyproject = Join-Path $Engine "pyproject.toml"
$needInstall = -not (Test-Path $Stamp)
if (-not $needInstall) { $needInstall = (Get-FileHash $Stamp).Hash -ne (Get-FileHash $Pyproject).Hash }
if ($needInstall) {
    Say "Installing the engine's Python packages"
    & $VPy -m pip install --upgrade pip | Out-Null
    Push-Location $Engine
    try { & $VPy -m pip install -e ".[api]" } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { Fail "Installing the Python packages failed (see above)." }
    Copy-Item $Pyproject $Stamp
}

# --- 3. Node packages for the website (first run only) ---------------------

$Lock = Join-Path $Web "package-lock.json"
$InstalledLock = Join-Path $Web "node_modules\.package-lock.json"
if (-not (Test-Path $InstalledLock) -or (Get-Item $Lock).LastWriteTime -gt (Get-Item $InstalledLock).LastWriteTime) {
    Say "Installing the website's Node packages"
    Push-Location $Web
    try { npm ci --no-audit --no-fund } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { Fail "Installing the Node packages failed (see above)." }
}

# --- 4. Your working copy of the data --------------------------------------

# The API writes to its database when you upload antiSMASH results, so it
# runs on a copy. The bundled file stays untouched and `git pull` keeps working.
$Db = Join-Path $Engine "data\local.db"
if ($Fresh -or -not (Test-Path $Db)) {
    Say "Copying the bundled dataset to engine\data\local.db"
    New-Item -ItemType Directory -Force (Join-Path $Engine "data") | Out-Null
    foreach ($suffix in @("", "-wal", "-shm", "-journal")) {
        if (Test-Path "$Db$suffix") { Remove-Item "$Db$suffix" -Force }
    }
    Copy-Item (Join-Path $Engine "gtdb_mibig_bundled.db") $Db -ErrorAction Stop
}

$env:BGCSCAPE_DATABASE_URL = "sqlite+pysqlite:///./data/local.db"
$env:BGCSCAPE_CORS_ALLOW_ORIGINS = "http://localhost:$WebPort,http://127.0.0.1:$WebPort"

# Bring an older local copy up to the current schema after a `git pull`.
Push-Location $Engine
try { & $VPy -m alembic upgrade head 2>&1 | Out-Null } finally { Pop-Location }
if ($LASTEXITCODE -ne 0) { Write-Host "  (note: could not migrate data\local.db; if the site errors, rerun with -Fresh)" }

# --- 4b. Optional: the whole GTDB taxonomy ---------------------------------

if ($WithGtdb) {
    Push-Location $Engine
    try {
        & $VPy -c "import sqlite3,sys; c=sqlite3.connect('data/local.db'); sys.exit(0 if c.execute('select count(*) from backbone_node').fetchone()[0] else 1)" 2>$null
        if ($LASTEXITCODE -eq 0) {
            Write-Host "  (GTDB backbone already loaded; skipping)"
        } else {
            Say "Loading the whole GTDB taxonomy (downloads ~300 MB once; a few minutes)"
            & $VPy -m bgcscape.cli.main fetch-gtdb-backbone
            if ($LASTEXITCODE -ne 0) { Fail "Loading GTDB failed (see above). The tool still works without it: run without -WithGtdb." }
        }
    } finally { Pop-Location }
}

# --- 5. Start both servers --------------------------------------------------

Say "Starting the API on http://127.0.0.1:$ApiPort"
$api = Start-Process -FilePath $VPy -WorkingDirectory $Engine -NoNewWindow -PassThru `
    -ArgumentList @("-m", "uvicorn", "bgcscape.api.app:app", "--host", "127.0.0.1", "--port", "$ApiPort", "--log-level", "warning")

try {
    # Wait for the API to answer before opening the site.
    $ready = $false
    for ($i = 0; $i -lt 60; $i++) {
        if ($api.HasExited) { Fail "The API stopped while starting. Is port $ApiPort already in use? Try: .\start.ps1 -ApiPort 8001" }
        try {
            Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 "http://127.0.0.1:$ApiPort/api/v1/health" | Out-Null
            $ready = $true; break
        } catch { Start-Sleep -Seconds 1 }
    }
    if (-not $ready) { Fail "The API did not start within a minute." }

    # An environment variable overrides web\.env.local, so the site always
    # talks to the API this script just started.
    $env:NEXT_PUBLIC_API_URL = "http://127.0.0.1:$ApiPort"
    $env:NEXT_PUBLIC_SITE_URL = "http://localhost:$WebPort"
    Push-Location $Web
    try {
        if ($Dev) {
            Say "Starting the website (development mode). Open http://localhost:$WebPort. Press Ctrl+C to stop."
            npx next dev --port $WebPort
        } else {
            # A production build: faster pages, and no developer overlay. The API
            # URL is compiled into the build, so rebuild when it or the source changes.
            $BuildStamp = ".next\.start-sh-build"
            $wanted = "$($env:NEXT_PUBLIC_API_URL) $($env:NEXT_PUBLIC_SITE_URL)"
            $rebuild = -not (Test-Path ".next\BUILD_ID") -or -not (Test-Path $BuildStamp)
            if (-not $rebuild) { $rebuild = (Get-Content $BuildStamp -Raw).Trim() -ne $wanted }
            if (-not $rebuild) {
                $stampTime = (Get-Item $BuildStamp).LastWriteTime
                $newer = Get-ChildItem -Recurse -File src, public -ErrorAction SilentlyContinue |
                    Where-Object { $_.LastWriteTime -gt $stampTime } | Select-Object -First 1
                $rebuild = [bool]$newer -or (Get-Item "package-lock.json").LastWriteTime -gt $stampTime -or (Get-Item "next.config.mjs").LastWriteTime -gt $stampTime
            }
            if ($rebuild) {
                Say "Building the website (about a minute; only when something changed)"
                npx next build
                if ($LASTEXITCODE -ne 0) { Fail "The website build failed (see above)." }
                Set-Content -Path $BuildStamp -Value $wanted -Encoding ascii
            }
            Say "Ready. Open http://localhost:$WebPort in your browser. Press Ctrl+C to stop."
            npx next start --port $WebPort
        }
    } finally { Pop-Location }
} finally {
    if (-not $api.HasExited) { Stop-Process -Id $api.Id -Force -ErrorAction SilentlyContinue }
}
