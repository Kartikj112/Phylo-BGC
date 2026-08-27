"""Graft parent-less species onto the GTDB genus backbone.

MIBiG records only an organism *name* and NCBI tax id — no lineage. So
`ingest_mibig_entries` creates each entry's organism as a bare
species-rank `Taxon` with no parent, and unless GTDB happened to ingest
that exact species already (rare: MIBiG names carry strain suffixes GTDB
doesn't use), it stays a root-level orphan. The result is "MIBiG next to
the GTDB tree" rather than "MIBiG mapped onto it".

This pass closes that gap the pragmatic way: attach each orphan species to
the GTDB genus its name points at. It is a *nomenclatural* link — "this
organism is a *Streptomyces*, so show it under GTDB's *Streptomyces*" —
not a phylogenetic placement, and it only runs where the genus name
resolves unambiguously. Organisms whose genus isn't in GTDB's bacterial
taxonomy (fungi, plants, unresolved names) are left unparented on purpose;
they are not bacteria and do not belong on this tree.

Idempotent: species that already have a parent are untouched, so it is
safe to re-run after topping up either source.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from sqlalchemy.orm import Session

from bgcscape.models import Genome, Taxon, TaxonRank


def normalize_genus(genus: str) -> str:
    """Lowercase, and drop GTDB's polyphyly split suffix so an NCBI-style
    genus name matches: `Streptomyces_A` -> `streptomyces`. Must stay in
    step with scripts/build_gtdb_subset.py's copy of this rule."""
    return re.sub(r"_[a-z]+$", "", genus.strip().lower())


def genus_token(organism_name: str) -> str:
    """The genus word of an organism name: `Candidatus X` -> `x`,
    `[Genus] sp. STRAIN` -> `genus`, `Genus species STRAIN` -> `genus`."""
    name = organism_name.strip().strip("[]")
    parts = name.split()
    if parts and parts[0].lower() in ("candidatus", "ca."):
        parts = parts[1:]
    return re.sub(r"[^A-Za-z-]", "", parts[0]).lower() if parts else ""


@dataclass
class GraftReport:
    grafted: int = 0
    already_placed: int = 0
    unmatched: int = 0
    unmatched_examples: list[str] = field(default_factory=list)

    def __str__(self) -> str:  # pragma: no cover - human-facing summary
        return (
            f"grafted={self.grafted} already_placed={self.already_placed} "
            f"unmatched={self.unmatched}"
        )


def graft_orphan_species(session: Session, *, only_with_genomes: bool = True) -> GraftReport:
    """Attach root-level species Taxa to a matching GTDB genus.

    `only_with_genomes=True` (the default) restricts the pass to species
    that actually carry a genome — the ones that matter for the tree —
    leaving bare taxonomy rows alone.
    """
    genera_by_norm: dict[str, Taxon] = {}
    for genus in session.query(Taxon).filter(Taxon.rank == TaxonRank.GENUS).all():
        norm = normalize_genus(genus.name)
        existing = genera_by_norm.get(norm)
        # Prefer the un-suffixed name on collision (`Streptomyces` over
        # `Streptomyces_A`) so the graft target reads naturally.
        if existing is None or (existing.name.lower() != norm and genus.name.lower() == norm):
            genera_by_norm[norm] = genus

    species_with_genomes: set = set()
    if only_with_genomes:
        species_with_genomes = {
            row[0]
            for row in session.query(Genome.taxon_id).filter(Genome.taxon_id.isnot(None)).all()
        }

    report = GraftReport()
    orphans = (
        session.query(Taxon)
        .filter(Taxon.rank == TaxonRank.SPECIES, Taxon.parent_id.is_(None))
        .all()
    )
    for species in orphans:
        if only_with_genomes and species.id not in species_with_genomes:
            continue
        target = genera_by_norm.get(normalize_genus(genus_token(species.name)))
        if target is None or target.id == species.id:
            report.unmatched += 1
            if len(report.unmatched_examples) < 25:
                report.unmatched_examples.append(species.name)
            continue
        species.parent_id = target.id
        report.grafted += 1

    # Any species that gained a parent but still has none of its own
    # ancestors classified is fine — the genus carries the rest of the
    # lineage from GTDB.
    already = (
        session.query(Taxon)
        .filter(Taxon.rank == TaxonRank.SPECIES, Taxon.parent_id.isnot(None))
        .count()
    )
    report.already_placed = already
    session.commit()
    return report
