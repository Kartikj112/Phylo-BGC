"""Place eukaryotes using NCBI Taxonomy.

## Why this exists

GTDB is prokaryote-only. Roughly a fifth of MIBiG's characterized clusters
come from fungi and plants — *Aspergillus*, *Penicillium*, *Fusarium*,
*Arabidopsis* — and GTDB cannot represent them at all, so they land in the
tree as bare species with no lineage above them. Every one of those species
already carries an `ncbi_taxid` from MIBiG, so the lineage is a direct
lookup rather than a name match.

## Two taxonomies, deliberately not interleaved

GTDB (genome-based, rank-normalised) and NCBI (literature-based) are
different methodologies that disagree, so this does NOT graft eukaryotes onto
the GTDB backbone. It builds a separate Eukaryota tree that the interface
serves as its own view — see `TreeScope` in api/tree_builder.py. A reader is
therefore never looking at a hybrid of two taxonomies without being told.

## Which ranks are kept

NCBI's lineages carry many intermediate ranks. Measured over the 271
organisms this actually has to place, the canonical Linnaean ranks are
near-universal (domain 266, kingdom 263, phylum 264, class 262, order 262,
family 256, genus 260, species 269) while `clade` alone appears 958 times and
`no rank` 70 — unnamed cladistic groupings that would triple the depth of
every lineage without adding a rank a biologist would cite. Only the
canonical ranks are stored; `kingdom` is the one this project had to add to
`TaxonRank`, because GTDB never emits it.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from sqlalchemy.orm import Session

from bgcscape.models import EvidenceLevel, Source, Taxon, TaxonRank

#: NCBI rank strings that map onto `TaxonRank`. Anything else in a lineage
#: (clade, no rank, subphylum, strain, ...) is skipped — see the module
#: docstring for the measurement behind that choice.
CANONICAL_RANKS: dict[str, TaxonRank] = {
    "domain": TaxonRank.DOMAIN,
    "superkingdom": TaxonRank.DOMAIN,  # older dumps name the same level this way
    "kingdom": TaxonRank.KINGDOM,
    "phylum": TaxonRank.PHYLUM,
    "class": TaxonRank.CLASS,
    "order": TaxonRank.ORDER,
    "family": TaxonRank.FAMILY,
    "genus": TaxonRank.GENUS,
    "species": TaxonRank.SPECIES,
}

#: The eukaryote root. Prokaryotes keep their GTDB lineage; this module only
#: places organisms GTDB has no representation for.
EUKARYOTA_TAXID = 2759


@dataclass
class NcbiTaxonomyReport:
    resolved: int = 0
    unresolved: int = 0
    taxa_created: int = 0
    taxa_reused: int = 0
    species_attached: int = 0
    strains_under_species: int = 0
    skipped_non_eukaryote: int = 0
    examples: list[str] = field(default_factory=list)

    def __str__(self) -> str:  # pragma: no cover - human-facing summary
        return (
            f"attached={self.species_attached} lineage_nodes_created={self.taxa_created} "
            f"unresolved={self.unresolved}"
        )


def read_nodes(path: Path) -> tuple[dict[int, int], dict[int, str]]:
    """`nodes.dmp` -> (parent map, rank map).

    The whole file is loaded because a lineage walk can reach any node. Rank
    strings are interned: there are a few dozen distinct values across ~3
    million rows, so sharing them saves far more than the dict costs.
    """
    parent: dict[int, int] = {}
    rank: dict[int, str] = {}
    interned: dict[str, str] = {}
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            parts = line.split("\t|\t", 3)
            if len(parts) < 3:
                continue
            taxid = int(parts[0])
            parent[taxid] = int(parts[1])
            r = parts[2].strip()
            rank[taxid] = interned.setdefault(r, r)
    return parent, rank


def read_merged(path: Path) -> dict[int, int]:
    """`merged.dmp` -> old taxid to current taxid.

    NCBI retires taxids by merging them. MIBiG entries can predate a merge,
    so a lookup that ignores this silently loses organisms that are still
    perfectly resolvable.
    """
    merged: dict[int, int] = {}
    if not path.exists():
        return merged
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            parts = line.split("\t|")
            if len(parts) >= 2:
                merged[int(parts[0])] = int(parts[1].strip())
    return merged


def read_scientific_names(path: Path, wanted: set[int]) -> dict[int, str]:
    """Scientific names for `wanted` taxids only.

    Filtered during the scan rather than loaded wholesale: names.dmp is
    ~310 MB and carries every synonym, common name and misspelling, of which
    this needs a few thousand scientific names.
    """
    names: dict[int, str] = {}
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            if "scientific name" not in line:
                continue
            parts = line.split("\t|\t")
            if len(parts) < 4:
                continue
            taxid = int(parts[0])
            if taxid in wanted:
                names[taxid] = parts[1].strip()
    return names


def lineage_of(
    taxid: int,
    parent: dict[int, int],
    rank: dict[int, str],
    merged: dict[int, int],
) -> list[tuple[int, TaxonRank]] | None:
    """Root-first canonical lineage for `taxid`, or None if unresolvable.

    Returns only ranks in `CANONICAL_RANKS`. The `seen` guard is not
    defensive dressing: NCBI's root is its own parent, so an unguarded walk
    never terminates.
    """
    current = taxid if taxid in parent else merged.get(taxid)
    if current is None or current not in parent:
        return None

    chain: list[tuple[int, TaxonRank]] = []
    seen: set[int] = set()
    while current in parent and current not in seen and current != 1:
        seen.add(current)
        mapped = CANONICAL_RANKS.get(rank.get(current, ""))
        if mapped is not None:
            chain.append((current, mapped))
        current = parent[current]
    chain.reverse()
    return chain or None


def is_eukaryote(taxid: int, parent: dict[int, int], merged: dict[int, int]) -> bool:
    current = taxid if taxid in parent else merged.get(taxid)
    seen: set[int] = set()
    while current is not None and current in parent and current not in seen and current != 1:
        if current == EUKARYOTA_TAXID:
            return True
        seen.add(current)
        current = parent[current]
    return False


def ingest_ncbi_lineages(
    session: Session,
    source: Source,
    taxdump_dir: Path,
    *,
    eukaryotes_only: bool = True,
) -> NcbiTaxonomyReport:
    """Give every unplaced taxon that has an `ncbi_taxid` its NCBI lineage.

    Operates on taxa that are parent-less and not themselves a domain — the
    organisms GTDB left stranded. Existing rows are REUSED, never duplicated:
    they already carry the genomes and clusters, so this attaches a parent
    rather than creating a second copy of the species.
    """
    report = NcbiTaxonomyReport()

    orphans = (
        session.query(Taxon)
        .filter(Taxon.parent_id.is_(None), Taxon.rank != TaxonRank.DOMAIN)
        .filter(Taxon.ncbi_taxid.isnot(None))
        .all()
    )
    if not orphans:
        return report

    parent, rank = read_nodes(taxdump_dir / "nodes.dmp")
    merged = read_merged(taxdump_dir / "merged.dmp")

    resolved: dict[Taxon, list[tuple[int, TaxonRank]]] = {}
    needed: set[int] = set()
    for taxon in orphans:
        taxid = int(taxon.ncbi_taxid)  # type: ignore[arg-type]
        if eukaryotes_only and not is_eukaryote(taxid, parent, merged):
            report.skipped_non_eukaryote += 1
            continue
        chain = lineage_of(taxid, parent, rank, merged)
        if chain is None:
            report.unresolved += 1
            continue
        resolved[taxon] = chain
        needed.update(t for t, _ in chain)
        report.resolved += 1

    if not resolved:
        return report

    names = read_scientific_names(taxdump_dir / "names.dmp", needed)

    # One Taxon per NCBI taxid, keyed so a lineage shared by many species is
    # built once. Seeded with what the database already holds so a re-run
    # updates rather than duplicating.
    by_taxid: dict[int, Taxon] = {
        int(t.ncbi_taxid): t
        for t in session.query(Taxon).filter(Taxon.ncbi_taxid.isnot(None)).all()
        if t.ncbi_taxid is not None
    }

    for taxon, chain in resolved.items():
        parent_row: Taxon | None = None
        own_taxid = int(taxon.ncbi_taxid)  # type: ignore[arg-type]
        attached = False
        for taxid, mapped_rank in chain:
            # The organism's own node is the row we already have: attach it to
            # the lineage instead of creating a rival copy beside it.
            if taxid == own_taxid:
                taxon.parent_id = parent_row.id if parent_row else None
                if taxon.rank != mapped_rank:
                    taxon.rank = mapped_rank
                by_taxid[taxid] = taxon
                parent_row = taxon
                report.species_attached += 1
                attached = True
                continue

            existing = by_taxid.get(taxid)
            if existing is None:
                existing = Taxon(
                    name=names.get(taxid, f"taxid:{taxid}"),
                    rank=mapped_rank,
                    parent_id=parent_row.id if parent_row else None,
                    ncbi_taxid=taxid,
                    source_id=source.id,
                    evidence_level=EvidenceLevel.OBSERVED_CURATED,
                )
                session.add(existing)
                session.flush()
                by_taxid[taxid] = existing
                report.taxa_created += 1
                if len(report.examples) < 10:
                    report.examples.append(f"{existing.name} ({mapped_rank.value})")
            else:
                # Re-run, or a lineage shared with an earlier organism.
                if existing.parent_id is None and parent_row is not None:
                    existing.parent_id = parent_row.id
                report.taxa_reused += 1
            parent_row = existing

        if not attached and parent_row is not None:
            # The organism's OWN taxid was not a canonical rank, so it never
            # appeared in the chain and would have been left stranded while
            # its ancestors were created around it. 62 of these are NCBI
            # `strain` taxids — "Aspergillus nidulans FGSC A4" is a strain,
            # not a species — plus a handful of varietas/subspecies. They
            # hang under the deepest canonical ancestor, which is their
            # species.
            #
            # Its existing rank is kept rather than rewritten: MIBiG tracks
            # these strains separately and collapsing them into the species
            # node would merge organisms the source deliberately
            # distinguishes.
            taxon.parent_id = parent_row.id
            report.species_attached += 1
            report.strains_under_species += 1

    session.commit()
    return report
