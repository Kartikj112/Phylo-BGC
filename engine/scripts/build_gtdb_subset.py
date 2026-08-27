"""Build a small GTDB metadata TSV covering the genera MIBiG actually uses.

Full GTDB `bac120_metadata.tsv(.gz)` is ~900k genomes — far too large to
load into memory for the tree view and pointless here, since the whole
point is "where are *characterized* BGCs on the tree". This keeps one
representative genome per genus that appears in MIBiG's organism names,
plus (optionally) a phylogenetic-context sample of other genera.

The output has the exact column layout `bgcscape ingest gtdb` expects
(it's a straight row subset), so:

    python scripts/build_gtdb_subset.py \
        --gtdb  ../bac120_metadata.tsv.gz \
        --mibig ../data/mibig-json/data \
        --out   data/gtdb_mibig_subset.tsv

then `bgcscape ingest gtdb data/gtdb_mibig_subset.tsv`.
"""
from __future__ import annotations

import argparse
import gzip
import json
import re
from collections import defaultdict
from pathlib import Path


def _open(path: Path):
    return gzip.open(path, "rt", encoding="utf-8") if path.suffix == ".gz" else open(path, encoding="utf-8")


def genus_token(organism_name: str) -> str:
    """First real word of an organism name, lowercased — the genus.

    Handles the shapes MIBiG actually contains: `Candidatus X`, `[Genus]`,
    `Genus sp. STRAIN`, `Genus species STRAIN123`.
    """
    name = organism_name.strip().strip("[]")
    parts = name.split()
    if parts and parts[0].lower() in ("candidatus", "ca."):
        parts = parts[1:]
    return re.sub(r"[^A-Za-z-]", "", parts[0]).lower() if parts else ""


def normalize_genus(genus: str) -> str:
    """Collapse GTDB's polyphyly split suffix (`Streptomyces_A` ->
    `streptomyces`) so an NCBI-style genus name from MIBiG can match it.
    Kept identical to `ingest.graft.normalize_genus` — grafting has to use
    the same rule the subset was selected with."""
    return re.sub(r"_[a-z]+$", "", genus.strip().lower())


def mibig_genera(mibig_dir: Path) -> set[str]:
    genera: set[str] = set()
    for f in sorted(mibig_dir.glob("*.json")):
        raw = json.loads(f.read_text(encoding="utf-8"))
        cluster = raw.get("cluster", raw)
        name = cluster.get("organism_name") or (raw.get("taxonomy") or {}).get("name")
        if name:
            g = genus_token(name)
            if g:
                genera.add(g)
    return genera


def gtdb_genus_of(gtdb_taxonomy: str) -> str:
    for part in gtdb_taxonomy.split(";"):
        if part.startswith("g__"):
            return part[3:].strip().lower()
    return ""


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--gtdb", type=Path, required=True, help="bac120_metadata.tsv or .tsv.gz")
    ap.add_argument("--mibig", type=Path, required=True, help="directory of MIBiG entry .json files")
    ap.add_argument("--out", type=Path, required=True, help="where to write the subset TSV")
    ap.add_argument(
        "--per-genus", type=int, default=1, help="max representative genomes to keep per genus"
    )
    ap.add_argument(
        "--context-genera",
        type=int,
        default=0,
        help="also keep this many extra genera (one genome each) for phylogenetic context",
    )
    args = ap.parse_args()

    wanted = {normalize_genus(g) for g in mibig_genera(args.mibig)}
    print(f"MIBiG references {len(wanted)} distinct (normalized) genera")

    with _open(args.gtdb) as fh:
        header = fh.readline().rstrip("\n")
        cols = header.split("\t")
        gi = cols.index("gtdb_taxonomy")
        ri = cols.index("gtdb_representative")

        kept: list[str] = []
        per_genus: dict[str, int] = defaultdict(int)
        context_pool: dict[str, str] = {}

        for line in fh:
            row = line.rstrip("\n").split("\t")
            if len(row) <= max(gi, ri):
                continue
            if row[ri] != "t":  # GTDB species representative genomes only
                continue
            raw_genus = gtdb_genus_of(row[gi])
            if not raw_genus:
                continue
            genus = normalize_genus(raw_genus)
            if genus in wanted and per_genus[raw_genus] < args.per_genus:
                kept.append(line.rstrip("\n"))
                per_genus[raw_genus] += 1
            elif args.context_genera and genus not in wanted and raw_genus not in context_pool:
                context_pool[raw_genus] = line.rstrip("\n")

    context_rows: list[str] = []
    if args.context_genera:
        context_rows = list(context_pool.values())[: args.context_genera]

    matched = len({normalize_genus(g) for g in per_genus})
    print(f"matched {matched}/{len(wanted)} MIBiG genera in GTDB ({100 * matched // max(len(wanted), 1)}%)")
    print(f"writing {len(kept)} MIBiG-genus genomes + {len(context_rows)} context genomes")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    with open(args.out, "w", encoding="utf-8", newline="") as out:
        out.write(header + "\n")
        for line in kept + context_rows:
            out.write(line + "\n")
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
