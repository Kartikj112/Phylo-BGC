"""Phylo-BGC visualization API.

Read-only by design: this API exists to serve the tree/BGC-overlay
frontend, not as a general CRUD interface — writes go through
`bgcscape.ingest` (or, later, the CLI/a curator tool), not HTTP. Run with:

    uvicorn bgcscape.api.app:app --reload

Requires the `api` extra: `pip install -e ".[api]"`.
"""
from __future__ import annotations

import csv
import io
import json
import logging
import os
import uuid
from dataclasses import asdict
from collections.abc import Iterator
from typing import Annotated

from fastapi import Depends, FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import Response
from pydantic import ValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from bgcscape import __version__
from bgcscape.api.flows import build_taxonomy_class_flow
from bgcscape.api.security import (
    MaxBodySizeMiddleware,
    RateLimitMiddleware,
    SecurityHeadersMiddleware,
)
from bgcscape.api.backbone_tree import (
    DEFAULT_LIMIT as BACKBONE_DEFAULT_LIMIT,
    BackboneNodeNotFound,
    BackboneUnavailable,
    backbone_status,
    build_backbone_path,
    build_backbone_tree,
    search_backbone,
)
from bgcscape.api.lazy_tree import LazyTreeError, build_lazy_tree
from bgcscape.api.uploads import (
    get_or_create_upload_source,
    ingest_uploaded_antismash,
    ingest_uploaded_clustering,
)
from bgcscape.api.comparison import (
    all_family_labels,
    build_clade_profile,
    compute_caveats,
    partition_families,
)
from bgcscape.api.schemas import (
    AnalysisRunSummary,
    AntismashUploadResponse,
    BackboneSearchHit,
    BackboneStatus,
    BackboneTreeNode,
    ClusteringOutcomeOut,
    BGCDetail,
    BGCFamilyDetail,
    BGCFamilyMember,
    BGCFamilySummary,
    BGCClassVocabulary,
    BGCSummary,
    CladeComparison,
    CladeSummary,
    ClassProfileEntry,
    ComponentScoreOut,
    CompoundSummary,
    DatasetProvenanceResponse,
    ExportRequest,
    FamilyRef,
    FlowLink,
    FlowNode,
    GenomeDetail,
    BGCTypeCount,
    HeatmapCell,
    LazyTreeResponse,
    LineageStep,
    PresenceHeatmap,
    PrioritizationOut,
    PrioritizationResponse,
    SearchResponse,
    SearchResult,
    TaxonomyClassFlow,
    TaxonTreeNode,
    UploadedGenomeOut,
)
from bgcscape.api.tree_builder import (
    TreeScope,
    build_taxonomy_tree,
    taxon_ids_in_scope,
    component_classes,
    load_classified_bgc_rows,
)
from bgcscape.ingest.link import PLACEMENT_METHOD_LABELS, placement_of
from bgcscape.coverage import (
    ABSENCE_NOTES,
    absence_note,
    CoverageState,
    corpus_coverage_summary,
    coverage_state,
    examined_genome_ids,
    genomes_with_bgcs,
    runs_covering,
)
from bgcscape.config import get_settings
from bgcscape.db.session import get_sessionmaker
from bgcscape.export import (
    ConfigVersionError,
    PdfRendererUnavailable,
    SvgRenderError,
    ViewConfig,
    add_provenance_caption,
    embed_view_config,
    render_pdf,
)
from bgcscape.schemas.source import SourceRead
from bgcscape.scoring import (
    DEFAULT_WEIGHTS,
    NOT_A_NOVELTY_CLAIM,
    SCORE_IS_ORDINAL,
    WEIGHTS_ARE_UNCALIBRATED,
    corpus_caveats,
    rank_bgcs_with_context,
)
from bgcscape.ingest.compound_groups import is_generic_product
from bgcscape.models import (
    BGC,
    AnalysisRunCoverage,
    BGCCompoundLink,
    BGCFamily,
    BGCFamilyMembership,
    FamilyKind,
    Genome,
    Source,
    Taxon,
)
from bgcscape.models.taxonomy import TaxonRank

#: How each grouping kind should be described to a reader. Kept next to the
#: API rather than in the model so the wording is reviewable as UI copy.
FAMILY_KIND_NOTES = {
    FamilyKind.SEQUENCE_FAMILY: (
        "Gene cluster family: clusters grouped by sequence similarity "
        "(gene content and domain architecture)."
    ),
    FamilyKind.COMPOUND_GROUP: (
        "Compound group: clusters that MIBiG records as making the same named compound. "
        "A curated chemical fact — no sequences were compared."
    ),
}

#: Upper bound on `/api/v1/prioritization?limit`. The full corpus is a
#: legitimate request (the CLI ranks everything), so this is generous — it
#: exists to stop an unbounded slice, not to gatekeep.
MAX_PRIORITIZATION_LIMIT = 100_000

app = FastAPI(
    title="Phylo-BGC API",
    description=(
        "Read-only API over the Phylo-BGC engine's data model, serving the "
        "taxonomy tree / BGC-overlay visualization."
    ),
    version="0.1.0",
)

# Origins are read from BGCSCAPE_CORS_ALLOW_ORIGINS (comma-separated) so a
# deployment can lock the API to its own frontend without a code change;
# the default stays "*" for local dev, matching prior behaviour. Set e.g.
# BGCSCAPE_CORS_ALLOW_ORIGINS=https://your-app.vercel.app in production.
#
# allow_methods must include POST for /api/v1/export, and OPTIONS for the
# browser preflight that precedes any POST carrying a JSON content-type.
# This was ["GET"] until the export endpoint shipped, which made SVG/PDF
# download fail in the browser with a 400 on OPTIONS while every
# server-side test passed — FastAPI's TestClient never issues preflight
# requests, so 24 API tests covered the endpoint without covering the way
# a browser actually reaches it. See test_export_endpoint_allows_browser_preflight.
_cors_origins = [
    o.strip() for o in os.getenv("BGCSCAPE_CORS_ALLOW_ORIGINS", "*").split(",") if o.strip()
] or ["*"]

