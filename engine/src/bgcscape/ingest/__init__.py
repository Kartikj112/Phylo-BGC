"""Ingestion parsers and loaders for curated reference datasets.

Each source module (mibig.py, gtdb.py, ...) follows the same shape:
  parse_*()   pure function, raw external format -> a plain dataclass. No
              database access — unit-testable in isolation.
  load_*()    dataclass + Session + Source -> idempotent upsert of ORM
              objects (safe to re-run over a refreshed export).
  ingest_*()  orchestrates a batch: loops, applies any source-specific
              filtering, and never lets one bad record abort the run — see
              ingest/_util.py's IngestReport.

antiSMASH region-JSON ingestion is intentionally not here yet — see
PROGRESS.md for why (it's MVP v2 in the original product report, and this
chunk stayed scoped to MVP v1: MIBiG + GTDB).
"""
