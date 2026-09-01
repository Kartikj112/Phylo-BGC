"""Select the GTDB genomes that MIBiG entries actually map to.

Full GTDB is ~880,000 genomes. Rendering that tree is neither possible nor
useful: the question Phylo-BGC answers is "where do *characterized* clusters
sit on the tree of life", and a genome with no cluster contributes nothing
but scaffolding. So this picks out only the genomes MIBiG entries resolve
to, plus one representative per MIBiG genus that has no exact hit (so the
genus-level graft has something to attach to), and emits two files:

  --out      a GTDB metadata TSV, same columns as the input, for
             `bgcscape ingest gtdb`
  --map-out  mibig_accession -> gtdb_accession -> method, for
             `bgcscape link-mibig`

Matching is by NCBI taxid first, because MIBiG records one on every active
entry and GTDB carries `ncbi_taxid`/`ncbi_species_taxid` per genome. That is
an organism-level identity, not a name-similarity guess. Precedence:

  ncbi_taxid          exact strain/organism taxid            strongest
  ncbi_species_taxid  MIBiG's taxid is the species' taxid
  gtdb_species        GTDB binomial equals MIBiG's binomial
  (genus)             no genome match; handled by `graft-taxonomy`

Note what a match does and does not claim. It says "this cluster was
characterized in this organism, and this is GTDB's genome for that
organism." It does *not* claim the cluster was called on that assembly --
MIBiG's own locus accession is preserved on the BGC, and the method is
recorded so a reader can judge the placement.

Usage:

    python scripts/build_gtdb_subset.py \
        --gtdb    ../../../bac120_metadata.tsv.gz \
        --mibig   ../../../data/mibig_json_4.0/mibig_json_4.0 \
        --out     data/gtdb_mibig_subset.tsv \
        --map-out data/mibig_gtdb_map.tsv
"""
from __future__ import annotations

import argparse
import gzip
import json
import re
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from bgcscape.ingest.gtdb import normalize_gtdb_accession  # noqa: E402
from bgcscape.ingest.mibig import parse_mibig_entry  # noqa: E402


def _open(path: Path):
    if path.suffix == ".gz":
        return gzip.open(path, "rt", encoding="utf-8")
    return open(path, encoding="utf-8")


def genus_token(organism_name: str) -> str:
    """The genus word of an organism name: "Candidatus X" -> "x",
    "[Genus] sp. STRAIN" -> "genus"."""
    name = organism_name.strip().strip("[]")
    parts = name.split()
    if parts and parts[0].lower() in ("candidatus", "ca."):
        parts = parts[1:]
    return re.sub(r"[^A-Za-z-]", "", parts[0]).lower() if parts else ""


def binomial(organism_name: str) -> str:
    """First two words, lowercased. MIBiG names carry strain suffixes GTDB
    does not use, so only the binomial is comparable."""
    name = organism_name.strip().strip("[]")
    parts = name.split()
    if parts and parts[0].lower() in ("candidatus", "ca."):
        parts = parts[1:]
    if len(parts) >= 2:
        return " ".join(parts[:2]).lower()
    return parts[0].lower() if parts else ""


def normalize_genus(genus: str) -> str:
    """Drop GTDB's polyphyly split suffix: "Streptomyces_A" -> "streptomyces"."""
    return re.sub(r"_[a-z]+$", "", genus.strip().lower())


def normalize_species(species: str) -> str:
    """GTDB writes "Streptomyces_A coelicolor" for split genera; strip the
    suffix so it compares against an NCBI-style binomial."""
    return re.sub(r"_[A-Z]+", "", species.strip()).lower()