# Worth being precise about what this does and does not buy, because it is
# easy to file "CORS is locked down" under security and stop there.
#
# CORS is a browser policy. It stops OTHER PAGES reading this API's responses
# in a visitor's browser; it does not stop anyone calling the API. Every route
# here is unauthenticated and carries no cookie, so a script, a curl or a
# server-side request reaches the write endpoint whether or not an origin is
# allow-listed — there is no credential for a cross-origin page to abuse. The
# thing that actually limits abuse of the upload route is the rate limiter and
# the size caps below, plus BGCSCAPE_ALLOW_UPLOADS=0 on a read-only deployment.
#
# Setting an explicit origin is still worth doing (it keeps the API off other
# people's pages, and narrows what a future authenticated route would expose),
# so a production deployment left wide open says so at startup rather than
# looking deliberate.
if "*" in _cors_origins and get_settings().environment == "production":
    logging.getLogger("bgcscape.api").warning(
        "BGCSCAPE_CORS_ALLOW_ORIGINS is unset in production, so any origin may read this "
        "API from a browser. Set it to the frontend's URL. Note this is not what protects "
        "the upload route — see BGCSCAPE_ALLOW_UPLOADS and the rate limit."
    )

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

# The tree payload is deeply repetitive JSON — enum values, uuid strings and
# the same key names a few thousand times over — which is close to the best
# case for deflate: 1.10 MB compresses to 0.24 MB, a 4.6x reduction measured
# on the shipped corpus. Nothing about the response changes; browsers and
# curl negotiate it with Accept-Encoding, and a client that does not ask
# still gets plain JSON.
#
# Ordering matters: GZipMiddleware is added AFTER CORSMiddleware, so it sits
# inside it and the CORS headers are applied to the compressed response
# rather than being compressed themselves.
#
# minimum_size skips the small responses (health, bgc-classes) where the
# gzip header would cost more than it saves.
app.add_middleware(GZipMiddleware, minimum_size=1024)

# Ordering note: Starlette applies middleware in reverse registration order,
# so these run BEFORE gzip and CORS on the way in — which is what we want.
# A body over the ceiling is refused without being read, and a rate-limited
# caller is turned away without any work being done for them.
app.add_middleware(SecurityHeadersMiddleware)
app.add_middleware(RateLimitMiddleware)
app.add_middleware(MaxBodySizeMiddleware)


def get_session() -> Iterator[Session]:
    session = get_sessionmaker()()
    try:
        yield session
    finally:
        session.close()


@app.get("/robots.txt", include_in_schema=False)
def robots() -> Response:
    """Keep the API out of search results.

    The API is on a different origin from the site, so the frontend's
    robots.txt cannot speak for it. Nothing here is secret — it is the same
    public data the explorer draws — but the JSON endpoints are not pages,
    and indexing them puts raw payloads in front of readers looking for the
    tool. The frontend stays fully crawlable.
    """
    return Response("User-agent: *\nDisallow: /\n", media_type="text/plain")


@app.get("/api/v1/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/v1/taxonomy-tree", response_model=TaxonTreeNode)
def get_taxonomy_tree(
    scope: TreeScope = "all",
    session: Session = Depends(get_session),
) -> TaxonTreeNode:
    """The aggregated taxonomy tree.

    `scope` selects which taxonomy: `prokaryote` is the GTDB backbone,
    `eukaryote` is the NCBI lineage for the fungi and plants GTDB cannot
    represent, `all` is both. They are served separately because GTDB and
    NCBI are different methodologies that disagree — a merged tree would be a
    hybrid the reader could not pick apart. See tree_builder.TreeScope.
    """
    return build_taxonomy_tree(session, scope=scope)


@app.get("/api/v1/tree", response_model=LazyTreeResponse)
def get_lazy_tree(
    root: uuid.UUID | None = None,
    depth: int = 2,
    session: Session = Depends(get_session),
) -> LazyTreeResponse:
    """One level of the tree at a time, for incremental loading.

    `/taxonomy-tree` ships the whole hierarchy and is retained for the
    existing client and for export, where a complete figure is the point.
    This endpoint is what survives a real GTDB release: fetch the root,
    render it, and request subtrees only where the user expands.
    """
    try:
        return build_lazy_tree(session, root_id=root, depth=depth)
    except LazyTreeError as exc:
        detail = str(exc)
        raise HTTPException(status_code=404 if "not found" in detail else 422, detail=detail) from exc


@app.get("/api/v1/backbone/status", response_model=BackboneStatus)
def get_backbone_status(
    scope: TreeScope = "prokaryote",
    session: Session = Depends(get_session),
) -> BackboneStatus:
    """Whether the whole-taxonomy backbone is loaded for `scope`.

    The interface asks this before offering "show all genomes": the backbone
    is an optional load, and a toggle that fails when pressed is worse than
    one that is not there.
    """
    return backbone_status(session, scope)


@app.get("/api/v1/backbone/tree", response_model=BackboneTreeNode)
def get_backbone_tree(
    scope: TreeScope = "prokaryote",
    parent: uuid.UUID | None = None,
    depth: int = 1,
    limit: int = BACKBONE_DEFAULT_LIMIT,
    session: Session = Depends(get_session),
) -> BackboneTreeNode:
    """The reference taxonomy, one clade at a time, with the corpus over it.

    Without `parent`, the root and `depth` levels below it; with it, that
    backbone node (its `backbone_id`) and `depth` levels below. Corpus
    fields keep their `/taxonomy-tree` meaning; `reference_*` fields count
    the reference release, none of whose genomes has been examined. See
    api/backbone_tree.py.
    """
    try:
        return build_backbone_tree(session, scope, parent=parent, depth=depth, limit=limit)
    except BackboneUnavailable as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except BackboneNodeNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.get("/api/v1/backbone/search", response_model=list[BackboneSearchHit])
def get_backbone_search(
    q: str,
    scope: TreeScope = "prokaryote",
    limit: int = 10,
    session: Session = Depends(get_session),
) -> list[BackboneSearchHit]:
    """Clades of the reference taxonomy whose name matches `q`.

    The corpus tree is searched in the browser, which holds all of it. The
    backbone is a quarter of a million clades loaded a level at a time, so
    the browser cannot search what it has not loaded; this can. Fewer than
    two characters match nothing rather than everything.
    """
    try:
        return search_backbone(session, scope, q, limit=limit)
    except BackboneUnavailable as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.get("/api/v1/backbone/path", response_model=BackboneTreeNode)
def get_backbone_path(
    node: uuid.UUID,
    scope: TreeScope = "prokaryote",
    limit: int = BACKBONE_DEFAULT_LIMIT,
    session: Session = Depends(get_session),
) -> BackboneTreeNode:
    """The backbone from the root, with every clade down to `node` opened.

    What a search result is opened with: one request, where opening each
    rank in turn would be seven.
    """
    try:
        return build_backbone_path(session, scope, node, limit=limit)
    except BackboneUnavailable as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except BackboneNodeNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.get("/api/v1/bgc-classes", response_model=BGCClassVocabulary)
