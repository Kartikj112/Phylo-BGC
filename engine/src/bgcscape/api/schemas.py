"""Response shapes for the visualization API.

These model what the *frontend* needs to render, not the database schema
1:1 — e.g. `TaxonTreeNode.genome_count` is aggregated across every
descendant, which has no equivalent column anywhere in bgcscape.models.
"""
from __future__ import annotations

import uuid
from typing import Literal

from pydantic import BaseModel

from bgcscape.models.base import EvidenceLevel
from bgcscape.models.bgc import BGCClass
from bgcscape.models.genome import AssemblyLevel
from bgcscape.models.taxonomy import TaxonRank
from bgcscape.schemas.source import SourceRead


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


class DatasetProvenanceResponse(BaseModel):
    """What the current database actually contains, for figure captions
    and `ViewConfig.dataset`. Fetched rather than assembled client-side so
    a figure's recorded provenance always reflects the real database
    state, not the frontend's possibly-stale idea of it."""

    sources: list[SourceRead]
    genome_count: int
    bgc_count: int
    taxon_count: int
    family_count: int
    engine_version: str


class ExportRequest(BaseModel):
    """SVG produced by the frontend, plus the view state that made it."""

    svg: str
    view_config: dict
    """The ViewConfig as JSON. Typed as dict here and validated by
    ViewConfig itself in the endpoint, so validation lives in one place
    (bgcscape.export.view_config) rather than being duplicated into the
    API schema and drifting."""
    format: Literal["svg", "pdf"] = "pdf"


class ComponentScoreOut(BaseModel):
    name: str
    value: float | None
    """None means the component could not be computed — which is different
    from, and must never be rendered as, a low or high score."""
    available: bool
    explanation: str


class PrioritizationOut(BaseModel):
    bgc_id: uuid.UUID
    genome_accession: str
    taxon_name: str | None = None
    bgc_class: BGCClass
    score: float | None
    """None when too few components were computable to combine."""
    components: list[ComponentScoreOut]
    unavailable_components: list[str]


class PrioritizationResponse(BaseModel):
    """Ranked prioritization candidates.

    `caveats` is not decoration: these framings are the difference between
    a useful triage aid and a tool that manufactures false confidence. A
    client that renders `score` without them is misusing this endpoint.
    """

    results: list[PrioritizationOut]
    weights: dict[str, float]
    caveats: list[str]
    corpus_bgc_count: int
    mibig_reference_present: bool


class FlowNode(BaseModel):
    id: str
    label: str
    stage: str


class FlowLink(BaseModel):
    source: str
    target: str
    value: int


class TaxonomyClassFlow(BaseModel):
    """Sankey flows: phylum -> genus -> BGC class.

    `hybrid_double_counted` matters for honest reading: a hybrid BGC is
    counted under each component class in the final stage, so the last
    column's total exceeds `total_bgcs` by that amount. Reported rather
    than hidden — see api/flows.py for why that trade was made.
    """

    nodes: list[FlowNode]
    links: list[FlowLink]
    hybrid_double_counted: int
    unclassified_bgcs: int
    total_bgcs: int


class HeatmapCell(BaseModel):
    row_id: str
    column: str
    count: int
    per_genome: float | None = None


class PresenceHeatmap(BaseModel):
    """Clade x BGC-class presence/absence matrix (report section 4.9).

    Rows carry `genome_count` because a zero cell in a one-genome clade
    and a zero cell in a forty-genome clade are very different statements,
    and a bare grid hides that distinction entirely.
    """

    rows: list[dict]
    columns: list[str]
    cells: list[HeatmapCell]
    rank: str
    caveat: str
