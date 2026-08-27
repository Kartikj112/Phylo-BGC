"""BGC-scape visualization API.

Read-only by design: this API exists to serve the tree/BGC-overlay
frontend, not as a general CRUD interface — writes go through
`bgcscape.ingest` (or, later, the CLI/a curator tool), not HTTP. Run with:

    uvicorn bgcscape.api.app:app --reload

Requires the `api` extra: `pip install -e ".[api]"`.
"""
from __future__ import annotations

import os
import uuid
from collections.abc import Iterator
from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.responses import Response
from pydantic import ValidationError
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session, selectinload

from bgcscape import __version__
from bgcscape.api.flows import build_taxonomy_class_flow
from bgcscape.api.lazy_tree import LazyTreeError, build_lazy_tree
from bgcscape.api.comparison import (
    all_family_labels,
    build_clade_profile,
    compute_caveats,
    partition_families,
)
from bgcscape.api.schemas import (
    BGCDetail,
    BGCFamilyDetail,
    BGCFamilyMember,
    BGCFamilySummary,
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
    SearchResult,
    TaxonomyClassFlow,
    TaxonTreeNode,
)
from bgcscape.api.tree_builder import build_taxonomy_tree
from bgcscape.ingest.link import PLACEMENT_METHOD_LABELS, placement_of
from bgcscape.db.session import get_sessionmaker
from bgcscape.export import (
    ConfigVersionError,
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
    rank_bgcs,
)
from bgcscape.models import BGC, BGCCompoundLink, BGCFamily, BGCFamilyMembership, Genome, Source, Taxon
from bgcscape.models.taxonomy import TaxonRank

app = FastAPI(
    title="BGC-scape API",
    description=(
        "Read-only API over the BGC-scape engine's data model, serving the "
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
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


def get_session() -> Iterator[Session]:
    session = get_sessionmaker()()
    try:
        yield session
    finally:
        session.close()


@app.get("/api/v1/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/v1/taxonomy-tree", response_model=TaxonTreeNode)
def get_taxonomy_tree(session: Session = Depends(get_session)) -> TaxonTreeNode:
    return build_taxonomy_tree(session)


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


@app.get("/api/v1/bgc-classes")
def get_bgc_classes(session: Session = Depends(get_session)) -> list[str]:
    rows = session.query(BGC.bgc_class).distinct().all()
    return sorted({row[0].value for row in rows})


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

    labels: dict[uuid.UUID, str] = {}
    for profile in profiles:
        labels.update(profile.family_labels)
    missing = (set(shared_ids) | {fid for ids in only_in.values() for fid in ids}) - labels.keys()
    labels.update(all_family_labels(session, missing))

    def family_refs(ids: list[uuid.UUID]) -> list[FamilyRef]:
        refs = [FamilyRef(id=fid, label=labels.get(fid, "(unlabelled)")) for fid in ids]
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
    limit: int = 20,
    session: Session = Depends(get_session),
) -> PrioritizationResponse:
    """Rank BGCs as candidates for follow-up.

    This is a prioritization hint, not a novelty measurement — see
    bgcscape/scoring/prioritization.py. The response's `caveats` are part
    of the contract, not garnish.
    """
    ranked = rank_bgcs(session, limit=limit)
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
            )
        )

    shared_caveats = ranked[0].caveats if ranked else [NOT_A_NOVELTY_CLAIM, SCORE_IS_ORDINAL, WEIGHTS_ARE_UNCALIBRATED]
    return PrioritizationResponse(
        results=results,
        weights=DEFAULT_WEIGHTS,
        caveats=shared_caveats,
        corpus_bgc_count=ctx_bgcs,
        mibig_reference_present=mibig_present,
    )


@app.get("/api/v1/flows/taxonomy-class", response_model=TaxonomyClassFlow)
def get_taxonomy_class_flow(session: Session = Depends(get_session)) -> TaxonomyClassFlow:
    """Sankey flows from phylum through genus to BGC class."""
    return TaxonomyClassFlow(**build_taxonomy_class_flow(session))