def read_mibig(mibig_dir: Path) -> list[dict]:
    entries = []
    for path in sorted(mibig_dir.glob("*.json")):
        try:
            parsed = parse_mibig_entry(json.loads(path.read_text(encoding="utf-8")))
        except Exception as exc:  # noqa: BLE001 - report and continue
            print(f"  skipping {path.name}: {exc}")
            continue
        if parsed.status != "active":
            continue
        name = parsed.organism_name or ""
        entries.append(
            {
                "accession": parsed.mibig_accession,
                "taxid": parsed.ncbi_taxid,
                "name": name,
                "binomial": binomial(name),
                "genus": normalize_genus(genus_token(name)),
            }
        )
    return entries


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--gtdb", type=Path, required=True, help="bac120_metadata.tsv or .tsv.gz")
    ap.add_argument("--mibig", type=Path, required=True, help="directory of MIBiG entry .json files")
    ap.add_argument("--out", type=Path, required=True, help="GTDB metadata subset to write")
    ap.add_argument("--map-out", type=Path, required=True, help="MIBiG->GTDB mapping TSV to write")
    ap.add_argument(
        "--context-genera",
        type=int,
        default=0,
        help="extra unrelated genera for phylogenetic context (default: none -- the tree "
        "shows only clades that carry characterized clusters)",
    )
    args = ap.parse_args()

    entries = read_mibig(args.mibig)
    want_taxid = {e["taxid"] for e in entries if e["taxid"]}
    want_binomial = {e["binomial"] for e in entries if e["binomial"]}
    want_genus = {e["genus"] for e in entries if e["genus"]}
    print(
        f"MIBiG active entries: {len(entries)} | "
        f"{len(want_taxid)} taxids, {len(want_binomial)} binomials, {len(want_genus)} genera"
    )

    # Candidate GTDB genome per key. A GTDB species representative is
    # preferred over a non-representative for the same key, since that is
    # the genome GTDB itself treats as the species exemplar.
    by_taxid: dict[int, tuple[str, bool, str]] = {}
    by_species_taxid: dict[int, tuple[str, bool, str]] = {}
    by_binomial: dict[str, tuple[str, bool, str]] = {}
    by_genus: dict[str, tuple[str, bool, str]] = {}
    # GTDB reclassifies organisms, so an entry can be absent from
    # `gtdb_taxonomy` under the name MIBiG uses while the same genome is
    # right there under `ncbi_organism_name`. Salinispora arenicola is the
    # clean example: GTDB moved the genus, so a gtdb_taxonomy lookup misses
    # it entirely and 4 characterized clusters fall off the tree even though
    # GTDB has the genome. These two indexes are the NCBI-name fallback.
    by_ncbi_binomial: dict[str, tuple[str, bool, str]] = {}
    by_ncbi_genus: dict[str, tuple[str, bool, str]] = {}
    rows: dict[str, str] = {}  # gtdb accession -> raw metadata line

    def offer(bucket: dict, key, accession: str, is_rep: bool, line: str) -> None:
        current = bucket.get(key)
        if current is None or (is_rep and not current[1]):
            bucket[key] = (accession, is_rep, line)

    with _open(args.gtdb) as fh:
        header = fh.readline().rstrip("\n")
        cols = header.split("\t")
        idx = {c: i for i, c in enumerate(cols)}
        need = max(
            idx["gtdb_taxonomy"],
            idx["ncbi_taxid"],
            idx["ncbi_species_taxid"],
            idx["gtdb_representative"],
            idx["ncbi_organism_name"],
        )

        scanned = 0
        for line in fh:
            row = line.rstrip("\n").split("\t")
            if len(row) <= need:
                continue
            scanned += 1
            # Same normalization ingest_gtdb applies ("RS_GCF_x" -> "GCF_x"),
            # imported rather than reimplemented so the mapping file can never
            # drift from the accessions actually written to the database.
            accession = normalize_gtdb_accession(row[idx["accession"]])
            is_rep = row[idx["gtdb_representative"]] == "t"
            gtdb_tax = row[idx["gtdb_taxonomy"]]

            try:
                taxid = int(row[idx["ncbi_taxid"]])
            except ValueError:
                taxid = None
            try:
                species_taxid = int(row[idx["ncbi_species_taxid"]])
            except ValueError:
                species_taxid = None

            species = ""
            genus = ""
            for part in gtdb_tax.split(";"):
                if part.startswith("s__") and len(part) > 3:
                    species = part[3:]
                elif part.startswith("g__") and len(part) > 3:
                    genus = part[3:]
            species_norm = normalize_species(species)
            genus_norm = normalize_genus(genus)
            raw = line.rstrip("\n")

            if taxid is not None and taxid in want_taxid:
                offer(by_taxid, taxid, accession, is_rep, raw)
            if species_taxid is not None and species_taxid in want_taxid:
                offer(by_species_taxid, species_taxid, accession, is_rep, raw)
            if species_norm and species_norm in want_binomial:
                offer(by_binomial, species_norm, accession, is_rep, raw)
            if genus_norm and genus_norm in want_genus:
                offer(by_genus, genus_norm, accession, is_rep, raw)

            ncbi_name = row[idx["ncbi_organism_name"]]
            if ncbi_name:
                ncbi_bin = binomial(ncbi_name)
                ncbi_gen = normalize_genus(genus_token(ncbi_name))
                if ncbi_bin and ncbi_bin in want_binomial:
                    offer(by_ncbi_binomial, ncbi_bin, accession, is_rep, raw)
                if ncbi_gen and ncbi_gen in want_genus:
                    offer(by_ncbi_genus, ncbi_gen, accession, is_rep, raw)

    print(f"scanned {scanned} GTDB genomes")

    # Resolve each MIBiG entry, strongest match first.
    mapping: list[tuple[str, str, str]] = []
    methods: Counter = Counter()
    for e in entries:
        hit = None
        method = ""
        if e["taxid"] and e["taxid"] in by_taxid:
            hit, method = by_taxid[e["taxid"]], "ncbi_taxid"
        elif e["taxid"] and e["taxid"] in by_species_taxid:
            hit, method = by_species_taxid[e["taxid"]], "ncbi_species_taxid"
        elif e["binomial"] and e["binomial"] in by_binomial:
            hit, method = by_binomial[e["binomial"]], "gtdb_species"
        elif e["binomial"] and e["binomial"] in by_ncbi_binomial:
            # Weakest of the genome-level matches, so it is tried last: it
            # says "GTDB holds this genome, under a name it has since
            # revised". The cluster still lands on GTDB's own lineage for
            # that genome, which is the honest placement — MIBiG's organism
            # name stays on the record.
            hit, method = by_ncbi_binomial[e["binomial"]], "ncbi_species_name"

        if hit is not None:
            mapping.append((e["accession"], hit[0], method))
            rows[hit[0]] = hit[2]
            methods[method] += 1
        else:
            # No genome-level hit. Keep a genus representative so
            # `graft-taxonomy` can still place the organism on the tree.
            genus_hit = by_genus.get(e["genus"]) or by_ncbi_genus.get(e["genus"])
            if genus_hit is not None:
                rows[genus_hit[0]] = genus_hit[2]
                methods["genus_only"] += 1
            else:
                methods["unplaced"] += 1

    total = max(len(entries), 1)
    placed = sum(
        methods[m]
        for m in ("ncbi_taxid", "ncbi_species_taxid", "gtdb_species", "ncbi_species_name")
    )
    print()
    print(f"MIBiG entry placement ({len(entries)} active):")
    for m in (
        "ncbi_taxid",
        "ncbi_species_taxid",
        "gtdb_species",
        "ncbi_species_name",
        "genus_only",
        "unplaced",
    ):
        if methods[m]:
            print(f"  {m:20} {methods[m]:5}  ({100 * methods[m] // total}%)")
    print(f"  -> genome-level      {placed:5}  ({100 * placed // total}%)")

    if args.context_genera:
        extra = [v[2] for v in by_genus.values() if v[0] not in rows][: args.context_genera]
        for line in extra:
            rows[line.split("\t")[0]] = line

    print(f"\nGTDB genomes to ingest: {len(rows)}")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    with open(args.out, "w", encoding="utf-8", newline="") as out:
        out.write(header + "\n")
        for line in rows.values():
            out.write(line + "\n")
    print(f"wrote {args.out}")

    args.map_out.parent.mkdir(parents=True, exist_ok=True)
    with open(args.map_out, "w", encoding="utf-8", newline="") as out:
        out.write("mibig_accession\tgtdb_accession\tmatch_method\n")
        for acc, gtdb_acc, method in mapping:
            out.write(f"{acc}\t{gtdb_acc}\t{method}\n")
    print(f"wrote {args.map_out} ({len(mapping)} rows)")


if __name__ == "__main__":
    main()
