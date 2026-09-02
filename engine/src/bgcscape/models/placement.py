"""How a curated cluster came to sit on a genome that did not produce it.

MIBiG records a cluster, an organism name and an NCBI taxid — never an
assembly. `ingest/link.py` re-points each cluster at GTDB's genome for the
same organism so it lands on a real backbone. That placement is an inference,
and it is a different claim from every other genome/BGC edge in the schema.

## The claim, stated once, structurally

    This cluster was characterized in an organism that THIS GENOME
    REPRESENTS. It was not sequenced from this assembly.

Three things in this table hold that line:

  * the FK is `representative_genome_id`, not `genome_id` — the genome
    stands in for the organism, and the column name is the only place a
    reader is guaranteed to look;
  * `BGC.contig` still carries MIBiG's own locus accession, untouched, so
    what *was* sequenced remains recorded;
  * `method` and `confidence` are stored columns, so "which entries rest on
    weak name matching?" is `WHERE confidence = 'weak'` rather than prose in
    a report nobody kept.

The placement used to live in a `_bgcscape_placement` key inside
`BGC.raw_annotation`. That made it real but unqueryable: answering the
question above meant decoding 2,437 JSON blobs in Python, and no constraint
stopped a caller writing a method string the vocabulary never contained.
"""
from __future__ import annotations

import enum
import uuid

from sqlalchemy import ForeignKey, String, Text, UniqueConstraint, Uuid
from sqlalchemy import Enum as SAEnum
from sqlalchemy.orm import Mapped, mapped_column, relationship

from bgcscape.models.base import Base, ProvenanceMixin, TimestampMixin


class PlacementMethod(str, enum.Enum):
    """How the organism was matched to a GTDB genome, strongest first.

    The values are exactly the `match_method` vocabulary
    `scripts/build_gtdb_subset.py` emits, so the mapping TSV loads without
    translation — and now cannot introduce a method nobody defined, because
    the column is CHECK-constrained.
    """

    NCBI_TAXID = "ncbi_taxid"
    NCBI_SPECIES_TAXID = "ncbi_species_taxid"
    GTDB_SPECIES = "gtdb_species"
    NCBI_SPECIES_NAME = "ncbi_species_name"
    GENUS = "genus"
    UNPLACED = "unplaced"


class PlacementConfidence(str, enum.Enum):
    """How much weight the match itself bears.

    STRONG    An identifier matched an identifier — NCBI taxid to NCBI
              taxid. Two databases naming the same organism by number.
    MODERATE  A species-level identifier or GTDB's own species name
              matched. Still an identifier, but one rank coarser, or
              mediated by a name GTDB controls.
    WEAK      A free-text organism name matched, or the cluster reached
              only its genus. Nomenclature drifts, GTDB reclassifies, and
              two organisms can share a name across databases that do not
              mean the same thing by it.

    Derived from `method` at write time and stored, not computed on read:
    the point of the exercise is that a researcher can filter on it in SQL
    without importing Python.
    """

    STRONG = "strong"
    MODERATE = "moderate"
    WEAK = "weak"


#: Confidence for each method, in one place so writer and migration cannot
#: disagree about what a match is worth.
CONFIDENCE_BY_METHOD: dict[PlacementMethod, PlacementConfidence] = {
    PlacementMethod.NCBI_TAXID: PlacementConfidence.STRONG,
    PlacementMethod.NCBI_SPECIES_TAXID: PlacementConfidence.MODERATE,
    PlacementMethod.GTDB_SPECIES: PlacementConfidence.MODERATE,
    PlacementMethod.NCBI_SPECIES_NAME: PlacementConfidence.WEAK,
    PlacementMethod.GENUS: PlacementConfidence.WEAK,
    PlacementMethod.UNPLACED: PlacementConfidence.WEAK,
}


class BGCOrganismPlacement(Base, TimestampMixin, ProvenanceMixin):
    """One cluster's placement onto the genome representing its organism."""

    __tablename__ = "bgc_organism_placement"
    # Named table constraint rather than `unique=True` on the column: the
    # column form renders as a UNIQUE INDEX, which is a different DDL shape
    # from the migration's UniqueConstraint and would leave the two
    # describing the same guarantee differently.
    __table_args__ = (UniqueConstraint("bgc_id", name="uq_bgc_organism_placement_bgc"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    #: Unique: a cluster is placed once. Re-running `link-mibig` updates the
    #: row rather than accumulating a history — and a second row would leave
    #: every reader to decide which placement was current.
    bgc_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("bgc.id"), nullable=False, index=True
    )
    #: GTDB's genome for the organism this cluster was characterized in.
    #: NOT the assembly the cluster was sequenced from — see the module
    #: docstring. Nullable because `UNPLACED` is a real, recordable outcome:
    #: "we tried and GTDB has no genome for this organism" is worth storing,
    #: and storing it as a missing row would make it indistinguishable from
    #: never having tried.
    representative_genome_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("genome.id"), nullable=True, index=True
    )
    method: Mapped[PlacementMethod] = mapped_column(
        SAEnum(
            PlacementMethod,
            native_enum=False,
            length=32,
            validate_strings=True,
            create_constraint=True,
            values_callable=lambda enum_cls: [member.value for member in enum_cls],
            name="ck_bgc_organism_placement_method_valid",
        ),
        nullable=False,
        index=True,
    )
    confidence: Mapped[PlacementConfidence] = mapped_column(
        SAEnum(
            PlacementConfidence,
            native_enum=False,
            length=16,
            validate_strings=True,
            create_constraint=True,
            values_callable=lambda enum_cls: [member.value for member in enum_cls],
            name="ck_bgc_organism_placement_confidence_valid",
        ),
        nullable=False,
        index=True,
    )
    #: The accession the mapping named, kept verbatim. `representative_genome_id`
    #: can be re-pointed by a later ingest; this records what the join was
    #: actually made against, which is what an audit needs.
    gtdb_accession: Mapped[str | None] = mapped_column(String(64), nullable=True)
    #: What a reader must know before citing this placement. Stored per row
    #: rather than looked up from `method`, so it travels with an export.
    caveat: Mapped[str] = mapped_column(Text, nullable=False)

    bgc: Mapped["BGC"] = relationship(back_populates="placement")
    representative_genome: Mapped["Genome | None"] = relationship()

    def __repr__(self) -> str:  # pragma: no cover
        return f"<BGCOrganismPlacement bgc={self.bgc_id} via {self.method.value}>"