def get_bgc_classes(session: Session = Depends(get_session)) -> BGCClassVocabulary:
    """Both BGC-class vocabularies — see `BGCClassVocabulary`.

    This used to return a single flat list of stored classes, which
    included `hybrid`. Every counting endpoint decomposes hybrids into
    their components, so `hybrid` was advertised as a class that no count
    would ever populate: a legend built from this endpoint carried a
    permanently empty category. Returning both lists, and naming the
    convention, is what makes the two answerable apart.
    """
    rows = session.query(BGC.bgc_class, BGC.subtype).distinct().all()
    stored = sorted({row[0].value for row in rows})
    component: set[str] = set()
    for bgc_class, subtype in rows:
        if bgc_class.value == "hybrid" and subtype:
            component.update(subtype.split("+"))
        else:
            component.add(bgc_class.value)
    return BGCClassVocabulary(
        stored_classes=stored,
        component_classes=sorted(component),
        counting_note=(
            "Counts from /bgc-type-counts, /tree and /flows/taxonomy-class use "
            "component_classes: a hybrid cluster is counted under EACH of its component "
            "classes, so those counts sum to more than the number of clusters. "
            "/taxonomy-tree instead counts each cluster once under its stored class, "
            "including 'hybrid'. Neither is wrong; they answer different questions, and a "
            "consumer must not compare totals across the two conventions."
        ),
    )


@app.get("/api/v1/genomes/{genome_id}", response_model=GenomeDetail)
def get_genome(genome_id: uuid.UUID, session: Session = Depends(get_session)) -> GenomeDetail:
    genome = (
        session.query(Genome)
        .options(
            selectinload(Genome.bgcs).selectinload(BGC.family_memberships),
            selectinload(Genome.taxon),
        )
        .filter_by(id=genome_id)
        .one_or_none()
    )
    if genome is None:
        raise HTTPException(status_code=404, detail=f"Genome {genome_id} not found")

    lineage: list[LineageStep] = []
    if genome.taxon is not None:
        taxa = {t.id: t for t in session.query(Taxon).all()}
        current = genome.taxon
        seen: set = set()
        while current is not None and current.id not in seen:
            seen.add(current.id)  # guards against a cyclic parent chain
            lineage.append(LineageStep(rank=current.rank, name=current.name))
            current = taxa.get(current.parent_id) if current.parent_id else None
        lineage.reverse()  # root-first, the order a breadcrumb reads

    # The three-way state, not a boolean: "no clusters recorded" and "no
    # cluster-detection run has covered this genome" are different facts and
    # a reader needs to be told which one they are looking at.
    state = coverage_state(
        genome.id, examined_genome_ids(session), genomes_with_bgcs(session)
    )
    runs = runs_covering(session, genome.id)
    coverage_counts = {
        run_id: n
        for run_id, n in session.query(
            AnalysisRunCoverage.analysis_run_id, func.count(AnalysisRunCoverage.id)
        )
        .filter(AnalysisRunCoverage.analysis_run_id.in_([r.id for r in runs]))
        .group_by(AnalysisRunCoverage.analysis_run_id)
    } if runs else {}

    return GenomeDetail(
        id=genome.id,
        accession=genome.accession,
        assembly_level=genome.assembly_level,
        is_mag=genome.is_mag,
        taxon_name=genome.taxon.name if genome.taxon else None,
        taxon_rank=genome.taxon.rank if genome.taxon else None,
        genome_size_bp=genome.genome_size_bp,
        gc_content_pct=genome.gc_content_pct,
        completeness_pct=genome.completeness_pct,
        contamination_pct=genome.contamination_pct,
        bgcs=[
            BGCSummary(
                id=b.id,
                bgc_class=b.bgc_class,
                subtype=b.subtype,
                mibig_accession=b.mibig_accession,
                evidence_level=b.evidence_level,
                family_ids=[m.family_id for m in b.family_memberships],
            )
            for b in genome.bgcs
        ],
        coverage=state,
        coverage_note=absence_note(session, genome.id, state),
        analysis_runs=[
            AnalysisRunSummary(
                id=run.id,
                analysis_type=run.analysis_type.value,
                tool=run.tool,
                tool_version=run.tool_version,
                label=run.label,
                completed_at=run.completed_at,
                parameters=run.parameters,
                evidence_level=run.evidence_level,
                genomes_covered=coverage_counts.get(run.id, 0),
            )
            for run in runs
        ],
        lineage=lineage,
    )


@app.get("/api/v1/bgcs/{bgc_id}", response_model=BGCDetail)
def get_bgc(bgc_id: uuid.UUID, session: Session = Depends(get_session)) -> BGCDetail:
    bgc = (
        session.query(BGC)
        .options(
            selectinload(BGC.genome),
            selectinload(BGC.compound_links).selectinload(BGCCompoundLink.compound),
        )
        .filter_by(id=bgc_id)
        .one_or_none()
    )
    if bgc is None:
        raise HTTPException(status_code=404, detail=f"BGC {bgc_id} not found")

    placement = placement_of(bgc)
    placement_method = placement.get("method") if placement else None
    # Present only from the `bgc_organism_placement` table; a database
    # migrated but not yet re-linked falls back to the raw_annotation JSON,
    # which never carried these. None therefore means "not recorded", never
    # "strong" — the same missing-evidence discipline the scorer applies.
    placement_confidence = placement.get("confidence") if placement else None
    placement_caveat = placement.get("caveat") if placement else None

    return BGCDetail(
        id=bgc.id,
        genome_id=bgc.genome_id,
        genome_accession=bgc.genome.accession,
        contig=bgc.contig,
        start_coord=bgc.start_coord,
        end_coord=bgc.end_coord,
        bgc_class=bgc.bgc_class,
        subtype=bgc.subtype,
        predicted_by_tool=bgc.predicted_by_tool,
        mibig_accession=bgc.mibig_accession,
        evidence_level=bgc.evidence_level,
        compounds=[
            CompoundSummary(
                id=link.compound.id,
                name=link.compound.name,
                chemical_formula=link.compound.chemical_formula,
                compound_class=link.compound.compound_class,
            )
            for link in bgc.compound_links
        ],
        placement_method=placement_method,
        placement_note=PLACEMENT_METHOD_LABELS.get(placement_method) if placement_method else None,
        placement_confidence=placement_confidence,
        placement_caveat=placement_caveat,
    )


