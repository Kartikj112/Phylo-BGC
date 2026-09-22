"""Serve the reference backbone one clade at a time, with the corpus laid over it.

`models/backbone.py` holds the whole GTDB taxonomy, about 250,000 clades.
That is far past what `/taxonomy-tree` can ship in one response or a browser
can draw, so this serves it the way `lazy_tree.py` serves the corpus: a
clade and a few levels below it, and more only where the reader opens it.

## Laying the corpus over it

Every node carries the corpus fields the tree renderer already reads
(`genome_count`, `bgc_class_counts`, `direct_genomes`, ...) with their usual
meaning, filled from the corpus clade at the same place, or zero. Corpus and
backbone are matched by rank and name along the path from the root, not by
foreign key; see the model docstring for why.

A corpus clade with no counterpart in the backbone still has to be shown,
or the backbone view would silently hide curated clusters. MIBiG organisms
grafted under a GTDB genus under their own species name are the common
case. Such a clade appears as a child of the backbone clade it sits under,
complete with its corpus subtree (it is small, and the backbone has nothing
below it to load).

## Wide clades

GTDB has genera with thousands of species. A level returns every child that
holds corpus genomes and then up to `limit` reference-only children, largest
first. The rest are counted in `omitted_child_count` rather than listed, so
the interface can say "and 1,412 more species, none examined".

## The corpus side is cached

Laying the corpus over a level needs the aggregated corpus tree, which takes
about half a second to build. It is rebuilt only when the corpus changes
(an upload), detected by counts and timestamps that are cheap to read.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass

from sqlalchemy import exists, func
from sqlalchemy.orm import Session

from bgcscape.api.schemas import BackboneStatus, BackboneTreeNode, TaxonTreeNode
from bgcscape.api.tree_builder import TreeScope, build_taxonomy_tree
from bgcscape.coverage import CoverageState
from bgcscape.models import BGC, BackboneNode, Genome, Source, Taxon

DEFAULT_LIMIT = 200
MAX_LIMIT = 1_000
MAX_DEPTH = 3

#: Which reference taxonomy backs which view. Only GTDB exists so far; NCBI
#: eukaryotes need NCBI's assembly list, not the taxonomy dump the corpus
#: uses, because the taxonomy names organisms rather than genomes.
_SOURCE_FOR_SCOPE = {"prokaryote": "GTDB"}

Path = tuple[tuple[str, str], ...]


class BackboneUnavailable(LookupError):
    pass


class BackboneNodeNotFound(LookupError):
    pass


# ----- source and status ----------------------------------------------------


def backbone_source(session: Session, scope: TreeScope) -> Source | None:
    """The most recently loaded release with a backbone for `scope`."""
    name = _SOURCE_FOR_SCOPE.get(scope)
    if name is None:
        return None
    return (
        session.query(Source)
        .filter(Source.name == name, exists().where(BackboneNode.source_id == Source.id))
        .order_by(Source.created_at.desc())
        .first()
    )


def _unavailable_reason(scope: TreeScope) -> str:
    if scope not in _SOURCE_FOR_SCOPE:
        return (
            "No reference backbone exists for this taxonomy yet. The GTDB backbone covers "
            "bacteria and archaea only."
        )
    return (
        "No GTDB backbone is loaded. Build it with `bgcscape ingest gtdb-backbone "
        "bac120_metadata.tsv.gz ar53_metadata.tsv.gz`."
    )


def backbone_status(session: Session, scope: TreeScope) -> BackboneStatus:
    source = backbone_source(session, scope)
    if source is None:
        return BackboneStatus(scope=scope, available=False, reason=_unavailable_reason(scope))
    clades = session.query(func.count(BackboneNode.id)).filter(BackboneNode.source_id == source.id).scalar()
    genomes, species = (
        session.query(func.sum(BackboneNode.genome_count), func.sum(BackboneNode.species_count))
        .filter(BackboneNode.source_id == source.id, BackboneNode.parent_id.is_(None))
        .one()
    )
    return BackboneStatus(
        scope=scope,
        available=True,
        source_name=source.name,
        source_version=source.version,
        clade_count=clades or 0,
        reference_genome_count=genomes or 0,
        reference_species_count=species or 0,
    )


# ----- the corpus side ------------------------------------------------------


@dataclass
class _CorpusIndex:
    root: TaxonTreeNode
    by_path: dict[Path, TaxonTreeNode]
    #: Curated-only genomes under each corpus clade, keyed by id(node).
    curated_only: dict[int, int]


_corpus_cache: dict[tuple, _CorpusIndex] = {}


def _corpus_fingerprint(session: Session, scope: TreeScope) -> tuple:
    """Changes whenever the corpus does. Uploads add genomes, taxa and
    clusters; re-ingests touch `updated_at`."""
    parts: list = [id(session.get_bind()), scope]
    for model in (Genome, BGC, Taxon):
        parts.extend(session.query(func.count(model.id), func.max(model.updated_at)).one())
    return tuple(parts)


def _corpus_index(session: Session, scope: TreeScope) -> _CorpusIndex:
    key = _corpus_fingerprint(session, scope)
    cached = _corpus_cache.get(key)
    if cached is not None:
        return cached

    root = build_taxonomy_tree(session, scope=scope)
    by_path: dict[Path, TaxonTreeNode] = {(): root}

    def walk(node: TaxonTreeNode, path: Path) -> None:
        for child in node.children:
            child_path = path + ((child.rank.value if child.rank else "", child.name),)
            by_path[child_path] = child
            walk(child, child_path)

    walk(root, ())

    curated_only: dict[int, int] = {}

    def count_curated(node: TaxonTreeNode) -> int:
        n = sum(1 for g in node.direct_genomes if g.coverage is CoverageState.CURATED_ONLY)
        n += sum(count_curated(c) for c in node.children)
        curated_only[id(node)] = n
        return n

    count_curated(root)
    index = _CorpusIndex(root=root, by_path=by_path, curated_only=curated_only)
    # One corpus per database in practice; keep the latest only.
    _corpus_cache.clear()
    _corpus_cache[key] = index
    return index


# ----- building nodes -------------------------------------------------------


_NODE_COLUMNS = (
    BackboneNode.id,
    BackboneNode.name,
    BackboneNode.rank,
    BackboneNode.genome_count,
    BackboneNode.species_count,
    BackboneNode.representative_accession,
)


def _corpus_only_node(corpus: TaxonTreeNode, curated_only: dict[int, int]) -> BackboneTreeNode:
    """A corpus clade the reference does not contain, with its whole subtree."""
    return BackboneTreeNode(
        id=str(corpus.id) if corpus.id else None,
        name=corpus.name,
        rank=corpus.rank,
        genome_count=corpus.genome_count,
        examined_genome_count=corpus.examined_genome_count,
        bgc_class_counts=corpus.bgc_class_counts,
        direct_genomes=corpus.direct_genomes,
        children=[_corpus_only_node(c, curated_only) for c in corpus.children],
        curated_only_genome_count=curated_only.get(id(corpus), 0),
        backbone_id=None,
        corpus_taxon_id=corpus.id,
        reference_genome_count=0,
        reference_species_count=0,
        child_count=len(corpus.children),
        children_loaded=True,
    )


class _Builder:
    def __init__(self, session: Session, source: Source, index: _CorpusIndex, limit: int):
        self.session = session
        self.source = source
        self.index = index
        self.limit = limit

    def _rows(self, parent_id: uuid.UUID | None) -> list:
        query = self.session.query(*_NODE_COLUMNS).filter(BackboneNode.source_id == self.source.id)
        if parent_id is None:
            query = query.filter(BackboneNode.parent_id.is_(None))
        else:
            query = query.filter(BackboneNode.parent_id == parent_id)
        return query.all()

    def _child_names(self, parent_ids: list[uuid.UUID]) -> dict[uuid.UUID, list[tuple[str, str]]]:
        """(rank, name) of every backbone child, for a batch of parents."""
        out: dict[uuid.UUID, list[tuple[str, str]]] = {pid: [] for pid in parent_ids}
        if not parent_ids:
            return out
        for parent_id, rank, name in (
            self.session.query(BackboneNode.parent_id, BackboneNode.rank, BackboneNode.name)
            .filter(BackboneNode.source_id == self.source.id, BackboneNode.parent_id.in_(parent_ids))
            .all()
        ):
            out[parent_id].append((rank.value, name))
        return out

    def children(
        self, parent_id: uuid.UUID | None, parent_path: Path, depth: int
    ) -> tuple[list[BackboneTreeNode], int, int]:
        """The children of one clade: (nodes, omitted count, omitted genomes)."""
        rows = self._rows(parent_id)
        corpus_parent = self.index.by_path.get(parent_path)

        matched: list[tuple] = []  # (row, path, corpus node or None)
        backbone_keys = set()
        for row in rows:
            key = (row.rank.value, row.name)
            backbone_keys.add(key)
            path = parent_path + (key,)
            matched.append((row, path, self.index.by_path.get(path)))
        corpus_only = [
            c
            for c in (corpus_parent.children if corpus_parent else [])
            if ((c.rank.value if c.rank else ""), c.name) not in backbone_keys
        ]

        # Every clade with corpus genomes is shown; reference-only clades fill
        # the remaining room, largest first.
        with_corpus = [m for m in matched if m[2] is not None and m[2].genome_count > 0]
        reference_only = [m for m in matched if m[2] is None or m[2].genome_count == 0]
        reference_only.sort(key=lambda m: (-m[0].genome_count, m[0].name))
        room = max(0, self.limit - len(with_corpus) - len(corpus_only))
        shown = with_corpus + reference_only[:room]
        omitted = reference_only[room:]

        nodes = self._build_many(shown, depth)
        nodes.extend(_corpus_only_node(c, self.index.curated_only) for c in corpus_only)
        nodes.sort(key=lambda n: n.name)
        return nodes, len(omitted), sum(m[0].genome_count for m in omitted)

    def _build_many(self, entries: list[tuple], depth: int) -> list[BackboneTreeNode]:
        """Nodes for `entries`; `depth` more levels below each are loaded."""
        ids = [row.id for row, _, _ in entries]
        child_names = self._child_names(ids)
        out = []
        for row, path, corpus in entries:
            names = set(child_names[row.id])
            corpus_extra = sum(
                1
                for c in (corpus.children if corpus else [])
                if ((c.rank.value if c.rank else ""), c.name) not in names
            )
            child_count = len(names) + corpus_extra
            if depth > 0 and child_count:
                children, omitted, omitted_genomes = self.children(row.id, path, depth - 1)
                loaded = True
            else:
                children, omitted, omitted_genomes = [], 0, 0
                loaded = child_count == 0
            out.append(
                BackboneTreeNode(
                    id=str(corpus.id) if corpus and corpus.id else str(row.id),
                    name=row.name,
                    rank=row.rank,
                    genome_count=corpus.genome_count if corpus else 0,
                    examined_genome_count=corpus.examined_genome_count if corpus else 0,
                    curated_only_genome_count=self.index.curated_only.get(id(corpus), 0) if corpus else 0,
                    bgc_class_counts=corpus.bgc_class_counts if corpus else {},
                    direct_genomes=corpus.direct_genomes if corpus else [],
                    children=children,
                    backbone_id=row.id,
                    corpus_taxon_id=corpus.id if corpus else None,
                    reference_genome_count=row.genome_count,
                    reference_species_count=row.species_count,
                    representative_accession=row.representative_accession,
                    child_count=child_count,
                    children_loaded=loaded,
                    omitted_child_count=omitted,
                    omitted_reference_genome_count=omitted_genomes,
                )
            )
        return out


def build_backbone_tree(
    session: Session,
    scope: TreeScope,
    parent: uuid.UUID | None = None,
    depth: int = 1,
    limit: int = DEFAULT_LIMIT,
) -> BackboneTreeNode:
    """A clade (the synthetic root when `parent` is None) and `depth` levels
    of its children."""
    if not 1 <= depth <= MAX_DEPTH:
        raise ValueError(f"depth must be between 1 and {MAX_DEPTH}")
    if not 1 <= limit <= MAX_LIMIT:
        raise ValueError(f"limit must be between 1 and {MAX_LIMIT}")
    source = backbone_source(session, scope)
    if source is None:
        raise BackboneUnavailable(_unavailable_reason(scope))

    builder = _Builder(session, source, _corpus_index(session, scope), limit)

    if parent is None:
        children, omitted, omitted_genomes = builder.children(None, (), depth - 1)
        corpus_root = builder.index.root
        roots = builder._rows(None)
        return BackboneTreeNode(
            id=None,
            name="root",
            rank=None,
            genome_count=corpus_root.genome_count,
            examined_genome_count=corpus_root.examined_genome_count,
            curated_only_genome_count=builder.index.curated_only.get(id(corpus_root), 0),
            bgc_class_counts=corpus_root.bgc_class_counts,
            direct_genomes=[],
            children=children,
            backbone_id=None,
            corpus_taxon_id=None,
            reference_genome_count=sum(r.genome_count for r in roots),
            reference_species_count=sum(r.species_count for r in roots),
            child_count=len(children) + omitted,
            children_loaded=True,
            omitted_child_count=omitted,
            omitted_reference_genome_count=omitted_genomes,
        )

    row = (
        session.query(BackboneNode)
        .filter(BackboneNode.id == parent, BackboneNode.source_id == source.id)
        .one_or_none()
    )
    if row is None:
        raise BackboneNodeNotFound(f"backbone node {parent} not found")
    path: list[tuple[str, str]] = []
    node = row
    while node is not None:
        path.append((node.rank.value, node.name))
        node = session.get(BackboneNode, node.parent_id) if node.parent_id else None
    path_t: Path = tuple(reversed(path))
    selected = session.query(*_NODE_COLUMNS).filter(BackboneNode.id == row.id).one()
    return builder._build_many([(selected, path_t, builder.index.by_path.get(path_t))], depth)[0]
