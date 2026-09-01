"""Phylo-BGC scientific engine.

The engine is the source of truth for Phylo-BGC's data model and (in later
phases) its ingestion and analysis pipelines. It is deliberately free of any
web/HTTP framework code — everything here should be usable from a CLI, a
notebook, or a test suite without modification. See ../../ARCHITECTURE.md.
"""

__version__ = "0.1.0"
