"""Ingest an antiSMASH result that arrived over HTTP, and put it on the tree.

`ingest/antismash.py` already turns one antiSMASH run into BGC rows. What it
deliberately does NOT do is decide where the genome sits taxonomically — it
has no way to know, because antiSMASH's JSON records neither an assembly
accession nor a lineage (see that module's docstring).

For the CLI that is fine: the operator runs `graft-taxonomy` afterwards. For
an upload from the browser it is not, and the gap is invisible rather than
loud: `tree_builder.genomes_by_taxon` skips every genome whose `taxon_id` is
NULL, so an upload that ingested perfectly would simply never appear, and
the reader would be told "312 regions ingested" while looking at an
unchanged tree. That is the exact failure this module exists to prevent.

So one call does the whole chain, and reports honestly which rung it reached:

    parse -> BGC rows -> species Taxon -> graft onto the GTDB genus

`placement` in the result says how far it got, and the frontend shows it.
"unplaced" is a real outcome, not an error: a genome with no organism name,
or one whose genus GTDB does not carry (a fungus, say), is kept and counted
but honestly reported as absent from the tree rather than quietly dropped.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Literal

from sqlalchemy.orm import Session

from bgcscape.ingest.antismash import ingest_antismash_result
from bgcscape.ingest.graft import genus_token, normalize_genus
from bgcscape.models import Genome, Source, SourceType, Taxon, TaxonRank
from bgcscape.models.base import EvidenceLevel
from bgcscape.schemas import TaxonCreate
from bgcscape.ingest._util import get_or_create_or_update

Placement = Literal["grafted", "species_only", "unplaced"]


@dataclass
class UploadedGenome:
    """What became of one uploaded file."""

    filename: str
    accession: str
    genome_id: str | None = None
    regions_created: int = 0
    regions_updated: int = 0
    #: How far up the chain this genome got. Only "grafted" means it is
    #: visible in its real phylogenetic position.
    placement: Placement = "unplaced"
    #: The species Taxon the genome was attached to, if any.
    organism: str | None = None
    #: The GTDB genus it was grafted onto, if that succeeded.
    grafted_to: str | None = None
    errors: list[str] = field(default_factory=list)

    @property
    def regions(self) -> int:
        return self.regions_created + self.regions_updated


def _species_taxon(session: Session, source: Source, organism: str) -> Taxon:
    """Find or create the species-rank Taxon for an organism name.

    Keyed on `(rank, name)` exactly as GTDB ingestion keys its own taxa, so
    uploading a genome for an organism GTDB already carries reuses that row —
    the genome joins the existing species rather than creating a second one
    beside it with the same name.
    """
    create = TaxonCreate(
        name=organism,
        rank=TaxonRank.SPECIES,
        source_id=source.id,
        # The name came from a person typing it into a form. That is not
        # curation, and calling it OBSERVED_CURATED would launder a guess
        # into evidence.
        evidence_level=EvidenceLevel.PREDICTED,
    )
    taxon, _ = get_or_create_or_update(
        session,
        Taxon,
        lookup={"rank": TaxonRank.SPECIES, "name": organism},
        values=create.model_dump(exclude={"rank", "name"}),
        # Never let an upload downgrade a species GTDB already classified:
        # its source_id and evidence_level are the better record.
        update_existing=False,
    )
    session.flush()
    return taxon


def _graft(session: Session, species: Taxon) -> Taxon | None:
    """Attach a species to the GTDB genus its name points at.

    The same nomenclatural rule `ingest/graft.py` applies in bulk, for one
    species: "this organism is a *Streptomyces*, so show it under GTDB's
    *Streptomyces*". Not a phylogenetic placement — it is a claim about the
    name, and it only fires where the genus resolves unambiguously.

    Returns the genus it attached to, or None if there was no match (a
    genus GTDB does not carry, or an unparseable name).
    """
    if species.parent_id is not None:
        return session.get(Taxon, species.parent_id)

    wanted = normalize_genus(genus_token(species.name))
    if not wanted:
        return None

    best: Taxon | None = None
    for genus in session.query(Taxon).filter(Taxon.rank == TaxonRank.GENUS).all():
        if normalize_genus(genus.name) != wanted or genus.id == species.id:
            continue
        # Prefer the un-suffixed name on collision (`Streptomyces` over
        # `Streptomyces_A`), matching graft_orphan_species.
        if best is None or (best.name.lower() != wanted and genus.name.lower() == wanted):
            best = genus
    if best is None:
        return None

    species.parent_id = best.id
    return best


def get_or_create_upload_source(session: Session, label: str) -> Source:
    """The Source row every upload from this label points back at.

    SourceType.USER_UPLOAD, never TOOL_RUN: the whole point of the
    provenance model is that a reader can tell curated reference data from
    something a visitor added. It is also what makes an upload removable
    later without touching the reference corpus.
    """
    source = (
        session.query(Source)
        .filter_by(name=label, source_type=SourceType.USER_UPLOAD)
        .one_or_none()
    )
    if source is None:
        source = Source(
            name=label,
            source_type=SourceType.USER_UPLOAD,
            version=None,
            retrieved_at=datetime.now(timezone.utc),
        )
        session.add(source)
        session.flush()
    return source


def ingest_uploaded_antismash(
    session: Session,
    *,
    source: Source,
    raw: dict[str, Any],
    filename: str,
    genome_accession: str,
    organism: str | None = None,
    is_mag: bool = False,
) -> UploadedGenome:
    """Ingest one uploaded antiSMASH result and place it on the tree.

    Everything here is PREDICTED — antiSMASH's regions are predictions, and
    the organism name is a person's assertion, not a curated fact.
    """
    result = UploadedGenome(filename=filename, accession=genome_accession)

    report = ingest_antismash_result(session, source, raw, genome_accession=genome_accession)
    result.regions_created = report.created
    result.regions_updated = report.updated
    for identifier, message in report.errors:
        result.errors.append(f"{identifier}: {message}")

    genome = session.query(Genome).filter_by(accession=genome_accession).one_or_none()
    if genome is None:
        # The parse failed before any row was written; ingest_antismash_result
        # has already recorded why in report.errors.
        return result
    result.genome_id = str(genome.id)

    if is_mag:
        genome.is_mag = True

    if organism and organism.strip():
        species = _species_taxon(session, source, organism.strip())
        genome.taxon_id = species.id
        result.organism = species.name
        result.placement = "species_only"
        genus = _graft(session, species)
        if genus is not None:
            result.grafted_to = genus.name
            result.placement = "grafted"

    session.commit()
    return result
