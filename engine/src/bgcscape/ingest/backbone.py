"""Load the whole GTDB taxonomy into the background backbone.

See `models/backbone.py` for why this is separate from the corpus. This
module never reads or writes `taxon` or `genome`.

## One pass, then bulk inserts

`bac120_metadata.tsv.gz` has ~880,000 rows. The corpus loader commits one
row at a time so a bad row cannot abort a run, which is right for thousands
of rows and far too slow for this. Here the file is read once into memory
(the tree, per-node counts, and the genome rows to keep), and then written
with chunked multi-row INSERTs. A malformed row is recorded in the report
and skipped, as elsewhere; it just is not a transaction of its own.

## Reloading replaces

The backbone is a snapshot of one release. Loading the same release again
deletes that release's rows first and writes them fresh, inside one
transaction, so a reader never sees half of two loads. A different release
(another `Source` version) is left alone.
"""
from __future__ import annotations

import uuid
from collections.abc import Iterable
from dataclasses import dataclass, field

from sqlalchemy import delete, insert
from sqlalchemy.orm import Session

from bgcscape.ingest.gtdb import normalize_gtdb_accession, parse_gtdb_taxonomy_string
from bgcscape.models import BackboneGenome, BackboneNode, EvidenceLevel, Source, TaxonRank

#: Rows per INSERT statement. Large enough to make 200,000 rows a few seconds
#: of work; small enough to stay under SQLite's and psycopg's parameter limits.
_CHUNK = 5_000

_PREFIX = {
    TaxonRank.DOMAIN: "d__",
    TaxonRank.PHYLUM: "p__",
    TaxonRank.CLASS: "c__",
    TaxonRank.ORDER: "o__",
    TaxonRank.FAMILY: "f__",
    TaxonRank.GENUS: "g__",
    TaxonRank.SPECIES: "s__",
}


@dataclass
class BackboneReport:
    rows_read: int = 0
    genomes_counted: int = 0
    #: Species nodes given their representative genome's accession.
    representatives: int = 0
    #: Rows written to `backbone_genome` (only with `all_genomes`).
    genomes_stored: int = 0
    nodes_by_rank: dict[str, int] = field(default_factory=dict)
    errors: list[tuple[str, str]] = field(default_factory=list)

    @property
    def nodes(self) -> int:
        return sum(self.nodes_by_rank.values())


@dataclass
class _Node:
    id: uuid.UUID
    parent_key: str | None
    name: str
    rank: TaxonRank
    genome_count: int = 0
    species_count: int = 0
    representative_accession: str | None = None


def _lineage_key(path: list[tuple[TaxonRank, str]]) -> str:
    return ";".join(f"{_PREFIX[rank]}{name}" for rank, name in path)