@app.get("/api/v1/families", response_model=list[BGCFamilySummary])
def list_families(session: Session = Depends(get_session)) -> list[BGCFamilySummary]:
    """All Gene Cluster Families, most-members-first — the ordering that
    puts the widely-distributed families a user most likely wants to look
    at (and the strongest horizontal-transfer candidates) at the top."""
    families = (
        session.query(BGCFamily)
        .options(
            selectinload(BGCFamily.memberships)
            .selectinload(BGCFamilyMembership.bgc)
            .selectinload(BGC.genome)
            .selectinload(Genome.taxon)
        )
        .all()
    )
    summaries = [_family_summary(f) for f in families]
    summaries.sort(key=lambda f: (-f.member_count, f.label))
    return summaries


def _family_summary(family: BGCFamily) -> BGCFamilySummary:
    bgc_classes: set[str] = set()
    taxon_names: set[str] = set()
    for membership in family.memberships:
        bgc = membership.bgc
        bgc_classes.add(bgc.bgc_class.value)
        taxon = bgc.genome.taxon if bgc.genome else None
        if taxon is not None:
            taxon_names.add(taxon.name)

    return BGCFamilySummary(
        id=family.id,
        label=family.label,
        kind=family.kind,
        kind_note=FAMILY_KIND_NOTES[family.kind],
        is_generic_product=(
            family.kind == FamilyKind.COMPOUND_GROUP and is_generic_product(family.label)
        ),
        clustering_method=family.clustering_method,
        clustering_cutoff=family.clustering_cutoff,
        member_count=len(family.memberships),
        bgc_classes=sorted(bgc_classes),
        taxon_names=sorted(taxon_names),
        evidence_level=family.evidence_level,
    )


@app.get("/api/v1/families/{family_id}", response_model=BGCFamilyDetail)
def get_family(family_id: uuid.UUID, session: Session = Depends(get_session)) -> BGCFamilyDetail:
    family = (
        session.query(BGCFamily)
        .options(
            selectinload(BGCFamily.memberships)
            .selectinload(BGCFamilyMembership.bgc)
            .selectinload(BGC.genome)
            .selectinload(Genome.taxon)
        )
        .filter_by(id=family_id)
        .one_or_none()
    )
    if family is None:
        raise HTTPException(status_code=404, detail=f"BGC family {family_id} not found")

    summary = _family_summary(family)
    members = [
        BGCFamilyMember(
            bgc_id=m.bgc.id,
            bgc_class=m.bgc.bgc_class,
            subtype=m.bgc.subtype,
            genome_id=m.bgc.genome.id,
            genome_accession=m.bgc.genome.accession,
            taxon_name=m.bgc.genome.taxon.name if m.bgc.genome.taxon else None,
            evidence_level=m.bgc.evidence_level,
            similarity_score=m.similarity_score,
        )
        for m in family.memberships
    ]
    members.sort(key=lambda m: (m.taxon_name or "", m.genome_accession))
    return BGCFamilyDetail(**summary.model_dump(), members=members)


@app.get("/api/v1/compare", response_model=CladeComparison)
def compare_clades(
    taxon_ids: Annotated[list[uuid.UUID], Query(description="Two or more taxon ids to compare.")],
    session: Session = Depends(get_session),
) -> CladeComparison:
    """Compare the biosynthetic repertoires of two or more clades.

    Read the `comparable` flag and `caveats` before drawing conclusions —
    see api/comparison.py for why they're part of the response rather than
    a UI afterthought.
    """
    unique_ids = list(dict.fromkeys(taxon_ids))  # de-dupe, preserve order
    if len(unique_ids) < 2:
        raise HTTPException(status_code=422, detail="Comparison needs at least two distinct taxon ids")
    if len(unique_ids) > 6:
        raise HTTPException(
            status_code=422,
            detail="Comparing more than 6 clades at once produces a table too wide to read; narrow the selection",
        )

    taxa = []
    for taxon_id in unique_ids:
        taxon = session.get(Taxon, taxon_id)
        if taxon is None:
            raise HTTPException(status_code=404, detail=f"Taxon {taxon_id} not found")
        taxa.append(taxon)

    profiles = [build_clade_profile(session, taxon) for taxon in taxa]
    comparable, caveats = compute_caveats(profiles)
    shared_ids, only_in = partition_families(profiles)

    # (label, kind) per family id. The kind travels with the label because a
    # reference rendered without it cannot be told apart from a sequence
    # family — see FamilyRef.kind.
    labels: dict[uuid.UUID, tuple[str, FamilyKind]] = {}
    for profile in profiles:
        for fid, label in profile.family_labels.items():
            labels[fid] = (label, profile.family_kinds.get(fid, FamilyKind.SEQUENCE_FAMILY))
    missing = (set(shared_ids) | {fid for ids in only_in.values() for fid in ids}) - labels.keys()
    labels.update(all_family_labels(session, missing))

    def family_refs(ids: list[uuid.UUID]) -> list[FamilyRef]:
        refs = [
            FamilyRef(
                id=fid,
                label=labels.get(fid, ("(unlabelled)", FamilyKind.SEQUENCE_FAMILY))[0],
                kind=labels.get(fid, ("(unlabelled)", FamilyKind.SEQUENCE_FAMILY))[1],
            )
            for fid in ids
        ]
        refs.sort(key=lambda r: r.label)
        return refs

    clades = []
    for profile in profiles:
        class_profile = [
            ClassProfileEntry(
                bgc_class=bgc_class,
                count=count,
                per_genome=profile.class_rate(bgc_class),
            )
            for bgc_class, count in sorted(profile.bgc_class_counts.items())
        ]
        clades.append(
            CladeSummary(
                taxon_id=profile.taxon.id,
                taxon_name=profile.taxon.name,
                rank=profile.taxon.rank,
                genome_count=profile.genome_count,
                bgc_count=profile.bgc_count,
                bgcs_per_genome=profile.bgcs_per_genome,
                class_profile=class_profile,
                family_count=len(profile.family_ids),
                sequence_family_count=len(profile.ids_of_kind(FamilyKind.SEQUENCE_FAMILY)),
                compound_group_count=len(profile.ids_of_kind(FamilyKind.COMPOUND_GROUP)),
                only_in_this_clade=family_refs(only_in.get(profile.taxon.id, [])),
            )
        )

    return CladeComparison(
        clades=clades,
        shared_families=family_refs(shared_ids),
        comparable=comparable,
        caveats=caveats,
    )


