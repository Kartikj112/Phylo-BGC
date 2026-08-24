"""Publication-grade export: declarative view configs and vector rendering.

Implements the original brief's requirement that visualizations be
"reproducible via declarative configuration (JSON) and exportable to
publication-ready vector formats (SVG, PDF)."

- view_config.py — the replayable description of a figure, including
  required dataset provenance.
- renderer.py — embeds that config inside the exported SVG, adds a visible
  provenance caption, and converts to vector PDF.
"""
from bgcscape.export.renderer import (
    SvgRenderError,
    add_provenance_caption,
    embed_view_config,
    export_figure,
    extract_view_config,
    render_pdf,
)
from bgcscape.export.view_config import (
    CURRENT_CONFIG_VERSION,
    ConfigVersionError,
    DatasetProvenance,
    SourceRecord,
    TreeViewState,
    ViewConfig,
)

__all__ = [
    "CURRENT_CONFIG_VERSION",
    "ConfigVersionError",
    "DatasetProvenance",
    "SourceRecord",
    "TreeViewState",
    "ViewConfig",
    "SvgRenderError",
    "add_provenance_caption",
    "embed_view_config",
    "export_figure",
    "extract_view_config",
    "render_pdf",
]