@app.get("/api/v1/heatmap", response_model=PresenceHeatmap)
def get_presence_heatmap(
    rank: str = "genus",
    session: Session = Depends(get_session),
) -> PresenceHeatmap:
    """Clade x BGC-class matrix (report section 4.9)."""
    try:
        target_rank = TaxonRank(rank)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=f"Unknown rank: {rank}") from exc

    taxa = {t.id: t for t in session.query(Taxon).all()}

    def ancestor_at(taxon_id):
        current = taxa.get(taxon_id)
        while current is not None:
            if current.rank == target_rank:
                return current
            current = taxa.get(current.parent_id) if current.parent_id else None
        return None

    genomes = (
        session.query(Genome).options(selectinload(Genome.bgcs)).filter(Genome.taxon_id.isnot(None)).all()
    )

    counts: dict[str, dict[str, int]] = {}
    genome_counts: dict[str, int] = {}
    row_names: dict[str, str] = {}
    classes: set[str] = set()

    for genome in genomes:
        clade = ancestor_at(genome.taxon_id)
        if clade is None:
            continue
        key = str(clade.id)
        row_names[key] = clade.name
        genome_counts[key] = genome_counts.get(key, 0) + 1
        bucket = counts.setdefault(key, {})
        for bgc in genome.bgcs:
            components = (
                [p.strip().lower() for p in bgc.subtype.split("+") if p.strip()]
                if bgc.bgc_class.value == "hybrid" and bgc.subtype
                else [bgc.bgc_class.value]
            )
            for component in components:
                classes.add(component)
                bucket[component] = bucket.get(component, 0) + 1

    ordered_columns = sorted(classes)
    rows = [
        {"id": key, "label": row_names[key], "genome_count": genome_counts[key]}
        for key in sorted(row_names, key=lambda k: -genome_counts[k])
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
def get_bgc_type_counts(session: Session = Depends(get_session)) -> list[BGCTypeCount]:
    """Corpus-wide BGC class distribution, for the summary donut.

    Hybrids are attributed to each component class, matching every other
    count in the app (filter rail, comparison, heatmap, flows) — a donut
    disagreeing with the sidebar beside it would be worse than no donut.
    """
    counts: dict[str, int] = {}
    for bgc in session.query(BGC).all():
        components = (
            [p.strip().lower() for p in bgc.subtype.split("+") if p.strip()]
            if bgc.bgc_class.value == "hybrid" and bgc.subtype
            else [bgc.bgc_class.value]
        )
        for component in components:
            counts[component] = counts.get(component, 0) + 1
    return [
        BGCTypeCount(bgc_class=k, count=v) for k, v in sorted(counts.items(), key=lambda kv: -kv[1])
    ]


@app.get("/api/v1/provenance", response_model=DatasetProvenanceResponse)
def get_provenance(session: Session = Depends(get_session)) -> DatasetProvenanceResponse:
    """What this database actually contains — for figure captions and to
    populate ViewConfig.dataset."""
    return DatasetProvenanceResponse(
        sources=[SourceRead.model_validate(s) for s in session.query(Source).order_by(Source.name).all()],
        genome_count=session.query(Genome).count(),
        bgc_count=session.query(BGC).count(),
        taxon_count=session.query(Taxon).count(),
        family_count=session.query(BGCFamily).count(),
        engine_version=__version__,
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
                headers={"Content-Disposition": 'attachment; filename="bgc-scape-figure.svg"'},
            )
        pdf = render_pdf(svg_with_metadata)
    except SvgRenderError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": 'attachment; filename="bgc-scape-figure.pdf"'},
    )


@app.get("/api/v1/search", response_model=list[SearchResult])
def search(q: str, session: Session = Depends(get_session)) -> list[SearchResult]:
    query = q.strip()
    if len(query) < 2:
        return []
    pattern = f"%{query}%"

    taxon_matches = session.query(Taxon).filter(Taxon.name.ilike(pattern)).limit(20).all()
    genome_matches = session.query(Genome).filter(Genome.accession.ilike(pattern)).limit(20).all()

    return [SearchResult(kind="taxon", id=t.id, label=t.name, rank=t.rank) for t in taxon_matches] + [
        SearchResult(kind="genome", id=g.id, label=g.accession, accession=g.accession) for g in genome_matches
    ]
