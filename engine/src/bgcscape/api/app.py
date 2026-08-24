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

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session, selectinload

from bgcscape.api.schemas import (
    BGCDetail,
    BGCFamilyDetail,
    BGCFamilyMember,
    BGCFamilySummary,
    BGCSummary,
    CompoundSummary,
    GenomeDetail,
    SearchResult,
    TaxonTreeNode,
)
from bgcscape.api.tree_builder import build_taxonomy_tree
from bgcscape.db.session import get_sessionmaker
from bgcscape.models import BGC, BGCCompoundLink, BGCFamily, BGCFamilyMembership, Genome, Taxon

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
