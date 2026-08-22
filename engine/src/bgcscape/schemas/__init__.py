"""BGC-scape Pydantic data contracts.

Each entity exposes Base/Create/Read variants — see schemas/base.py for the
pattern. Ingestion parsers (bgcscape.ingest.*) target the *Create schemas;
a future API layer would return the *Read schemas.
"""
from bgcscape.schemas.bgc import BGCBase, BGCCreate, BGCRead
from bgcscape.schemas.bgc_family import (
    BGCFamilyBase,
    BGCFamilyCreate,
    BGCFamilyMembershipBase,
    BGCFamilyMembershipCreate,
    BGCFamilyMembershipRead,
    BGCFamilyRead,
)
from bgcscape.schemas.compound import (
    BGCCompoundLinkBase,
    BGCCompoundLinkCreate,
    BGCCompoundLinkRead,
    CompoundBase,
    CompoundCreate,
    CompoundRead,
)
from bgcscape.schemas.genome import GenomeBase, GenomeCreate, GenomeRead
from bgcscape.schemas.phylogeny import (
    PhylogeneticNodeBase,
    PhylogeneticNodeCreate,
    PhylogeneticNodeRead,
    PhylogeneticTreeBase,
    PhylogeneticTreeCreate,
    PhylogeneticTreeRead,
)
from bgcscape.schemas.source import SourceBase, SourceCreate, SourceRead
from bgcscape.schemas.taxonomy import TaxonBase, TaxonCreate, TaxonRead

__all__ = [
    "SourceBase", "SourceCreate", "SourceRead",
    "TaxonBase", "TaxonCreate", "TaxonRead",
    "GenomeBase", "GenomeCreate", "GenomeRead",
    "PhylogeneticTreeBase", "PhylogeneticTreeCreate", "PhylogeneticTreeRead",
    "PhylogeneticNodeBase", "PhylogeneticNodeCreate", "PhylogeneticNodeRead",
    "BGCBase", "BGCCreate", "BGCRead",
    "BGCFamilyBase", "BGCFamilyCreate", "BGCFamilyRead",
    "BGCFamilyMembershipBase", "BGCFamilyMembershipCreate", "BGCFamilyMembershipRead",
    "CompoundBase", "CompoundCreate", "CompoundRead",
    "BGCCompoundLinkBase", "BGCCompoundLinkCreate", "BGCCompoundLinkRead",
]