@app.get("/api/v1/prioritization", response_model=PrioritizationResponse)
def get_prioritization(
    # Bounded deliberately. `limit` used to be passed straight to a list
    # slice, so limit=0 returned the WHOLE corpus (a 2.5 MB payload where
    # the default is 21 KB) and limit=-1 returned everything-but-the-last
    # row. ge=1 makes both impossible; le caps the payload.
    limit: int = Query(20, ge=1, le=MAX_PRIORITIZATION_LIMIT),
    session: Session = Depends(get_session),
) -> PrioritizationResponse:
    """Rank BGCs as candidates for follow-up.

    This is a prioritization hint, not a novelty measurement — see
    bgcscape/scoring/prioritization.py. The response's `caveats` are part
    of the contract, not garnish.
    """
    ranked, ctx = rank_bgcs_with_context(session, limit=limit)
    ctx_bgcs = session.query(BGC).count()
    mibig_present = session.query(BGC).filter(BGC.mibig_accession.isnot(None)).count() > 0

    bgc_ids = [r.bgc_id for r in ranked]
    bgcs = {
        b.id: b
        for b in session.query(BGC)
        .options(selectinload(BGC.genome).selectinload(Genome.taxon))
        .filter(BGC.id.in_(bgc_ids))
        .all()
    } if bgc_ids else {}

    results = []
    for entry in ranked:
        bgc = bgcs.get(entry.bgc_id)
        if bgc is None:
            continue
        results.append(
            PrioritizationOut(
                bgc_id=entry.bgc_id,
                genome_accession=bgc.genome.accession,
                taxon_name=bgc.genome.taxon.name if bgc.genome.taxon else None,
                bgc_class=bgc.bgc_class,
                score=entry.score,
                components=[
                    ComponentScoreOut(
                        name=c.name, value=c.value, available=c.available, explanation=c.explanation
                    )
                    for c in entry.components
                ],
                unavailable_components=entry.unavailable_components,
                # This row's own caveats — its component coverage, its
                # by-construction bias. Previously the top row's were
                # hoisted to the corpus level, where they stated something
                # false about every row scored on a different component set
                # (1,178 of 2,437 on the shipped corpus).
                caveats=entry.specific_caveats,
            )
        )

    shared_caveats = corpus_caveats(ctx)
    return PrioritizationResponse(
        results=results,
        weights=DEFAULT_WEIGHTS,
        caveats=shared_caveats,
        corpus_bgc_count=ctx_bgcs,
        mibig_reference_present=mibig_present,
    )


@app.get("/api/v1/flows/taxonomy-class", response_model=TaxonomyClassFlow)
def get_taxonomy_class_flow(
    scope: TreeScope = "all",
    session: Session = Depends(get_session),
) -> TaxonomyClassFlow:
    """Sankey flows from phylum through genus to BGC class.

    `scope` selects the taxonomy — see the heatmap below for why a merged
    view would be misleading.
    """
    return TaxonomyClassFlow(**build_taxonomy_class_flow(session, scope=scope))


@app.get("/api/v1/heatmap", response_model=PresenceHeatmap)
def get_presence_heatmap(
    rank: str = "genus",
    scope: TreeScope = "all",
    session: Session = Depends(get_session),
) -> PresenceHeatmap:
    """Clade x BGC-class matrix (report section 4.9).

    `scope` selects the taxonomy, for the same reason the tree does: GTDB and
    NCBI ranks are not comparable, so a merged matrix would list *Aspergillus*
    (fungal, NCBI) and *Streptomyces* (bacterial, GTDB) as peer rows.
    """
    try:
        target_rank = TaxonRank(rank)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=f"Unknown rank: {rank}") from exc

    # Scalar columns only: the previous `selectinload(Genome.bgcs)` hydrated
    # full BGC objects, decoding every `raw_annotation` blob to build a
    # matrix of integers.
    taxa = {
        tid: (parent_id, name, rank)
        for tid, parent_id, name, rank in session.query(
            Taxon.id, Taxon.parent_id, Taxon.name, Taxon.rank
        )
    }

    ancestor_cache: dict[uuid.UUID, tuple[uuid.UUID, str] | None] = {}

    def ancestor_at(taxon_id):
        """Nearest ancestor at `target_rank`, memoised.

        Genomes in the same clade share almost all of their ancestor walk,
        so caching turns a per-genome climb into one climb per taxon.
        """
        if taxon_id in ancestor_cache:
            return ancestor_cache[taxon_id]
        chain: list[uuid.UUID] = []
        current = taxon_id
        found: tuple[uuid.UUID, str] | None = None
        seen: set = set()
        while current is not None and current in taxa and current not in seen:
            seen.add(current)
            chain.append(current)
            if current in ancestor_cache:
                found = ancestor_cache[current]
                break
            parent_id, name, rank = taxa[current]
            if rank == target_rank:
                found = (current, name)
                break
            current = parent_id
        for node in chain:
            ancestor_cache[node] = found
        return found

    in_scope = taxon_ids_in_scope(session, scope)

    counts: dict[str, dict[str, int]] = {}
    genome_counts: dict[str, int] = {}
    row_names: dict[str, str] = {}
    classes: set[str] = set()

    # Genome counts come from a separate pass over ALL classified genomes,
    # not from the BGC join. A genome carrying no BGCs still belongs to its
    # clade and still counts in the denominator of every per-genome rate —
    # counting only genomes that appear in the BGC join would quietly
    # inflate those rates (54 of 1,739 genomes on the shipped corpus have
    # no BGC).
    for taxon_id, genome_total in (
        session.query(Genome.taxon_id, func.count(Genome.id))
        .filter(Genome.taxon_id.isnot(None))
        .group_by(Genome.taxon_id)
    ):
        if in_scope is not None and taxon_id not in in_scope:
            continue
        clade = ancestor_at(taxon_id)
        if clade is None:
            continue
        clade_id, clade_name = clade
        key = str(clade_id)
        row_names[key] = clade_name
        genome_counts[key] = genome_counts.get(key, 0) + genome_total

    for _genome_id, taxon_id, bgc_class, subtype in load_classified_bgc_rows(session):
        if in_scope is not None and taxon_id not in in_scope:
            continue
        clade = ancestor_at(taxon_id)
        if clade is None:
            continue
        key = str(clade[0])
        bucket = counts.setdefault(key, {})
        for component in component_classes(bgc_class, subtype):
            classes.add(component)
            bucket[component] = bucket.get(component, 0) + 1

    ordered_columns = sorted(classes)
    rows = [
        {"id": key, "label": row_names[key], "genome_count": genome_counts[key]}
        # Explicit tiebreaker on label. The previous key was
        # `-genome_counts[k]` alone, so clades with equal genome counts came
        # out in whatever order the database happened to return their
        # genomes — stable within one build, but not across dialects or
        # after an unrelated ingest. Ordering a figure's rows should not
        # depend on that.
        for key in sorted(row_names, key=lambda k: (-genome_counts[k], row_names[k]))
    ]
    cells = [
        HeatmapCell(
            row_id=row["id"],
            column=column,
            count=counts.get(row["id"], {}).get(column, 0),
            per_genome=(
                counts.get(row["id"], {}).get(column, 0) / row["genome_count"]
                if row["genome_count"]
                else None
            ),
        )
        for row in rows
        for column in ordered_columns
    ]

    return PresenceHeatmap(
        rows=rows,
        columns=ordered_columns,
        cells=cells,
        rank=target_rank.value,
        caveat=(
            "An empty cell means no genome in this dataset was found to carry that class in this "
            "clade — not that the clade lacks it. Compare per-genome rates rather than raw counts, "
            "and note each row's genome count: a zero in a 1-genome clade says far less than a zero "
            "in a 40-genome clade."
        ),
    )


