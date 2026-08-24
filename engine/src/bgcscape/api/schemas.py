"""Response shapes for the visualization API.

These model what the *frontend* needs to render, not the database schema
1:1 — e.g. `TaxonTreeNode.genome_count` is aggregated across every
descendant, which has no equivalent column anywhere in bgcscape.models.
"""
from __future__ import annotations

import uuid

from pydantic import BaseModel

from bgcscape.models.base import EvidenceLevel
from bgcscape.models.bgc import BGCClass
from bgcscape.models.genome import AssemblyLevel
from bgcscape.models.taxonomy import TaxonRank


class BGCSummary(BaseModel):
    id: uuid.UUID
    bgc_class: BGCClass
    subtype: str | None = None
    mibig_accession: str | None = None
    evidence_level: EvidenceLevel
    family_ids: list[uuid.UUID] = []
    """Families this BGC belongs to. A list, not a single value: the same
    BGC is legitimately a member of different families at different
    BiG-SCAPE clustering cutoffs (see ingest/bigscape.py), so collapsing
    this to one id would silently pick an arbitrary cutoff's answer."""


class GenomeSummary(BaseModel):
    id: uuid.UUID
    accession: str
    assembly_level: AssemblyLevel
    is_mag: bool
    bgcs: list[BGCSummary]


class TaxonTreeNode(BaseModel):
    """A node in the rendered tree. The API always returns a single root
    of this shape with `id=None, rank=None` wrapping whatever top-level
    taxa actually exist (e.g. separate Bacteria/Archaea domain roots) —
    see tree_builder.py — so frontend code never has to special-case "a
    list of trees" versus "one tree."
    """

    id: uuid.UUID | None
    name: str
    rank: TaxonRank | None
    genome_count: int  # this node + every descendant
    bgc_class_counts: dict[str, int]  # aggregated the same way
    direct_genomes: list[GenomeSummary]  # genomes classified exactly here
    children: list["TaxonTreeNode"]


TaxonTreeNode.model_rebuild()


class CompoundSummary(BaseModel):
    id: uuid.UUID
    name: str
    chemical_formula: str | None = None
    compound_class: str | None = None


class BGCDetail(BaseModel):
    id: uuid.UUID
    genome_id: uuid.UUID
    genome_accession: str
    contig: str | None = None
    start_coord: int | None = None
    end_coord: int | None = None
    bgc_class: BGCClass
    subtype: str | None = None
    predicted_by_tool: str | None = None
    mibig_accession: str | None = None
    evidence_level: EvidenceLevel
    compounds: list[CompoundSummary]


class GenomeDetail(BaseModel):
    id: uuid.UUID
    accession: str
    assembly_level: AssemblyLevel
    is_mag: bool
    taxon_name: str | None = None
    taxon_rank: TaxonRank | None = None
    genome_size_bp: int | None = None
    gc_content_pct: float | None = None
    completeness_pct: float | None = None
    contamination_pct: float | None = None
    bgcs: list[BGCSummary]


class SearchResult(BaseModel):
    kind: str  # "taxon" | "genome"
    id: uuid.UUID
    label: str
    rank: TaxonRank | None = None
    accession: str | None = None


class BGCFamilySummary(BaseModel):
    """A Gene Cluster Family, with enough rolled-up context for the
    frontend to show why it's interesting without a second request.

    `taxon_names` powers the report's core question — is this family
    confined to one clade, or scattered across distant organisms? A family
    spanning several distinct taxa is exactly the horizontal-transfer /
    convergent-evolution signal the product is meant to surface.
    """

    id: uuid.UUID
    label: str
    clustering_method: str | None = None
    clustering_cutoff: float | None = None
    member_count: int
    bgc_classes: list[str]
    taxon_names: list[str]
    evidence_level: EvidenceLevel


class BGCFamilyMember(BaseModel):
    bgc_id: uuid.UUID
    bgc_class: BGCClass
    subtype: str | None = None
    genome_id: uuid.UUID
    genome_accession: str
    taxon_name: str | None = None
    evidence_level: EvidenceLevel
    similarity_score: float | None = None


class BGCFamilyDetail(BGCFamilySummary):
    members: list[BGCFamilyMember]


class FamilyRef(BaseModel):
    id: uuid.UUID
    label: str


class ClassProfileEntry(BaseModel):
    """One BGC class within one clade's profile.

    `count` and `per_genome` are both present deliberately: raw counts
    between clades of different sizes mostly measure sampling effort, so
    the UI should lead with the rate — but the count is what a reader
    needs to judge whether the rate rests on enough data to mean anything.
    """

    bgc_class: str
    count: int
    per_genome: float | None = None


class CladeSummary(BaseModel):
    taxon_id: uuid.UUID
    taxon_name: str
    rank: TaxonRank | None = None
    genome_count: int
    bgc_count: int
    bgcs_per_genome: float | None = None
    class_profile: list[ClassProfileEntry]
    family_count: int
    only_in_this_clade: list[FamilyRef]
    """Families found in this clade and none of the others compared.

    Named `only_in_*`, not `absent_from_others`: this reflects what was
    *observed in this dataset*, and cannot distinguish true absence
    elsewhere from insufficient sampling. See `CladeComparison.caveats`.
    """


class CladeComparison(BaseModel):
    clades: list[CladeSummary]
    shared_families: list[FamilyRef]
    """Families present in every compared clade (not merely in several)."""
    comparable: bool
    """False when sampling is too thin or lopsided for the numbers to
    support a claim about biology. The response is still returned — the UI
    should present it descriptively rather than as evidence."""
    caveats: list[str]