def build_backbone(
    session: Session,
    source: Source,
    rows: Iterable[dict[str, str]],
    *,
    all_genomes: bool = False,
) -> BackboneReport:
    """Replace `source`'s backbone with the taxonomy in `rows`.

    `rows` are GTDB metadata rows (`accession`, `gtdb_taxonomy`,
    `gtdb_genome_representative`), from one file or several chained, e.g.
    bac120 then ar53. Every row is counted and each species node records its
    representative; genome rows are written only with `all_genomes`. Commits
    on success, rolls back on failure.
    """
    report = BackboneReport()
    nodes: dict[str, _Node] = {}
    # (accession, node key, is representative); filled only for all_genomes.
    # Keys are lineage strings, used only while building: they are what makes
    # "Bacillus under Bacillaceae" and a same-named genus elsewhere different
    # nodes, and they are not stored.
    genomes: list[tuple[str, str, bool]] = []
    seen_accessions: set[str] = set()

    for row in rows:
        report.rows_read += 1
        raw_accession = (row.get("accession") or row.get("accno") or "").strip()
        identifier = raw_accession or f"<row {report.rows_read}>"
        if not raw_accession:
            report.errors.append((identifier, "no accession"))
            continue
        if "gtdb_genome_representative" not in row:
            # Without it every genome would be stored or none would, silently.
            raise ValueError(
                "rows have no gtdb_genome_representative column. Use GTDB's *_metadata.tsv "
                "files, not *_taxonomy.tsv."
            )
        path = parse_gtdb_taxonomy_string(row.get("gtdb_taxonomy") or "")
        if not path or path[0][0] is not TaxonRank.DOMAIN:
            report.errors.append((identifier, "no GTDB lineage"))
            continue

        accession = normalize_gtdb_accession(raw_accession)
        if accession in seen_accessions:
            report.errors.append((identifier, "accession appears twice"))
            continue
        seen_accessions.add(accession)

        parent_key: str | None = None
        for depth in range(1, len(path) + 1):
            key = _lineage_key(path[:depth])
            node = nodes.get(key)
            if node is None:
                rank, name = path[depth - 1]
                node = nodes[key] = _Node(uuid.uuid4(), parent_key, name, rank)
            node.genome_count += 1
            parent_key = key
        report.genomes_counted += 1

        # Compared without the RS_/GB_ prefix: a genome listed as GB_ in one
        # column and RS_ in the other is still its own representative.
        rep_accession = (row.get("gtdb_genome_representative") or "").strip()
        representative = bool(rep_accession) and accession == normalize_gtdb_accession(rep_accession)
        leaf = nodes[parent_key]
        if representative and leaf.rank is TaxonRank.SPECIES and leaf.representative_accession is None:
            leaf.representative_accession = accession
        if all_genomes:
            genomes.append((accession, parent_key, representative))

    # species_count is a roll-up over the finished tree, so it waits for the
    # last row. Deepest ranks first means every child is final before its
    # parent adds it.
    rank_order = list(_PREFIX)
    ordered = sorted(nodes.items(), key=lambda kv: rank_order.index(kv[1].rank))
    for _, node in reversed(ordered):
        if node.rank is TaxonRank.SPECIES:
            node.species_count = 1
        if node.parent_key is not None:
            nodes[node.parent_key].species_count += node.species_count

    try:
        session.execute(delete(BackboneGenome).where(BackboneGenome.source_id == source.id))
        session.execute(delete(BackboneNode).where(BackboneNode.source_id == source.id))

        evidence = EvidenceLevel.OBSERVED_CURATED
        # Parents first, so the self-referencing foreign key holds on
        # databases that check it per statement. Rows are built one chunk
        # at a time: materialising all ~250,000 (or ~900,000 genome) dicts
        # at once was the largest single cost in a load's peak memory.
        def node_row(node: _Node) -> dict:
            return {
                "id": node.id,
                "parent_id": nodes[node.parent_key].id if node.parent_key else None,
                "name": node.name,
                "rank": node.rank,
                "genome_count": node.genome_count,
                "species_count": node.species_count,
                "representative_accession": node.representative_accession,
                "source_id": source.id,
                "evidence_level": evidence,
            }

        for start in range(0, len(ordered), _CHUNK):
            chunk = [node_row(node) for _, node in ordered[start : start + _CHUNK]]
            session.execute(insert(BackboneNode), chunk)

        for start in range(0, len(genomes), _CHUNK):
            chunk = [
                {
                    "accession": accession,
                    "node_id": nodes[key].id,
                    "is_species_representative": representative,
                    "source_id": source.id,
                    "evidence_level": evidence,
                }
                for accession, key, representative in genomes[start : start + _CHUNK]
            ]
            session.execute(insert(BackboneGenome), chunk)
        session.commit()
    except Exception:
        session.rollback()
        raise

    for node in nodes.values():
        report.nodes_by_rank[node.rank.value] = report.nodes_by_rank.get(node.rank.value, 0) + 1
    report.representatives = sum(1 for n in nodes.values() if n.representative_accession)
    report.genomes_stored = len(genomes)
    return report
