"""Declarative view configuration — the reproducibility layer.

The original brief requires that "visualizations must be reproducible via
declarative configuration (JSON) and exportable to publication-ready
vector formats." This module is the first half of that: a versioned,
validated description of *everything* that determines what a figure shows,
so a published figure can be regenerated rather than merely re-drawn from
memory.

## Why this is a scientific artifact, not a UI convenience

A figure in a paper makes a claim. Six months later, a reviewer asks
"which BGC classes were filtered out of Figure 3, and which GTDB release
was that?" Without a machine-readable record, the honest answer is usually
"I don't remember." A `ViewConfig` embedded in the exported SVG means the
figure carries its own answer.

That's also why `dataset` provenance is **required**, not optional. A view
config that records the filters but not which MIBiG/GTDB/antiSMASH
versions produced the underlying data would be reproducible in appearance
only — the same filters over a newer GTDB release is a different figure
making a different claim.

## Versioning

`config_version` is checked on load. A config written by a future version
is rejected rather than silently partially-applied, because a filter this
version doesn't understand means the regenerated figure would differ from
the published one in exactly the way this module exists to prevent.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel, Field, field_validator

# Bump when a change would make an older config render differently, not
# merely when fields are added. Additive, backward-compatible fields don't
# need a bump; a change in how an existing field is interpreted does.
CURRENT_CONFIG_VERSION = 1


class ConfigVersionError(ValueError):
    """The config was written by an incompatible version of Phylo-BGC."""


class SourceRecord(BaseModel):
    """One data source as it stood when the figure was made."""

    name: str
    version: str | None = None
    source_type: str
    license: str | None = None


class DatasetProvenance(BaseModel):
    """What the figure was drawn from. Required — see module docstring."""

    sources: list[SourceRecord]
    genome_count: int
    bgc_count: int
    taxon_count: int
    family_count: int
    exported_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    engine_version: str


class TreeViewState(BaseModel):
    """Everything about the tree that changes what's visible."""

    collapsed_node_ids: list[str] = []
    active_bgc_classes: list[str] = []
    """Empty means no class filter was applied (all shown). Recorded
    explicitly rather than inferred, so 'all classes' and 'happened to
    select every class' stay distinguishable."""
    selected_family_id: uuid.UUID | None = None
    comparison_taxon_ids: list[uuid.UUID] = []
    search_query: str = ""


class ViewConfig(BaseModel):
    """A complete, replayable description of one Phylo-BGC view."""

    config_version: int = CURRENT_CONFIG_VERSION
    view_type: Literal["taxonomy_tree", "clade_comparison"] = "taxonomy_tree"
    title: str | None = None
    caption: str | None = None
    tree_state: TreeViewState = Field(default_factory=TreeViewState)
    dataset: DatasetProvenance

    @field_validator("config_version")
    @classmethod
    def _check_version(cls, value: int) -> int:
        if value > CURRENT_CONFIG_VERSION:
            raise ConfigVersionError(
                f"This view config was written by a newer Phylo-BGC (config_version={value}; "
                f"this build understands up to {CURRENT_CONFIG_VERSION}). Refusing to load it "
                "partially, since a filter this version doesn't understand would silently change "
                "what the regenerated figure shows."
            )
        if value < 1:
            raise ConfigVersionError(f"Invalid config_version: {value}")
        return value

    def provenance_caption(self) -> str:
        """A human-readable one-liner for the figure footer.

        Deliberately states the *data* provenance, not just the tool
        version — 'made with Phylo-BGC 0.1.0' tells a reader nothing about
        whether they'd get the same figure.
        """
        source_bits = [f"{s.name} {s.version}" if s.version else s.name for s in self.dataset.sources]
        sources = "; ".join(sorted(source_bits)) if source_bits else "no sources recorded"
        stamp = self.dataset.exported_at.strftime("%Y-%m-%d")
        return (
            f"Phylo-BGC {self.dataset.engine_version} · {stamp} · "
            f"{self.dataset.genome_count} genomes, {self.dataset.bgc_count} BGCs · "
            f"Sources: {sources}"
        )
