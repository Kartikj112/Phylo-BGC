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
    BGCSummary,
    CompoundSummary,
    GenomeDetail,
    SearchResult,
    TaxonTreeNode,
)
from bgcscape.api.tree_builder import build_taxonomy_tree
from bgcscape.db.session import get_sessionmaker
from bgcscape.models import BGC, BGCCompoundLink, Genome, Taxon

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
        .options(selectinload(Genome.bgcs), selectinload(Genome.taxon))
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
