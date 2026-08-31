"""add genome.gtdb_tip_accession

Revision ID: a3f81c65b420
Revises: d7e3a91c4f20
Create Date: 2026-08-31 04:10:00.000000

Hand-written for the reason every migration in this project is (see
fd9be220c0d2's docstring): `alembic revision --autogenerate` reports every
named CHECK constraint in the schema as removed and emits drops for all of
them without recreating any. This revision therefore touches exactly one
thing — a new nullable column on `genome`, plus its index.

The column records which tip of GTDB's reference tree a genome maps to.
It is additive and nullable, so it needs no backfill to be correct: a null
means "no tip resolved yet", which is the truthful state for a database
migrated before `bgcscape ingest gtdb` is re-run, and is also the
permanent, correct state for the MIBiG locus accessions that GTDB's tree
has nothing to join to.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "a3f81c65b420"
down_revision: Union[str, None] = "d7e3a91c4f20"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("genome", schema=None) as batch_op:
        batch_op.add_column(sa.Column("gtdb_tip_accession", sa.String(length=64), nullable=True))
        batch_op.create_index(
            batch_op.f("ix_genome_gtdb_tip_accession"), ["gtdb_tip_accession"], unique=False
        )


def downgrade() -> None:
    # Safe to reverse with no data hazard: the column is additive and
    # nullable, so nothing else in the schema depends on its values. What
    # is lost is the genome->tree-tip mapping, which `bgcscape ingest gtdb`
    # reconstructs in full from the metadata TSV.
    with op.batch_alter_table("genome", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_genome_gtdb_tip_accession"))
        batch_op.drop_column("gtdb_tip_accession")
