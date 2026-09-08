"""Tests for publication export: view-config reproducibility, SVG
metadata round-tripping, caption geometry, and real PDF output.
"""
from __future__ import annotations

import uuid
import xml.etree.ElementTree as ET

import pytest

from tests.conftest import requires_pdf_renderer
from pydantic import ValidationError

from bgcscape.export import (
    CURRENT_CONFIG_VERSION,
    ConfigVersionError,
    DatasetProvenance,
    SourceRecord,
    SvgRenderError,
    TreeViewState,
    ViewConfig,
    add_provenance_caption,
    embed_view_config,
    export_figure,
    extract_view_config,
    render_pdf,
)

SVG_NS = "http://www.w3.org/2000/svg"

SAMPLE_SVG = (
    '<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="400" viewBox="0 0 900 400">'
    '<g transform="translate(30,20)">'
    '<circle r="4.5" fill="#F7F7F4" stroke="#1C1E1B"/>'
    '<text x="-9" font-size="12" fill="#1C1E1B">Streptomyces</text>'
    '<rect x="132" y="-5" width="7" height="10" fill="#8B5A3C"/>'
    "</g></svg>"
)


def _dataset() -> DatasetProvenance:
    return DatasetProvenance(
        sources=[
            SourceRecord(name="GTDB", version="R11-RS232", source_type="reference_database", license="CC-BY-SA-4.0"),
            SourceRecord(name="antiSMASH", version="7.1.0", source_type="tool_run"),
        ],
        genome_count=5,
        bgc_count=12,
        taxon_count=9,
        family_count=2,
        engine_version="0.1.0",
    )


def _config(**overrides) -> ViewConfig:
    base = {"dataset": _dataset(), "title": "Figure 3"}
    base.update(overrides)
    return ViewConfig(**base)


# --- view config: the reproducibility contract -----------------------------------


def test_dataset_provenance_is_required():
    """A config recording filters but not which data versions produced the
    figure would be reproducible in appearance only."""
    with pytest.raises(ValidationError):
        ViewConfig(title="No provenance")


def test_config_round_trips_through_json():
    original = _config(
        tree_state=TreeViewState(
            collapsed_node_ids=["taxon-a", "taxon-b"],
            active_bgc_classes=["nrps", "pks"],
            selected_family_id=uuid.uuid4(),
            comparison_taxon_ids=[uuid.uuid4(), uuid.uuid4()],
            search_query="Streptomyces",
        )
    )
    restored = ViewConfig.model_validate_json(original.model_dump_json())

    assert restored.tree_state.collapsed_node_ids == original.tree_state.collapsed_node_ids
    assert restored.tree_state.active_bgc_classes == ["nrps", "pks"]
    assert restored.tree_state.selected_family_id == original.tree_state.selected_family_id
    assert restored.tree_state.comparison_taxon_ids == original.tree_state.comparison_taxon_ids
    assert restored.tree_state.search_query == "Streptomyces"
    assert restored.dataset.genome_count == 5


def test_future_config_version_is_rejected_not_partially_applied():
    payload = _config().model_dump()
    payload["config_version"] = CURRENT_CONFIG_VERSION + 1
    with pytest.raises((ConfigVersionError, ValidationError)):
        ViewConfig.model_validate(payload)


def test_invalid_config_version_is_rejected():
    payload = _config().model_dump()
    payload["config_version"] = 0
    with pytest.raises((ConfigVersionError, ValidationError)):
        ViewConfig.model_validate(payload)


def test_provenance_caption_names_data_sources_not_just_the_tool():
    caption = _config().provenance_caption()
    assert "GTDB R11-RS232" in caption
    assert "antiSMASH 7.1.0" in caption
    assert "5 genomes" in caption
    assert "12 BGCs" in caption
    assert "Phylo-BGC 0.1.0" in caption


# --- SVG metadata embedding -------------------------------------------------------


def test_embed_then_extract_recovers_the_config():
    config = _config(tree_state=TreeViewState(active_bgc_classes=["ripp"]))
    svg = embed_view_config(SAMPLE_SVG, config)
    recovered = extract_view_config(svg)

    assert recovered is not None
    assert recovered.tree_state.active_bgc_classes == ["ripp"]
    assert recovered.dataset.genome_count == 5
    assert recovered.title == "Figure 3"


def test_extract_returns_none_for_a_foreign_svg():
    assert extract_view_config(SAMPLE_SVG) is None


def test_re_embedding_replaces_rather_than_duplicates():
    """Re-exporting an already-exported figure must not accumulate stale
    configs that later disagree with each other."""
    first = embed_view_config(SAMPLE_SVG, _config(title="First"))
    second = embed_view_config(first, _config(title="Second"))

    root = ET.fromstring(second)
    metadata = root.find(f"{{{SVG_NS}}}metadata")
    assert metadata is not None
    configs = [child for child in metadata if child.tag.endswith("bgcscape-view-config")]
    assert len(configs) == 1
    assert extract_view_config(second).title == "Second"


