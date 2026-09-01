"""Read-only HTTP API over the Phylo-BGC engine.

Deliberately separate from bgcscape.schemas (the engine's general data
contracts, used by ingestion): these are UI-shaped aggregate views built
specifically for the tree/BGC-overlay visualization (e.g. a taxon node
with genome/BGC counts rolled up from every descendant), not 1:1 mirrors
of ORM tables. Requires the `api` extra (`pip install -e ".[api]"`).
"""
