"""Response shapes for the visualization API.

These model what the *frontend* needs to render, not the database schema
1:1 — e.g. `TaxonTreeNode.genome_count` is aggregated across every
descendant, which has no equivalent column anywhere in bgcscape.models.
"""
from __future__ import annotations

import uuid

from pydantic import BaseModel

from bgcscape.models.base import EvidenceLevel
from bgcscape.models.bgc import BGCClass
from bgcscape.models.genome import AssemblyLevel
from bgcscape.models.taxonomy import TaxonRank


class BGCSummary(BaseModel):
    id: uuid.UUID
    bgc_class: BGCClass
    subtype: str | None = None
    mibig_accession: str | None = None
    evidence_level: EvidenceLevel


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