def test_embedded_metadata_does_not_disturb_the_drawing():
    svg = embed_view_config(SAMPLE_SVG, _config())
    root = ET.fromstring(svg)
    # The original drawing group must still be present and unchanged.
    groups = root.findall(f"{{{SVG_NS}}}g")
    assert len(groups) == 1
    assert groups[0].get("transform") == "translate(30,20)"
    assert root.find(f".//{{{SVG_NS}}}circle") is not None


def test_embed_rejects_non_svg_input():
    with pytest.raises(SvgRenderError):
        embed_view_config("<html><body>not svg</body></html>", _config())

    with pytest.raises(SvgRenderError):
        embed_view_config("this is not xml at all <<<", _config())


# --- caption geometry -------------------------------------------------------------


def test_caption_extends_both_height_and_viewbox():
    """Extending one without the other silently crops the caption — the
    obvious failure mode, so it gets an explicit test."""
    svg = add_provenance_caption(SAMPLE_SVG, _config())
    root = ET.fromstring(svg)

    assert float(root.get("height")) > 400
    view_box = root.get("viewBox").split()
    assert float(view_box[3]) > 400
    # Both must grow by the same amount, or the caption lands off-centre.
    assert float(root.get("height")) - 400 == pytest.approx(float(view_box[3]) - 400)


def test_caption_text_is_present_and_positioned_below_the_figure():
    svg = add_provenance_caption(SAMPLE_SVG, _config())
    root = ET.fromstring(svg)

    captions = [t for t in root.iter(f"{{{SVG_NS}}}text") if t.text and "Phylo-BGC" in t.text]
    assert len(captions) == 1
    group = root.findall(f"{{{SVG_NS}}}g")[-1]
    assert group.get("transform") == "translate(0,400.0)"


def test_caption_uses_viewbox_not_the_percentage_width():
    """The frontend renders width="100%" for responsive layout; reading
    that literally would put the caption rule at 100 units wide."""
    svg = add_provenance_caption(SAMPLE_SVG, _config())
    root = ET.fromstring(svg)
    line = root.find(f".//{{{SVG_NS}}}line")
    assert float(line.get("x2")) == pytest.approx(900.0)


def test_caption_fails_loudly_without_usable_dimensions():
    bad = '<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="50%"></svg>'
    with pytest.raises(SvgRenderError, match="viewBox"):
        add_provenance_caption(bad, _config())


# --- real PDF output --------------------------------------------------------------




@requires_pdf_renderer
def test_render_pdf_produces_a_real_pdf():
    pdf = render_pdf(SAMPLE_SVG)
    assert pdf.startswith(b"%PDF")
    assert len(pdf) > 500


@requires_pdf_renderer
def test_export_figure_returns_both_svg_and_pdf():
    svg, pdf = export_figure(SAMPLE_SVG, _config())

    assert pdf.startswith(b"%PDF")
    # The returned SVG is the editable vector master, and must itself
    # carry both the caption and the recoverable config.
    assert "Phylo-BGC" in svg
    assert extract_view_config(svg) is not None


@requires_pdf_renderer
def test_exported_pdf_is_vector_not_rasterized():
    """Journals reject raster figures at these sizes. A rasterized
    conversion would embed an /Image XObject; a vector one won't."""
    _, pdf = export_figure(SAMPLE_SVG, _config())
    assert b"/Subtype /Image" not in pdf
    assert b"/Subtype/Image" not in pdf


# --- hostile SVG: /api/v1/export takes this from anyone --------------------


BILLION_LAUGHS = """<?xml version="1.0"?>
<!DOCTYPE svg [
 <!ENTITY a "AAAAAAAAAA">
 <!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">
 <!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">
 <!ENTITY d "&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;">
]>
<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><text>&d;</text></svg>"""


@pytest.mark.parametrize(
    "render",
    [
        lambda svg: embed_view_config(svg, _config()),
        lambda svg: add_provenance_caption(svg, _config()),
        extract_view_config,
    ],
    ids=["embed", "caption", "extract"],
)
def test_entity_expansion_is_refused_on_every_svg_entry_point(render):
    """A 359-byte document must not become a megabyte in memory.

    Every one of these three parses an SVG that arrived from the browser, and
    all three ran on the stdlib parser, which honours internal entity
    declarations. Parametrised rather than written once because the guard has
    to live in the shared parser — a fix applied to `embed_view_config` alone
    would leave the other two open, which is how this class of bug returns.
    """
    with pytest.raises(SvgRenderError):
        render(BILLION_LAUGHS)


def test_oversized_svg_is_refused_before_parsing():
    """The size ceiling exists so a hostile body is never built into a tree."""
    from bgcscape.export.renderer import MAX_SVG_BYTES

    padding = "x" * (MAX_SVG_BYTES + 1)
    huge = f'<svg xmlns="{SVG_NS}" width="10" height="10"><desc>{padding}</desc></svg>'

    with pytest.raises(SvgRenderError, match="limit"):
        embed_view_config(huge, _config())


def test_a_normal_figure_is_still_well_under_the_ceiling():
    """Guards the ceiling against being set below real usage."""
    from bgcscape.export.renderer import MAX_SVG_BYTES

    assert MAX_SVG_BYTES > 4 * 1024 * 1024
