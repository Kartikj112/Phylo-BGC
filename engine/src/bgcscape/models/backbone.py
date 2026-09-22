"""The background backbone: every genome in a reference taxonomy, not just the corpus.

## What this is for

The corpus (`taxon`, `genome`) holds only organisms something has said
something about: a MIBiG cluster, an antiSMASH upload. That is about 1,500
genomes out of GTDB's ~900,000, so the tree shows where curated clusters
*are* and nothing about where they are not, or how much of the tree has never
been looked at. The backbone is that missing context: the whole GTDB
taxonomy, with a genome count at every node, for the interface to draw
behind the corpus.

## Why it is NOT in `taxon` / `genome`

Because every genome in it is unexamined, and the corpus tables feed
calculations that would silently absorb that. `api/comparison.py` divides
clusters by genomes, and a clade padded with 40,000 genomes nobody scanned
would read as forty thousand times poorer in biosynthesis. The prioritization
scorer loads `genome` in full. The tree builders load `taxon` in full, so the
default view would suddenly try to draw 250,000 nodes. Separate tables make
the backbone opt-in for every query: nothing reads it unless it asks by name.

The link to the corpus is by name, not a foreign key. A corpus taxon and a
backbone node describe the same clade when they have the same rank and name
on the same path from the root. A foreign key would have to be repaired every
time an upload grafts a new genome onto the corpus.

## What the counts mean

`genome_count` and `species_count` describe the reference release, not the
rows stored here, so "Streptomyces: 3,412 genomes in GTDB" is true however
much is stored. None of those genomes has been examined for clusters: see
`bgcscape.coverage`.

## Why the default stores no genome rows

GTDB names exactly one representative genome per species, so a species node
carries it as `representative_accession`. That is the default load: the
whole tree with one genome per species, and `backbone_genome` empty. Only
`--all-genomes` fills `backbone_genome`, with every genome in the release.
Measured on GTDB R11-RS232 (bac120 + ar53, 247,368 clades): a first version
that also stored the representatives as rows, and a full lineage string on
every node, grew the bundled database from 17 MB to 275 MB. Without them it
is 140 MB (38 MB gzipped), with nothing lost that the nodes do not hold.
"""
from __future__ import annotations

import uuid

from sqlalchemy import Boolean, ForeignKey, Integer, String, UniqueConstraint, Uuid
from sqlalchemy import Enum as SAEnum
from sqlalchemy.orm import Mapped, mapped_column

from bgcscape.models.base import Base, ProvenanceMixin, TimestampMixin
from bgcscape.models.taxonomy import TaxonRank


class BackboneNode(Base, TimestampMixin, ProvenanceMixin):
    """One clade of the reference taxonomy, with release-wide counts."""

    __tablename__ = "backbone_node"
    # Sibling names are unique under one parent in any taxonomy; names alone
    # are not (NCBI reuses genus names across kingdoms).
    __table_args__ = (UniqueConstraint("source_id", "parent_id", "name", name="uq_backbone_node_sibling"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    parent_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("backbone_node.id"), nullable=True, index=True
    )
    name: Mapped[str] = mapped_column(String(256), nullable=False, index=True)
    rank: Mapped[TaxonRank] = mapped_column(
        SAEnum(
            TaxonRank,
            native_enum=False,
            length=16,
            validate_strings=True,
            create_constraint=True,
            values_callable=lambda enum_cls: [member.value for member in enum_cls],
            name="ck_backbone_node_rank_valid",
        ),
        nullable=False,
    )
    #: Every genome in the release under this node, whether or not its row is
    #: stored in `backbone_genome`.
    genome_count: Mapped[int] = mapped_column(Integer, nullable=False)
    #: Species under this node (1 for a species node itself).
    species_count: Mapped[int] = mapped_column(Integer, nullable=False)
    #: Species nodes only: GTDB's representative genome for the species, as a
    #: bare NCBI accession (the spelling `genome.accession` uses).
    representative_accession: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)

    def __repr__(self) -> str:  # pragma: no cover
        return f"<BackboneNode {self.rank.value}:{self.name}>"


class BackboneGenome(Base, TimestampMixin, ProvenanceMixin):
    """One reference genome, attached to the deepest node its lineage names.

    Filled only by `ingest gtdb-backbone --all-genomes`; see the module
    docstring for why the default load leaves this table empty.
    """

    __tablename__ = "backbone_genome"
    __table_args__ = (UniqueConstraint("source_id", "accession", name="uq_backbone_genome_accession"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    #: Bare NCBI assembly accession (GTDB's RS_/GB_ prefix stripped), the
    #: same spelling `genome.accession` uses, so the two can be joined.
    accession: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    node_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("backbone_node.id"), nullable=False, index=True)
    #: GTDB's species representative for its cluster (also recorded on the
    #: species node as `representative_accession`).
    is_species_representative: Mapped[bool] = mapped_column(Boolean, nullable=False)

    def __repr__(self) -> str:  # pragma: no cover
        return f"<BackboneGenome {self.accession}>"