@app.get("/api/v1/bgc-type-counts", response_model=list[BGCTypeCount])
def get_bgc_type_counts(
    scope: TreeScope = "all",
    session: Session = Depends(get_session),
) -> list[BGCTypeCount]:
    """BGC class distribution for one taxonomy, for the summary strip and donut.

    Hybrids are attributed to each component class, matching every other
    count in the app (filter rail, comparison, heatmap, flows) — a donut
    disagreeing with the sidebar beside it would be worse than no donut.

    `scope` exists for exactly that reason. Without it this endpoint answered
    corpus-wide however the interface was scoped, so the eukaryote view's
    summary strip reported the prokaryotes' clusters too: PKS 1010 above a
    tree holding 251, beside a filter rail — computed from the tree — saying
    251. Two numbers for one class on one screen, and the larger one wired to
    the filter.
    """
    # GROUP BY in the database, then expand hybrids in Python. The previous
    # version loaded every BGC as a mapped object — decoding each
    # `raw_annotation` blob — to produce seven integers. The distinct
    # (class, subtype) pairs number in the dozens, not the thousands.
    query = session.query(BGC.bgc_class, BGC.subtype, func.count(BGC.id))
    query = _restrict_bgcs_to_scope(session, query, scope)
    counts: dict[str, int] = {}
    for bgc_class, subtype, n in query.group_by(BGC.bgc_class, BGC.subtype):
        for component in component_classes(bgc_class, subtype):
            counts[component] = counts.get(component, 0) + n
    return [
        BGCTypeCount(bgc_class=k, count=v) for k, v in sorted(counts.items(), key=lambda kv: -kv[1])
    ]


def _restrict_bgcs_to_scope(session: Session, query, scope: TreeScope):
    """Narrow a BGC query to the genomes of one taxonomy.

    A BGC reaches its taxonomy only through its genome, so the restriction is
    a two-hop subquery rather than a column filter. `taxon_ids_in_scope`
    returns None for `all`, which means "no restriction" — not "no taxa".
    """
    taxon_ids = taxon_ids_in_scope(session, scope)
    if taxon_ids is None:
        return query
    return query.filter(
        BGC.genome_id.in_(
            select(Genome.id).where(Genome.taxon_id.in_(taxon_ids))
        )
    )


@app.get("/api/v1/provenance", response_model=DatasetProvenanceResponse)
def get_provenance(
    scope: TreeScope = "all",
    session: Session = Depends(get_session),
) -> DatasetProvenanceResponse:
    """What this database contains — for figure captions, ViewConfig.dataset,
    and the interface's summary bar.

    `scope` defaults to `all`, so the export path (which describes the whole
    database deliberately) is unchanged. The summary bar passes the taxonomy
    on screen instead: it used to report `COUNT(*) FROM bgc` whichever tab was
    open, so the eukaryote view claimed 2,437 clusters over a tree holding
    466 — a 5.2x overstatement that no interaction could correct, because the
    number never depended on the tab in the first place.

    The corpus-wide totals ride along so a caller can render "N of M" without
    a second round trip.
    """
    corpus_genomes = session.query(Genome).count()
    corpus_bgcs = session.query(BGC).count()
    corpus_taxa = session.query(Taxon).count()
    # Genomes no tree can show, because `genomes_by_taxon` keys on taxon_id.
    # Counted here so the figure's own provenance record states the gap
    # rather than leaving a reader to discover that two endpoints disagree.
    unplaced_genomes = session.query(Genome).filter(Genome.taxon_id.is_(None)).count()

    # Corpus-wide, not scoped: coverage is a property of the whole database,
    # and reporting it per taxonomy tab would invite "this half was
    # examined" readings of a number that never depended on the tab.
    coverage = corpus_coverage_summary(session)

    taxon_ids = taxon_ids_in_scope(session, scope)
    if taxon_ids is None:
        genome_count, bgc_count, taxon_count = corpus_genomes, corpus_bgcs, corpus_taxa
    else:
        genome_count = session.query(Genome).filter(Genome.taxon_id.in_(taxon_ids)).count()
        bgc_count = _restrict_bgcs_to_scope(session, session.query(BGC), scope).count()
        taxon_count = len(taxon_ids)

    return DatasetProvenanceResponse(
        sources=[SourceRead.model_validate(s) for s in session.query(Source).order_by(Source.name).all()],
        genome_count=genome_count,
        bgc_count=bgc_count,
        taxon_count=taxon_count,
        # Families are not taxon-scoped: a family is defined across the whole
        # corpus by construction, and slicing it per taxonomy would report a
        # different number for the same family depending on the open tab.
        family_count=session.query(BGCFamily).count(),
        sequence_family_count=session.query(BGCFamily)
        .filter(BGCFamily.kind == FamilyKind.SEQUENCE_FAMILY)
        .count(),
        compound_group_count=session.query(BGCFamily)
        .filter(BGCFamily.kind == FamilyKind.COMPOUND_GROUP)
        .count(),
        engine_version=__version__,
        scope=scope,
        corpus_genome_count=corpus_genomes,
        corpus_bgc_count=corpus_bgcs,
        corpus_taxon_count=corpus_taxa,
        examined_genome_count=coverage["examined"],
        curated_only_genome_count=coverage["curated_only"],
        unexamined_genome_count=coverage["unexamined"],
        unplaced_genome_count=unplaced_genomes,
        placed_genome_count=corpus_genomes - unplaced_genomes,
        coverage_note=_coverage_note(coverage, corpus_genomes, unplaced_genomes),
    )


