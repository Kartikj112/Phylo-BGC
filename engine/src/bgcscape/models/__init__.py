"""Phylo-BGC ORM models.

Importing this package guarantees every mapped class is registered against
`Base` before anything calls `Base.metadata.create_all(...)`, Alembic
autogeneration, or resolves a string-based `relationship()` target. Always
import models via `bgcscape.models` (or ensure it has been imported)
rather than reaching into individual submodules first.
"""
from bgcscape.models.base import Base, EvidenceLevel, ProvenanceMixin, TimestampMixin
from bgcscape.models.bgc import BGC, BGCClass
from bgcscape.models.bgc_family import BGCFamily, BGCFamilyMembership, FamilyKind
from bgcscape.models.compound import BGCCompoundLink, Compound
from bgcscape.models.genome import AssemblyLevel, Genome
from bgcscape.models.phylogeny import PhylogeneticNode, PhylogeneticTree
from bgcscape.models.source import Source, SourceType
from bgcscape.models.taxonomy import Taxon, TaxonRank

__all__ = [
    "Base",
    "EvidenceLevel",
    "ProvenanceMixin",
    "TimestampMixin",
    "Source",
    "SourceType",
    "Taxon",
    "TaxonRank",
    "Genome",
    "AssemblyLevel",
    "PhylogeneticTree",
    "PhylogeneticNode",
    "BGC",
    "BGCClass",
    "BGCFamily",
    "BGCFamilyMembership",
    "FamilyKind",
    "Compound",
    "BGCCompoundLink",
]
