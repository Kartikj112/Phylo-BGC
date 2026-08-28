#!/usr/bin/env python
"""Build `engine/gtdb_mibig_bundled.db` — the database the container ships.

Why this is a script and not a list of steps in DEPLOY.md
---------------------------------------------------------
It used to be prose. The prose drifted: the documented sequence omitted
`group-by-compound`, yet the shipped database plainly contained 279
compound groups, and DEPLOY.md simultaneously claimed the bundle had "no
gene cluster families" while `/api/v1/families` served them. A reader
trying to reproduce the artifact could not have, and nothing detected the
divergence.

A script is the fix: the build is now executable, so the documented
pipeline and the shipped artifact cannot disagree without the script
failing. DEPLOY.md points here rather than restating the steps.

The build is also **stamped with Alembic**. The bundle was previously
created with `init-db` (`create_all`) and never stamped, so
`alembic upgrade head` against a shipped database failed with
"table source already exists" — there was no upgrade path for a deployed
bundle when the schema changed. Building through migrations means the
artifact is inside migration control from the start.

Usage
-----
    python scripts/build_bundled_db.py \\
        --subset  data/gtdb_mibig_subset.tsv \\
        --map     data/mibig_gtdb_map.tsv \\
        --mibig   ../../../data/mibig_json_4.0/mibig_json_4.0 \\
        --out     gtdb_mibig_bundled.db

Regenerate the two `data/*.tsv` inputs first with
`scripts/build_gtdb_subset.py` when moving to a new GTDB or MIBiG release.
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

ENGINE_ROOT = Path(__file__).resolve().parents[1]


def run(args: list[str], env: dict[str, str]) -> None:
    print(f"\n$ {' '.join(args)}", flush=True)
    result = subprocess.run(args, cwd=ENGINE_ROOT, env=env)
    if result.returncode != 0:
        sys.exit(f"step failed: {' '.join(args)}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--subset", default="data/gtdb_mibig_subset.tsv")
    parser.add_argument("--map", default="data/mibig_gtdb_map.tsv")
    parser.add_argument("--mibig", required=True, help="Directory of MIBiG 4.0 entry JSONs.")
    parser.add_argument("--out", default="gtdb_mibig_bundled.db")
    parser.add_argument("--mibig-version", default="4.0")
    parser.add_argument("--gtdb-version", default="R11-RS232")
    args = parser.parse_args()

    out = (ENGINE_ROOT / args.out).resolve()
    if out.exists():
        out.unlink()

    env = dict(os.environ)
    # Forward slashes: SQLAlchemy's SQLite URL parser treats backslashes as
    # part of the path, which breaks on Windows-style absolute paths.
    env["BGCSCAPE_DATABASE_URL"] = f"sqlite+pysqlite:///{out.as_posix()}"
    env["PYTHONIOENCODING"] = "utf-8"
    py = [sys.executable]
    cli = [*py, "-m", "bgcscape.cli.main"]

    # 1. Schema THROUGH MIGRATIONS, so the artifact is stamped and a future
    #    `alembic upgrade head` against a deployed bundle actually works.
    run([*py, "-m", "alembic", "upgrade", "head"], env)

    # 2. GTDB first: it supplies the domain->genus hierarchy. MIBiG alone is
    #    a fan of species nodes under the root, not a tree.
    run([*cli, "ingest", "gtdb", args.subset, "--version", args.gtdb_version], env)

    # 3. MIBiG entries (clusters, compounds, compound links).
    run([*cli, "ingest", "mibig", args.mibig, "--version", args.mibig_version], env)

    # 4. Attach clusters to the GTDB genome of the same organism, and prune
    #    the emptied locus stubs.
    run([*cli, "link-mibig", args.map], env)

    # 5. Genus-level fallback for organisms with no genome in the subset.
    run([*cli, "graft-taxonomy"], env)

    # 6. Compound groups. This step was missing from the documented pipeline
    #    while being present in the shipped artifact — the drift this script
    #    exists to make impossible. These are COMPOUND_GROUP-kind rows and
    #    are excluded from prioritization scoring by construction; see
    #    models/bgc_family.py.
    run([*cli, "group-by-compound"], env)

    print(f"\nBuilt {out}")
    _summarise(out)


def _summarise(path: Path) -> None:
    import sqlite3

    conn = sqlite3.connect(path)
    counts = {
        table: conn.execute(f"select count(*) from {table}").fetchone()[0]  # noqa: S608
        for table in (
            "source",
            "taxon",
            "genome",
            "bgc",
            "compound",
            "bgc_family",
            "bgc_family_membership",
        )
    }
    print("\nRow counts:")
    for table, n in counts.items():
        print(f"  {table:24s} {n}")

    kinds = dict(conn.execute("select kind, count(*) from bgc_family group by 1").fetchall())
    print(f"\nFamily kinds: {kinds or '{}'}")
    stamped = conn.execute(
        "select count(*) from sqlite_master where type='table' and name='alembic_version'"
    ).fetchone()[0]
    print(f"Alembic-stamped: {bool(stamped)}")
    missing = conn.execute("select count(*) from source where license is null").fetchone()[0]
    print(f"Sources missing a licence: {missing}")


if __name__ == "__main__":
    main()