def _coverage_note(coverage: dict[str, int], total: int, unplaced: int = 0) -> str:
    """One sentence a figure caption can carry verbatim.

    Phrased differently at zero coverage on purpose. "0 of 1,542 genomes
    examined" is technically complete and reads as a rounding error; the
    fact it is stating is that NOTHING in the figure's absences is a
    finding, and that deserves a sentence rather than a fraction.
    """
    examined = coverage["examined"]
    if total == 0:
        return "This database holds no genomes."

    # Stated whenever it is non-zero, because the count above is over the
    # database and the tree beside it is over the placed genomes only. A
    # reader comparing the two without this sentence finds a discrepancy and
    # no explanation, in the one record that is supposed to make the figure
    # checkable.
    placement = ""
    if unplaced:
        placement = (
            f" {unplaced} of these {total} genomes carry no taxon and therefore appear on no "
            f"tree, so a tree drawn from this database shows {total - unplaced}."
        )

    if examined == 0:
        return (
            f"No cluster-detection run has covered any of these {total} genomes. Every cluster "
            "shown is a curated report, not a survey result, and no absence anywhere in this "
            f"figure is evidence that a clade lacks a class — nothing has looked.{placement}"
        )
    return (
        f"{examined} of {total} genomes have been examined for clusters by a recorded analysis "
        f"run; {coverage['curated_only']} carry curated clusters without a covering run, and "
        f"{coverage['unexamined']} have never been examined. Absence is only evidence within "
        f"the examined set.{placement}"
    )


# ---------------------------------------------------------------------------
# Upload: antiSMASH results from the browser
# ---------------------------------------------------------------------------
#
# Off switch, because this is the only endpoint in the API that WRITES, and
# it is unauthenticated. A public deployment that would rather stay a
# read-only reference sets BGCSCAPE_ALLOW_UPLOADS=0 and the route reports 403
# instead of silently accepting strangers' data into the shared corpus.
_UPLOADS_ENABLED = os.getenv("BGCSCAPE_ALLOW_UPLOADS", "1").strip().lower() not in {
    "0",
    "false",
    "no",
}
# antiSMASH region JSON for one bacterial genome runs to tens of MB; the cap
# is per file and generous, but it exists — an unbounded read on an
# unauthenticated endpoint is a memory-exhaustion button.
_MAX_UPLOAD_BYTES = int(os.getenv("BGCSCAPE_MAX_UPLOAD_MB", "128")) * 1024 * 1024
_MAX_UPLOAD_FILES = 25

#: Ceilings on the two free-text form fields. A binomial plus a strain
#: designation is comfortably inside 200 characters; the label is a short
#: provenance note. Enforced server-side because the endpoint is reachable
#: without the browser form that also limits them.
_MAX_ORGANISM_LENGTH = 200
_MAX_LABEL_LENGTH = 128


def _accession_from_filename(filename: str) -> str:
    """antiSMASH's JSON carries no assembly accession (see
    ingest/antismash.py), so the filename is the only identifier an upload
    comes with. `GCF_000203835.1_genomic.json` -> `GCF_000203835.1_genomic`.
    """
    stem = os.path.basename(filename or "").strip()
    for suffix in (".json", ".gz"):
        if stem.lower().endswith(suffix):
            stem = stem[: -len(suffix)]
    return stem or "uploaded-genome"


@app.post("/api/v1/ingest/antismash", response_model=AntismashUploadResponse)
async def ingest_antismash_upload(
    files: list[UploadFile] = File(..., description="antiSMASH result JSON files, one per genome."),
    organism: str | None = Form(
        None,
        description=(
            "Organism name, e.g. 'Streptomyces coelicolor'. Without it the genome is "
            "stored but cannot be drawn: the tree is built from taxa, and antiSMASH's "
            "output contains no lineage."
        ),
    ),
    clustering: UploadFile | None = File(
        None,
        description=(
            "Optional BiG-SCAPE '*_clustering_c{cutoff}.tsv'. Supplying it is what makes "
            "'the same cluster, found elsewhere' answerable: it puts these regions into real "
            "families alongside the MIBiG references in the same run."
        ),
    ),
    cutoff: float | None = Form(None),
    is_mag: bool = Form(False),
    label: str = Form("user upload"),
    session: Session = Depends(get_session),
) -> AntismashUploadResponse:
    """Ingest one or more antiSMASH result JSONs and place them on the tree.

    The whole chain in one request — parse, BGC rows, species taxon, graft
    onto the GTDB genus — because the steps after parsing are not optional
    extras here: a genome with no taxon is skipped by the tree builder, so
    stopping at "regions ingested" would report success for something the
    user cannot see. Each file's `placement` says which rung it reached.
    """
    if not _UPLOADS_ENABLED:
        raise HTTPException(
            status_code=403,
            detail="This deployment is read-only (BGCSCAPE_ALLOW_UPLOADS is off).",
        )
    if len(files) > _MAX_UPLOAD_FILES:
        raise HTTPException(
            status_code=413,
            detail=f"Too many files: {len(files)} (limit {_MAX_UPLOAD_FILES} per request).",
        )

    # Server-side validation of the free-text fields.
    #
    # The browser caps `organism` at 200 characters, which protects nothing:
    # the endpoint is reachable without the form. Both fields end up rendered
    # as a taxon name and a source label, so an unbounded string here becomes
    # an unbounded string on every other visitor's screen.
    if organism is not None:
        organism = organism.strip()
        if len(organism) > _MAX_ORGANISM_LENGTH:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"Organism name is {len(organism)} characters, over the "
                    f"{_MAX_ORGANISM_LENGTH}-character limit."
                ),
            )
        if "\x00" in organism or any(ch in organism for ch in "\r\n\t"):
            raise HTTPException(
                status_code=422,
                detail="Organism name may not contain control characters or line breaks.",
            )
        organism = organism or None
    if len(label) > _MAX_LABEL_LENGTH:
        raise HTTPException(
            status_code=422,
            detail=f"Label is over the {_MAX_LABEL_LENGTH}-character limit.",
        )

    source = get_or_create_upload_source(session, label.strip() or "user upload")
    results: list[UploadedGenomeOut] = []
    rejected: list[str] = []

    for upload in files:
        name = upload.filename or "(unnamed)"
        payload = await upload.read()
        if not payload:
            rejected.append(f"{name}: file is empty")
            continue
        if len(payload) > _MAX_UPLOAD_BYTES:
            rejected.append(
                f"{name}: {len(payload) // (1024 * 1024)} MB exceeds the "
                f"{_MAX_UPLOAD_BYTES // (1024 * 1024)} MB limit"
            )
            continue
        try:
            raw = json.loads(payload)
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            rejected.append(f"{name}: not valid JSON ({exc})")
            continue
        if not isinstance(raw, dict):
            rejected.append(f"{name}: expected an antiSMASH result object, got {type(raw).__name__}")
            continue

        outcome = ingest_uploaded_antismash(
            session,
            source=source,
            raw=raw,
            filename=name,
            genome_accession=_accession_from_filename(name),
            organism=organism,
            is_mag=is_mag,
        )
        results.append(UploadedGenomeOut(**asdict(outcome)))

    # The clustering file is loaded AFTER every region exists, because it
    # joins on BGC.external_ref — rows for regions not yet ingested would
    # count as unmatched and the families would come back empty.
    clustering_out: ClusteringOutcomeOut | None = None
    if clustering is not None and clustering.filename:
        payload = await clustering.read()
        if len(payload) > _MAX_UPLOAD_BYTES:
            rejected.append(f"{clustering.filename}: exceeds the upload size limit")
        else:
            try:
                text = payload.decode("utf-8")
            except UnicodeDecodeError as exc:
                rejected.append(f"{clustering.filename}: not UTF-8 text ({exc})")
            else:
                rows = list(csv.DictReader(io.StringIO(text), delimiter="	"))
                outcome = ingest_uploaded_clustering(
                    session,
                    source=source,
                    rows=rows,
                    filename=clustering.filename,
                    genome_accessions=[g.accession for g in results],
                    cutoff=cutoff,
                )
                clustering_out = ClusteringOutcomeOut(**asdict(outcome))

    return AntismashUploadResponse(
        genomes=results,
        total_regions=sum(g.regions_created + g.regions_updated for g in results),
        rejected=rejected,
        clustering=clustering_out,
    )


