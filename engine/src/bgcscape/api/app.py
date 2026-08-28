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
from fastapi.middleware.gzip import GZipMiddleware
from sqlalchemy import func
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
)
from bgcscape.api.tree_builder import (
    TreeScope,
    build_taxonomy_tree,
    component_classes,
    load_classified_bgc_rows,
)
from bgcscape.ingest.link import PLACEMENT_METHOD_LABELS, placement_of
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
        clade = ancestor_at(taxon_id)
        if clade is None:
            continue
        clade_id, clade_name = clade
        key = str(clade_id)
        row_names[key] = clade_name
        genome_counts[key] = genome_counts.get(key, 0) + genome_total

    for _genome_id, taxon_id, bgc_class, subtype in load_classified_bgc_rows(session):
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
def get_bgc_type_counts(session: Session = Depends(get_session)) -> list[BGCTypeCount]:
    """Corpus-wide BGC class distribution, for the summary donut.

    Hybrids are attributed to each component class, matching every other
    count in the app (filter rail, comparison, heatmap, flows) — a donut
    disagreeing with the sidebar beside it would be worse than no donut.
    """
    # GROUP BY in the database, then expand hybrids in Python. The previous
    # version loaded every BGC as a mapped object — decoding each
    # `raw_annotation` blob — to produce seven integers. The distinct
    # (class, subtype) pairs number in the dozens, not the thousands.
    counts: dict[str, int] = {}
    for bgc_class, subtype, n in session.query(
        BGC.bgc_class, BGC.subtype, func.count(BGC.id)
    ).group_by(BGC.bgc_class, BGC.subtype):
        for component in component_classes(bgc_class, subtype):
            counts[component] = counts.get(component, 0) + n
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
        headers={"Content-Disposition": 'attachment; filename="bgc-scape-figure.pdf"'},
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
