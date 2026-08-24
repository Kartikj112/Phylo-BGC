"""Ingestion parsers and loaders for curated reference datasets and
predicted/computed analysis outputs.

Each source module (mibig.py, gtdb.py, antismash.py, bigscape.py) follows
the same shape:
  parse_*()   pure function, raw external format -> a plain dataclass. No
              database access — unit-testable in isolation.
  load_*()    dataclass + Session + Source -> idempotent upsert of ORM
              objects (safe to re-run over a refreshed export).
  ingest_*()  orchestrates a batch: loops, applies any source-specific
              filtering, and never lets one bad record abort the run — see
              ingest/_util.py's IngestReport.

antismash.py and bigscape.py are linked by a real, verified join key
(antiSMASH's own per-region GenBank filename convention, stored as
`BGC.external_ref`) — see either module's docstring for the detail.
"""