@app.post("/api/v1/export")
def export_view(request: ExportRequest) -> Response:
    """Render a frontend-produced SVG to a publication-ready figure.

    The only non-GET endpoint in this API. It's not a write — nothing is
    persisted — but it takes a body because an SVG document doesn't fit in
    a query string. PDF conversion happens here rather than in the browser
    because browser print-to-PDF varies by platform and silently
    rasterizes some SVG features; see bgcscape/export/renderer.py.
    """
    try:
        config = ViewConfig.model_validate(request.view_config)
    except ConfigVersionError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail=f"Invalid view config: {exc}") from exc

    try:
        svg_with_metadata = embed_view_config(add_provenance_caption(request.svg, config), config)
        if request.format == "svg":
            return Response(
                content=svg_with_metadata,
                media_type="image/svg+xml",
                headers={"Content-Disposition": 'attachment; filename="phylo-bgc-figure.svg"'},
            )
        pdf = render_pdf(svg_with_metadata)
    except PdfRendererUnavailable as exc:
        # 503, not 500 and not 422: the request was valid and the server is
        # simply not equipped to render PDF here. The detail carries the
        # install hint and says SVG still works, so the user has somewhere
        # to go instead of the bare "Export failed: 500" this used to give.
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except SvgRenderError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": 'attachment; filename="phylo-bgc-figure.pdf"'},
    )


MIN_SEARCH_QUERY_LENGTH = 2
DEFAULT_SEARCH_LIMIT = 20
MAX_SEARCH_LIMIT = 500


def _escape_like(term: str) -> str:
    r"""Escape LIKE metacharacters so a search means what it says.

    `%` and `_` are wildcards in SQL LIKE. Interpolated raw, a search for
    `Strep%coccus` matched "Streptococcus" and `Strep_omyces` matched
    "Streptomyces" — results a user searching for those literal strings
    would never expect. It matters here specifically because genome
    accessions contain underscores (`GCF_000568915.1`), so the common case
    was silently running a wildcard query. Paired with `escape="\\"` on the
    ilike() call below.
    """
    return term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


@app.get("/api/v1/search", response_model=SearchResponse)
def search(
    q: str,
    limit: int = Query(DEFAULT_SEARCH_LIMIT, ge=1, le=MAX_SEARCH_LIMIT),
    session: Session = Depends(get_session),
) -> SearchResponse:
    """Find taxa and genomes by name/accession.

    Returns totals alongside the (truncated) hits: a bare list could not
    distinguish the first 20 of 380 matches from all 20 that exist, and a
    too-short query returned an empty list indistinguishable from a genuine
    no-match. Both are now stated explicitly — see `SearchResponse`.
    """
    query = q.strip()
    if len(query) < MIN_SEARCH_QUERY_LENGTH:
        return SearchResponse(
            query=query,
            results=[],
            total=0,
            truncated=False,
            limit=limit,
            message=(
                f"Query must be at least {MIN_SEARCH_QUERY_LENGTH} characters; "
                "no search was performed."
            ),
        )

    pattern = f"%{_escape_like(query)}%"
    taxon_q = session.query(Taxon).filter(Taxon.name.ilike(pattern, escape="\\"))
    genome_q = session.query(Genome).filter(Genome.accession.ilike(pattern, escape="\\"))

    total = taxon_q.count() + genome_q.count()
    taxon_matches = taxon_q.order_by(Taxon.name).limit(limit).all()
    remaining = max(limit - len(taxon_matches), 0)
    genome_matches = genome_q.order_by(Genome.accession).limit(remaining).all() if remaining else []

    results = [
        SearchResult(kind="taxon", id=t.id, label=t.name, rank=t.rank) for t in taxon_matches
    ] + [
        SearchResult(kind="genome", id=g.id, label=g.accession, accession=g.accession)
        for g in genome_matches
    ]
    return SearchResponse(
        query=query,
        results=results,
        total=total,
        truncated=total > len(results),
        limit=limit,
    )
