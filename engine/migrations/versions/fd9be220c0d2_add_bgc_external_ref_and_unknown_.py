"""add bgc external_ref and unknown assembly level

Revision ID: fd9be220c0d2
Revises: 852abe773836
Create Date: 2026-08-24 02:35:58.827821

Hand-written, not left as autogenerate produced it. `alembic revision
--autogenerate` (even with render_as_batch=True — see migrations/env.py)
detected every named CHECK constraint across every table as "removed" and
emitted drops for all of them in upgrade(), without recreating a single
one anywhere — a real, confirmed limitation of Alembic's CHECK-constraint
diffing, not something specific to this schema. Applying that file as
generated would have silently discarded every constraint added in the
Phase 1b migration fix. This version touches only what actually changed:
- bgc.external_ref: new column + index
- genome's assembly_level CHECK constraint: needs 'unknown' added to its
  allowed-values list (see AssemblyLevel.UNKNOWN in models/genome.py)
Every other table's constraints are untouched, because nothing about them
changed in this revision.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "fd9be220c0d2"
down_revision: Union[str, None] = "852abe773836"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_OLD_ASSEMBLY_LEVELS = "'complete_genome', 'chromosome', 'scaffold', 'contig', 'mag', 'locus'"
_NEW_ASSEMBLY_LEVELS = "'complete_genome', 'chromosome', 'scaffold', 'contig', 'mag', 'locus', 'unknown'"


def upgrade() -> None:
    with op.batch_alter_table("bgc", schema=None) as batch_op:
        batch_op.add_column(sa.Column("external_ref", sa.String(length=256), nullable=True))
        batch_op.create_index(batch_op.f("ix_bgc_external_ref"), ["external_ref"], unique=False)

    with op.batch_alter_table("genome", schema=None) as batch_op:
        batch_op.drop_constraint(batch_op.f("ck_genome_assembly_level_valid"), type_="check")
        batch_op.create_check_constraint(
            "ck_genome_assembly_level_valid",
            f"assembly_level IN ({_NEW_ASSEMBLY_LEVELS})",
        )


def downgrade() -> None:
    # NOTE: this will fail with an IntegrityError if any genome row has
    # assembly_level='unknown' at downgrade time — SQLite's batch/recreate
    # strategy copies existing data into the narrower-constraint table,
    # and 'unknown' rows would violate it. This isn't a bug: it's the
    # correct, expected hazard of narrowing a constraint after data has
    # started using the newly-allowed value. Confirmed directly while
    # verifying this migration (a real UPGRADE-path test row briefly made
    # the downgrade path fail this exact way). Clean up or reclassify any
    # 'unknown' rows before downgrading past this revision.
    with op.batch_alter_table("genome", schema=None) as batch_op:
        batch_op.drop_constraint(batch_op.f("ck_genome_assembly_level_valid"), type_="check")
        batch_op.create_check_constraint(
            "ck_genome_assembly_level_valid",
            f"assembly_level IN ({_OLD_ASSEMBLY_LEVELS})",
        )

    with op.batch_alter_table("bgc", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_bgc_external_ref"))
        batch_op.drop_column("external_ref")
