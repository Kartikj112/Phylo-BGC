"""Attach MIBiG clusters to the GTDB genome of the organism they came from.

MIBiG ingestion creates a `Genome` stub for the deposited GenBank *locus*
(`loci[].accession`), because that is genuinely what a MIBiG entry
describes -- see ingest/mibig.py. That stub has no lineage: MIBiG records an
organism name and an NCBI taxid, nothing above it. Ingested alone, MIBiG is
therefore a fan of root-level species rather than a tree.

This pass re-points each cluster at the GTDB genome for the same organism,
using a mapping produced by `scripts/build_gtdb_subset.py` (matched on NCBI
taxid, falling back to species binomial). The cluster then sits on the real
GTDB backbone -- domain to species -- which is what makes "where is this
BGC across the tree of life" answerable at all.

## What the link claims, and what it does not

It claims: *this cluster was characterized in this organism, and this is
GTDB's genome for that organism.* It does **not** claim the cluster was
called on that assembly. Those are different statements, and conflating
them would be exactly the kind of overclaim this project's provenance model
exists to prevent. Three things keep the distinction visible:

  - `BGC.contig` still holds MIBiG's own locus accession, untouched.
  - The match method and its confidence are stored as columns on
    `BGCOrganismPlacement`, so "which entries rest on weak name matching?"
    is a query rather than a paragraph in a report.
  - `evidence_level` on the cluster is unchanged: it is still
    OBSERVED_CURATED, because the curation is MIBiG's. The *placement* row
    is COMPUTED, because the placement is ours.

## Where the placement is stored, and why it moved

It is a row in `bgc_organism_placement` (see models/placement.py), whose
`representative_genome_id` column carries the claim in its name: GTDB's
genome represents the organism; it is not the assembly the cluster came off.

It is ALSO still written into `BGC.raw_annotation` under `PLACEMENT_KEY`,
deliberately. Two reasons, neither of them "we forgot to remove it": the
Alembic downgrade drops the table, and the JSON is what a downgraded
database still has; and a `raw_annotation` blob exported from this database
stays self-describing. `placement_of()` reads the table first and falls back
to the JSON, so a database migrated but not yet re-linked still answers.

Idempotent: re-running over the same mapping is a no-op.
"""
from __future__ import annotations

import csv
from dataclasses import dataclass, field
from pathlib import Path

from sqlalchemy.orm import Session

from bgcscape.models import (
    CONFIDENCE_BY_METHOD,
    BGC,
    BGCOrganismPlacement,
    EvidenceLevel,
    Genome,
    PlacementMethod,
    Taxon,
)

#: Key under which placement provenance is written into `BGC.raw_annotation`.
#: Namespaced so it can never collide with a field MIBiG itself defines.
PLACEMENT_KEY = "_bgcscape_placement"

#: What a reader must be told before citing a placement, per method. Stored
#: on each row rather than looked up at render time, so the caveat travels
#: with an export instead of living only in this file.
PLACEMENT_CAVEATS: dict[PlacementMethod, str] = {
    PlacementMethod.NCBI_TAXID: (
        "Placed by exact NCBI taxonomy ID match. This cluster was characterized in an organism "
        "this genome represents; it was NOT sequenced from this assembly."
    ),
    PlacementMethod.NCBI_SPECIES_TAXID: (
        "Placed by NCBI species-level taxonomy ID; the strain may differ. This cluster was "
        "characterized in an organism this genome represents; it was NOT sequenced from this "
        "assembly."
    ),
    PlacementMethod.GTDB_SPECIES: (
        "Placed by GTDB species name. This cluster was characterized in an organism this genome "
        "represents; it was NOT sequenced from this assembly."
    ),
    PlacementMethod.NCBI_SPECIES_NAME: (
        "Placed by free-text organism name only - GTDB has since reclassified this organism, so "
        "it appears under GTDB's current name rather than the one MIBiG records. A name match is "
        "the weakest join here. This cluster was NOT sequenced from this assembly."
    ),
    PlacementMethod.GENUS: (
        "Placed at genus level only: GTDB has no genome for this organism. The genome shown is a "
        "relative, not the source of this cluster."
    ),
    PlacementMethod.UNPLACED: "Not placed on the GTDB tree.",
}

