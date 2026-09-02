"""Response shapes for the visualization API.

These model what the *frontend* needs to render, not the database schema
1:1 — e.g. `TaxonTreeNode.genome_count` is aggregated across every
descendant, which has no equivalent column anywhere in bgcscape.models.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel

from bgcscape.coverage import CoverageState
from bgcscape.models.base import EvidenceLevel
from bgcscape.models.bgc import BGCClass
from bgcscape.models.bgc_family import FamilyKind
from bgcscape.models.genome import AssemblyLevel
from bgcscape.models.placement import PlacementConfidence
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
    compounds: list[str] = []
    """Names of the compounds this cluster is recorded as producing.

    Carried in the tree payload so the interface can answer "where is
    kocurin made?" — a product name is how a researcher actually refers to
    a cluster, and searching only taxa and accessions made that question
    unanswerable. A list because MIBiG records multiple products for many
    clusters. Short strings, and the payload is gzipped; measured cost is a
    few KB over the wire."""


class GenomeSummary(BaseModel):
    id: uuid.UUID
    accession: str
    assembly_level: AssemblyLevel
    is_mag: bool | None
    """None means nobody has established whether this is a metagenome-assembled
    genome — not that it isn't one. No ingest path in this project has a
    verified source for the answer (see `Genome.is_mag`), so a client must not
    render None as "isolate genome"."""
    bgcs: list[BGCSummary]
    coverage: CoverageState = CoverageState.UNEXAMINED
    """Whether this genome has actually been examined for clusters.

    Without it, `len(bgcs) == 0` is two different facts wearing the same
    face: a genome antiSMASH surveyed and found nothing in, and a genome
    nobody has ever looked at. Only the first is a biological finding. A
    client MUST NOT render an unexamined genome's zero as a count — see
    `bgcscape.coverage` for the three states and what each licenses.

    Carried per genome in the tree payload rather than fetched per node: it
    is one short string, and the alternative is a request per genome at the
    moment the tree is being drawn."""
    # Carried in the tree payload so filtering on genome quality/size/GC
    # can happen without a request per genome. These are small scalars;
    # the payload cost is real but bounded, and Phase B's lazy
    # aggregation is what actually addresses payload size.
    genome_size_bp: int | None = None
    gc_content_pct: float | None = None
    completeness_pct: float | None = None
    contamination_pct: float | None = None
    """Carried alongside completeness because the two are read together:
    a 95%-complete bin at 12% contamination is not a good genome, and a
    filter offering only one half of the pair invites exactly that reading.
    Populated for 991 of 1,542 genomes in the shipped corpus."""


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
    examined_genome_count: int = 0
    """Of `genome_count`, how many a cluster-detection run has covered.

    The denominator for every claim about absence in this subtree. A clade
    showing zero clusters over 40 examined genomes is a finding; the same
    zero over 40 unexamined genomes is an empty database. Aggregated exactly
    like `genome_count` so the two are comparable at every node."""
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
    placement_confidence: PlacementConfidence | None = None
    """How much weight the match bears — see `PlacementConfidence`. `weak`
    means the cluster reached this genome by a free-text organism name or
    only to genus level. Exposed as its own field so a client can mark it
    without parsing prose, and so "which of these rest on weak matching?"
    is answerable in the interface as well as in SQL."""
    placement_caveat: str | None = None
    """What a reader must know before citing this placement. Always says,
    for a placed cluster, that it was characterized in an organism this
    genome represents and NOT sequenced from this assembly."""


class GenomeDetail(BaseModel):
    id: uuid.UUID
    accession: str
    assembly_level: AssemblyLevel
    is_mag: bool | None
    """See `GenomeSummary.is_mag`: None is "not established", not "no"."""
    taxon_name: str | None = None
    taxon_rank: TaxonRank | None = None
    genome_size_bp: int | None = None
    gc_content_pct: float | None = None
    completeness_pct: float | None = None
    contamination_pct: float | None = None
    bgcs: list[BGCSummary]
    coverage: CoverageState = CoverageState.UNEXAMINED
    """See `GenomeSummary.coverage`."""
    coverage_note: str = ""
    """Plain-language rendering of `coverage`, for direct display. States
    what this genome's cluster count does and does not license — including,
    where nothing has examined it, that the count is not a finding."""
    analysis_runs: list["AnalysisRunSummary"] = []
    """Every run that examined this genome, newest first. Empty means
    nobody has — which is exactly the fact `coverage` reports."""
    lineage: list["LineageStep"] = []
    """Full GTDB lineage, root-first. Assembled server-side because the
    tree payload only carries the genome's own taxon — walking ancestors
    client-side would need the whole taxon table."""


class AnalysisRunSummary(BaseModel):
    """One tool run, as much of it as a reader needs to judge its coverage."""

    id: uuid.UUID
    analysis_type: str
    tool: str
    tool_version: str
    label: str = ""
    completed_at: datetime | None = None
    parameters: dict | None = None
    evidence_level: EvidenceLevel
    """How the coverage claim itself was established. `computed` means
    Phylo-BGC derived it from the tool's own output as it was ingested;
    `hypothesized` means somebody declared the run without output for
    Phylo-BGC to read (`bgcscape record-analysis-run`). Both are useful;
    they are not equally strong, and pooling them would hide which."""
    genomes_covered: int = 0


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
    kind: FamilyKind = FamilyKind.SEQUENCE_FAMILY
    """Which sort of grouping this is — see `FamilyKind`.

    Carried on every reference because the two support different claims.
    Two clades sharing a SEQUENCE_FAMILY share gene content. Two clades
    sharing a COMPOUND_GROUP both make a named molecule, which says
    nothing about their clusters' sequences: convergent evolution routinely
    produces the same product from unrelated pathways. A client that renders
    both as "shared families" states the stronger claim about rows that
    only support the weaker one."""


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
    """Every grouping in this clade, of both kinds. Split below — a bare
    total is the number that invited the two to be read as one thing."""
    sequence_family_count: int = 0
    """Of `family_count`, those that are BiG-SCAPE/BiG-FAM sequence families."""
    compound_group_count: int = 0
    """Of `family_count`, those that are MIBiG compound groups."""
    only_in_this_clade: list[FamilyRef]
    """Families found in this clade and none of the others compared.

    Named `only_in_*`, not `absent_from_others`: this reflects what was
    *observed in this dataset*, and cannot distinguish true absence
    elsewhere from insufficient sampling. See `CladeComparison.caveats`.
    """


class CladeComparison(BaseModel):
    clades: list[CladeSummary]
    shared_families: list[FamilyRef]
    """Groupings present in every compared clade (not merely in several).

    Read each entry's `kind`. This list mixes sequence families and compound
    groups deliberately — both are real comparative findings — but they are
    not the same finding, and `caveats` says so."""
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
    """Every `bgc_family` row, of both kinds. Split below: pooling a
    sequence clustering and a compound grouping into one figure-caption
    number is what made them look like one thing."""
    sequence_family_count: int = 0
    compound_group_count: int = 0
    engine_version: str

    #: Which taxonomy the four counts above are over. `all` is the whole
    #: database; `prokaryote` / `eukaryote` restrict to one taxonomy, because
    #: the corpus holds two that must never be summed into one figure.
    scope: str = "all"

    #: The same three counts over the WHOLE database, regardless of `scope`.
    #:
    #: Carried alongside rather than fetched separately so a caller can say
    #: "1,971 of 2,437 clusters" from one request. When `scope` is `all` these
    #: are equal to the scoped counts by construction.
    corpus_genome_count: int
    corpus_bgc_count: int
    corpus_taxon_count: int

    #: How many genomes in this scope a cluster-detection run has covered,
    #: and how the rest break down. A figure caption that reports "1,542
    #: genomes, 2,437 clusters" without these is overstating its own basis:
    #: it implies a survey that may never have happened.
    examined_genome_count: int = 0
    curated_only_genome_count: int = 0
    unexamined_genome_count: int = 0
    coverage_note: str = ""
    """One sentence a caption can carry verbatim, stating what fraction of
    this corpus was actually examined and therefore what its absences mean."""


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


# GenomeDetail forward-references LineageStep and AnalysisRunSummary, both
# defined after it. Rebuilt here, once both exist.
GenomeDetail.model_rebuild()


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

class UploadedGenomeOut(BaseModel):
    """What became of one uploaded antiSMASH result file.

    `placement` is the field that matters and the one the UI leads with.
    Only "grafted" means the genome is visible in its real position on the
    tree; "species_only" means it has an organism but no GTDB genus matched
    (a fungus, an unrecognised name); "unplaced" means it is in the database
    but not on the tree at all, because `tree_builder` skips genomes with no
    taxon. Reporting a region count without this would tell the reader their
    upload worked while they stare at an unchanged tree.
    """

    filename: str
    accession: str
    genome_id: uuid.UUID | None = None
    regions_created: int = 0
    regions_updated: int = 0
    placement: Literal["grafted", "species_only", "unplaced"] = "unplaced"
    organism: str | None = None
    grafted_to: str | None = None
    errors: list[str] = []


class ClusteringOutcomeOut(BaseModel):
    """What became of an optional BiG-SCAPE clustering file.

    `family_ids` is the payload the tree actually uses: the families the
    uploaded genomes' own clusters landed in. Highlighting those is the only
    way to say "this same cluster occurs here too" — antiSMASH alone gives a
    biosynthetic class, and every other PKS in the corpus is a quarter of the
    tree rather than an answer.
    """

    filename: str
    cutoff: float | None = None
    memberships_created: int = 0
    memberships_updated: int = 0
    #: Rows naming a region this database does not hold — expected, since a
    #: real run mixes in MIBiG references and other genomes.
    unmatched_rows: int = 0
    family_ids: list[str] = []
    errors: list[str] = []


class AntismashUploadResponse(BaseModel):
    genomes: list[UploadedGenomeOut]
    total_regions: int
    #: Files that could not be read at all (not JSON, too large, empty).
    rejected: list[str] = []
    clustering: ClusteringOutcomeOut | None = None
