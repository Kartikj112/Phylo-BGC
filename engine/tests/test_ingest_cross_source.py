"""Tests spanning more than one ingestion source at once — specifically the
scenario where MIBiG and GTDB independently describe the same organism and
their natural keys happen to collide on the same `Taxon` row (MIBiG keyed
by `ncbi_taxid`, GTDB keyed by `(rank, name)`). Kept as its own file rather
than folded into test_ingest_mibig.py/test_ingest_gtdb.py because it's
deliberately testing an *interaction* between the two modules, not either
one in isolation.

This locks in a real bug found while manually exercising the CLI in this
chunk: without the None-guard in get_or_create_or_update() (see
ingest/_util.py), ingesting GTDB after MIBiG silently nulled out the
ncbi_taxid MIBiG had already recorded, because GTDB's TaxonCreate doesn't
carry that field.
"""
from __future__ import annotations

import csv
import json
from pathlib import Path

from bgcscape.ingest.gtdb import ingest_gtdb_metadata
from bgcscape.ingest.mibig import ingest_mibig_entries
from bgcscape.models import Taxon

FIXTURES = Path(__file__).parent / "fixtures"


def test_gtdb_after_mibig_does_not_erase_ncbi_taxid(session, mibig_source, gtdb_source):
    mibig_entry = json.loads((FIXTURES / "mibig_test_entry_active_single_class.json").read_text())
    ingest_mibig_entries(session, mibig_source, [mibig_entry])

    taxon = session.query(Taxon).filter_by(name="Streptomyces testomycini").one()
    assert taxon.ncbi_taxid == 9999901
    assert taxon.source_id == mibig_source.id

    with open(FIXTURES / "gtdb_metadata_test.tsv", newline="", encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh, delimiter="\t"))
    # Same organism name as the MIBiG fixture — this is what triggers the
    # natural-key collision on the Taxon table.
    assert rows[0]["gtdb_taxonomy"].endswith("s__Streptomyces testomycini")
    ingest_gtdb_metadata(session, gtdb_source, [rows[0]])

    session.refresh(taxon)
    # The fact MIBiG recorded must survive GTDB's update to the same row.
    assert taxon.ncbi_taxid == 9999901
    # Documented simplification (see ARCHITECTURE.md): source_id/
    # evidence_level DO shift to whichever source touched the row last,
    # since this project doesn't yet do per-field provenance. Asserting it
    # explicitly here so a future change to that behavior is a deliberate
    # decision, not an accidental one.
    assert taxon.source_id == gtdb_source.id

    # Only one Taxon row for the shared species — not two.
    assert session.query(Taxon).filter_by(name="Streptomyces testomycini").count() == 1


def test_mibig_after_gtdb_does_not_erase_gtdb_taxonomy_string(session, mibig_source, gtdb_source):
    """Same collision, opposite order: GTDB first, then MIBiG. This is the
    harder direction — MIBiG's primary lookup key (ncbi_taxid) is never
    set on a GTDB-created row, so without the fallback_lookups mechanism
    in get_or_create_or_update(), this order created a *duplicate* Taxon
    instead of merging into GTDB's. See that function's docstring.
    """
    with open(FIXTURES / "gtdb_metadata_test.tsv", newline="", encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh, delimiter="\t"))
    ingest_gtdb_metadata(session, gtdb_source, [rows[0]])

    taxon_after_gtdb = session.query(Taxon).filter_by(name="Streptomyces testomycini").one()
    assert taxon_after_gtdb.gtdb_taxonomy_string is not None
    assert taxon_after_gtdb.ncbi_taxid is None

    mibig_entry = json.loads((FIXTURES / "mibig_test_entry_active_single_class.json").read_text())
    ingest_mibig_entries(session, mibig_source, [mibig_entry])

    # Must still be exactly one row for this species — not a duplicate.
    assert session.query(Taxon).filter_by(name="Streptomyces testomycini").count() == 1
    merged = session.query(Taxon).filter_by(name="Streptomyces testomycini").one()
    assert merged.id == taxon_after_gtdb.id  # same row, not a new one
    assert merged.gtdb_taxonomy_string is not None  # GTDB's fact preserved
    assert merged.ncbi_taxid == 9999901  # MIBiG's fact now attached too