#: How a cluster was put on the tree, strongest first. Surfaced in the UI.
PLACEMENT_METHOD_LABELS: dict[str, str] = {
    "ncbi_taxid": "Matched to a GTDB genome by NCBI taxonomy ID",
    "ncbi_species_taxid": "Matched to a GTDB genome by NCBI species taxonomy ID",
    "gtdb_species": "Matched to a GTDB genome by species name",
    "ncbi_species_name": (
        "Matched to a GTDB genome by its NCBI organism name -- GTDB has since "
        "reclassified this organism, so it appears on the tree under GTDB's "
        "current name for it, not the name MIBiG records"
    ),
    "genus": "Placed at genus level only -- GTDB has no genome for this organism",
    "unplaced": "Not placed on the GTDB tree",
}


@dataclass
class LinkReport:
    linked: int = 0
    already_linked: int = 0
    missing_bgc: int = 0
    missing_genome: int = 0
    pruned_genomes: int = 0
    pruned_taxa: int = 0
    #: Placements written, and how many rest on a free-text name match. The
    #: second number is the one a reader needs: it is the fraction of the
    #: corpus whose position on the tree is nomenclature rather than an
    #: identifier.
    placements_recorded: int = 0
    weak_placements: int = 0
    unknown_methods: set = field(default_factory=set)
    missing_examples: list[str] = field(default_factory=list)

    def __str__(self) -> str:  # pragma: no cover - human-facing summary
        return (
            f"linked={self.linked} already={self.already_linked} "
            f"missing_bgc={self.missing_bgc} missing_genome={self.missing_genome}"
        )


def read_mapping(path: str | Path) -> list[tuple[str, str, str]]:
    """Read the `mibig_accession, gtdb_accession, match_method` TSV."""
    rows: list[tuple[str, str, str]] = []
    with open(path, encoding="utf-8", newline="") as fh:
        reader = csv.DictReader(fh, delimiter="\t")
        for row in reader:
            accession = (row.get("mibig_accession") or "").strip()
            gtdb = (row.get("gtdb_accession") or "").strip()
            method = (row.get("match_method") or "").strip() or "unknown"
            if accession and gtdb:
                rows.append((accession, gtdb, method))
    return rows


def link_mibig_to_gtdb(
    session: Session,
    mapping: list[tuple[str, str, str]],
    *,
    prune_unlinked: bool = True,
) -> LinkReport:
    """Re-point mapped MIBiG clusters at their GTDB genome.

    `prune_unlinked` removes the MIBiG locus stubs left carrying no cluster
    afterwards, and any species Taxon left with no genomes and no children.
    Nothing is lost -- the locus accession stays on `BGC.contig` -- and
    leaving them would inflate the genome counts the UI reports with rows
    that are never drawn.
    """
    report = LinkReport()

    bgcs_by_accession = {
        bgc.mibig_accession: bgc
        for bgc in session.query(BGC).filter(BGC.mibig_accession.isnot(None)).all()
    }
    genomes_by_accession = {genome.accession: genome for genome in session.query(Genome).all()}

    for mibig_accession, gtdb_accession, method in mapping:
        bgc = bgcs_by_accession.get(mibig_accession)
        if bgc is None:
            report.missing_bgc += 1
            continue
        genome = genomes_by_accession.get(gtdb_accession)
        if genome is None:
            report.missing_genome += 1
            if len(report.missing_examples) < 20:
                report.missing_examples.append(f"{mibig_accession} -> {gtdb_accession}")
            continue

        placement = {"method": method, "gtdb_accession": gtdb_accession}
        if bgc.genome_id == genome.id:
            report.already_linked += 1
        else:
            bgc.genome_id = genome.id
            report.linked += 1

        # raw_annotation is a JSON column; SQLAlchemy only detects a change
        # when the attribute is reassigned, not when a dict is mutated.
        annotation = dict(bgc.raw_annotation or {})
        annotation[PLACEMENT_KEY] = placement
        bgc.raw_annotation = annotation

        _record_placement(session, bgc, genome, method, gtdb_accession, report)

    session.flush()

    if prune_unlinked:
        _prune_empty_mibig_rows(session, report)

    session.commit()
    return report


