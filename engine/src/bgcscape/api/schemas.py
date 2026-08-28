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
from bgcscape.models.bgc_family import FamilyKind
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
    # Carried in the tree payload so filtering on genome quality/size/GC
    # can happen without a request per genome. These are small scalars;
    # the payload cost is real but bounded, and Phase B's lazy
    # aggregation is what actually addresses payload size.
    genome_size_bp: int | None = None
    gc_content_pct: float | None = None
    completeness_pct: float | None = None


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
    placement_method: str | None = None
    """How this cluster was put on the taxonomic tree, when it wasn't the
    source's own doing: `ncbi_taxid`, `ncbi_species_taxid` or `gtdb_species`
    for a MIBiG entry matched to a GTDB genome (see ingest/link.py). None
    when the cluster's genome came from the source directly, as with
    antiSMASH. Surfaced because an exact-taxid placement and a name match
    are different claims, and a reader should be able to tell them apart."""
    placement_note: str | None = None
    """Plain-language rendering of `placement_method`."""


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
    lineage: list["LineageStep"] = []
    """Full GTDB lineage, root-first. Assembled server-side because the
    tree payload only carries the genome's own taxon — walking ancestors
    client-side would need the whole taxon table."""


class SearchResult(BaseModel):
    kind: str  # "taxon" | "genome"
    id: uuid.UUID
    label: str
    rank: TaxonRank | None = None
    accession: str | None = None


class BGCClassVocabulary(BaseModel):
    """The two BGC-class vocabularies, and which endpoints use which.

    These differ, and the difference is real rather than a bug to paper
    over. `stored_classes` is what the `bgc.bgc_class` column actually
    holds, including the literal `hybrid`. `component_classes` is what a
    hybrid decomposes into (an `nrps+pks` cluster is NRPS machinery AND PKS
    machinery), and is the vocabulary every counting and filtering surface
    uses — the biologically meaningful reading, and the one the frontend's
    filter rail, donut and clade comparison all share.

    Consequence a consumer must know: counts over `component_classes` sum
    to MORE than the number of clusters, because a hybrid is counted under
    each component. `hybrid` never appears in those counts, so a legend
    built from `stored_classes` has a category that is always empty. That
    trap is why this endpoint states both lists instead of one.
    """

    stored_classes: list[str]
    """Raw `bgc.bgc_class` values present in the corpus. Includes `hybrid`."""
    component_classes: list[str]
    """Vocabulary used by /bgc-type-counts, /tree, /flows and the UI filters.
    Hybrids are decomposed into these; `hybrid` itself never appears."""
    counting_note: str


class SearchResponse(BaseModel):
    """Search hits plus enough context to interpret them.

    A bare list could not distinguish "20 matches" from "the first 20 of
    380", nor "no matches" from "your query was too short to run" — so a
    client had no way to tell a genuine zero from a search that never
    executed. Both are now explicit.
    """

    query: str
    results: list[SearchResult]
    total: int
    """Total matches in the database, before truncation to `limit`."""
    truncated: bool
    """True when `total` exceeds what was returned."""
    limit: int
    message: str | None = None
    """Set when the query could not be run at all (e.g. too short), so a
    zero-result response is never mistaken for a genuine no-match."""


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
    kind: FamilyKind
    """Sequence family (BiG-SCAPE GCF) or compound group. These are
    different scientific objects — see `FamilyKind`. A client must not
    present a compound group as evidence of sequence similarity."""
    kind_note: str
    """Plain-language rendering of `kind`, for direct display."""
    is_generic_product: bool = False
    """Compound groups only: the group's compound is a product *category*
    ("carotenoid", "capsular polysaccharide"), not a single molecule. Such
    a group means "both make some carotenoid", which is a much weaker
    statement than "both make the same compound" — and the four largest
    groups in the shipped corpus are exactly these. Flagged so the UI can
    say so rather than presenting them identically."""
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
    caveats: list[str] = []
    """Caveats specific to THIS cluster (its component coverage, its
    by-construction bias). Corpus-wide caveats live on the response's own
    `caveats` field; keeping them apart stops one row's coverage being
    asserted over every other row in the ranking."""


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


class LineageStep(BaseModel):
    rank: TaxonRank
    name: str


class BGCTypeCount(BaseModel):
    bgc_class: str
    count: int


class LazyTaxonNode(BaseModel):
    """One level of the tree, for incremental loading.

    The difference from `TaxonTreeNode` is what `children` means: here it
    is *this level only*, and `has_children` tells the client whether more
    exists below without shipping it. A client renders what it has and
    fetches deeper only where the user actually looks.
    """

    id: uuid.UUID | None
    name: str
    rank: TaxonRank | None
    genome_count: int
    bgc_class_counts: dict[str, int]
    has_children: bool
    child_taxon_count: int
    direct_genome_count: int
    children: list["LazyTaxonNode"] = []
    direct_genomes: list[GenomeSummary] = []
    """Populated only at the deepest requested level, and only when the
    genome count is small enough to be worth sending — see the endpoint."""


LazyTaxonNode.model_rebuild()


class LazyTreeResponse(BaseModel):
    root: LazyTaxonNode
    depth: int
    truncated_at: list[str]
    """Node names where expansion stopped because the requested depth ran
    out. Named so a client can show "expand" affordances precisely rather
    than guessing."""
    total_genomes: int
    total_bgcs: int
