"""BGC-scape visualization API.

Read-only by design: this API exists to serve the tree/BGC-overlay
frontend, not as a general CRUD interface — writes go through
`bgcscape.ingest` (or, later, the CLI/a curator tool), not HTTP. Run with:

    uvicorn bgcscape.api.app:app --reload

Requires the `api` extra: `pip install -e ".[api]"`.
"""
from __future__ import annotations

import uuid
from collections.abc import Iterator
from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.responses import Response
from pydantic import ValidationError
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session, selectinload

from bgcscape import __version__
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
    CompoundSummary,
    DatasetProvenanceResponse,
    ExportRequest,
    FamilyRef,
    GenomeDetail,
    SearchResult,
    TaxonTreeNode,
)
from bgcscape.api.tree_builder import build_taxonomy_tree
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
from bgcscape.models import BGC, BGCCompoundLink, BGCFamily, BGCFamilyMembership, Genome, Source, Taxon

app = FastAPI(
    title="BGC-scape API",
    description=(
        "Read-only API over the BGC-scape engine's data model, serving the "
        "taxonomy tree / BGC-overlay visualization."
    ),
    version="0.1.0",
)

# Dev-friendly default. Tighten this (specific origins, not "*") before any
# real deployment — not done here because there's no deployment target yet.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET"],
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