def _record_placement(
    session: Session,
    bgc: BGC,
    genome: Genome,
    method: str,
    gtdb_accession: str,
    report: LinkReport,
) -> None:
    """Upsert the queryable placement row for one cluster.

    A method the vocabulary does not contain is counted and skipped rather
    than coerced to something plausible. The mapping TSV's `match_method`
    column is free text produced by a script that can be edited; inventing a
    confidence for a value nobody defined would put a number on the tree
    that no method backs - which is the failure this table exists to end.
    """
    try:
        parsed_method = PlacementMethod(method)
    except ValueError:
        report.unknown_methods.add(method)
        return

    confidence = CONFIDENCE_BY_METHOD[parsed_method]
    existing = (
        session.query(BGCOrganismPlacement).filter_by(bgc_id=bgc.id).one_or_none()
    )
    if existing is None:
        session.add(
            BGCOrganismPlacement(
                bgc_id=bgc.id,
                representative_genome_id=genome.id,
                method=parsed_method,
                confidence=confidence,
                gtdb_accession=gtdb_accession,
                caveat=PLACEMENT_CAVEATS[parsed_method],
                source_id=bgc.source_id,
                # COMPUTED, never OBSERVED_CURATED. MIBiG curated the
                # cluster and named the organism; the join from that
                # organism to a GTDB genome is Phylo-BGC's inference, and
                # letting it inherit the cluster's curated level would
                # launder an inference into an observation.
                evidence_level=EvidenceLevel.COMPUTED,
            )
        )
    else:
        existing.representative_genome_id = genome.id
        existing.method = parsed_method
        existing.confidence = confidence
        existing.gtdb_accession = gtdb_accession
        existing.caveat = PLACEMENT_CAVEATS[parsed_method]

    report.placements_recorded += 1
    if confidence.value == "weak":
        report.weak_placements += 1


def _prune_empty_mibig_rows(session: Session, report: LinkReport) -> None:
    """Drop locus stubs and species nodes left holding nothing.

    Only rows with no remaining clusters, no genomes and no children are
    removed, so an entry that was never linked (GTDB has no genome for its
    organism) keeps its locus stub and stays on the tree.
    """
    bgc_counts: dict = {}
    for (genome_id,) in session.query(BGC.genome_id).all():
        bgc_counts[genome_id] = bgc_counts.get(genome_id, 0) + 1

    from bgcscape.models.genome import AssemblyLevel

    empty_locus_genomes = [
        genome
        for genome in session.query(Genome).filter(Genome.assembly_level == AssemblyLevel.LOCUS).all()
        if bgc_counts.get(genome.id, 0) == 0
    ]
    orphan_taxon_ids = {g.taxon_id for g in empty_locus_genomes if g.taxon_id is not None}
    for genome in empty_locus_genomes:
        session.delete(genome)
        report.pruned_genomes += 1
    session.flush()

    remaining_genome_taxa = {
        taxon_id for (taxon_id,) in session.query(Genome.taxon_id).distinct().all() if taxon_id
    }
    parent_ids = {
        parent_id for (parent_id,) in session.query(Taxon.parent_id).distinct().all() if parent_id
    }
    for taxon_id in orphan_taxon_ids:
        if taxon_id in remaining_genome_taxa or taxon_id in parent_ids:
            continue
        taxon = session.get(Taxon, taxon_id)
        # Only ever prune a leaf species that MIBiG created and nothing
        # else now references.
        if taxon is not None and taxon.parent_id is None:
            session.delete(taxon)
            report.pruned_taxa += 1
    session.flush()


def placement_of(bgc: BGC) -> dict | None:
    """The recorded placement for a cluster, or None if it was never linked.

    The `bgc_organism_placement` row is the system of record. The
    `raw_annotation` fallback is what answers for a database that has been
    migrated but not re-linked, and for one that has been downgraded - see
    the module docstring. Both shapes return the same dict, plus
    `confidence` and `caveat` where the table can supply them.
    """
    placement = bgc.placement
    if placement is not None:
        return {
            "method": placement.method.value,
            "gtdb_accession": placement.gtdb_accession,
            "confidence": placement.confidence.value,
            "caveat": placement.caveat,
        }
    annotation = bgc.raw_annotation or {}
    legacy = annotation.get(PLACEMENT_KEY)
    return legacy if isinstance(legacy, dict) else None
