"""Publication-ready vector rendering.

The frontend produces the SVG (it's what D3 already draws). This module
does two things the browser shouldn't be trusted with:

1. **Embeds the `ViewConfig` inside the SVG** as a `<metadata>` element,
   so the figure carries its own reproducibility record. SVG's `metadata`
   element is part of the spec and is ignored by renderers, so this
   survives round-tripping through Illustrator/Inkscape and doesn't affect
   how the figure looks.
2. **Converts SVG to PDF** via cairosvg, keeping everything vector — no
   rasterization, which is what "publication-ready" actually requires.
   Journals reject raster figures at these sizes routinely.

Doing the PDF conversion server-side rather than in the browser is
deliberate: browser print-to-PDF output varies by browser and platform and
silently rasterizes some SVG features. A deterministic pipeline is worth
more here than saving a round-trip, and it means the same figure can be
regenerated headlessly from a stored config.
"""
from __future__ import annotations

import re
import xml.etree.ElementTree as ET

from bgcscape.export.view_config import ViewConfig

SVG_NS = "http://www.w3.org/2000/svg"
BGCSCAPE_NS = "https://github.com/bgc-scape/view-config/v1"

# The exact element name used to carry the config, so extraction can find
# it again without guessing.
CONFIG_ELEMENT = "bgcscape-view-config"


class SvgRenderError(ValueError):
    pass


def embed_view_config(svg: str, config: ViewConfig) -> str:
    """Return `svg` with `config` embedded in a `<metadata>` block.

    Any existing BGC-scape config metadata is replaced rather than
    duplicated, so re-exporting an already-exported figure doesn't
    accumulate stale configs that later disagree with each other.
    """
    ET.register_namespace("", SVG_NS)
    ET.register_namespace("bgcscape", BGCSCAPE_NS)

    try:
        root = ET.fromstring(svg)
    except ET.ParseError as exc:
        raise SvgRenderError(f"Input is not parseable SVG: {exc}") from exc

    if not root.tag.endswith("svg"):
        raise SvgRenderError(f"Root element is <{root.tag}>, expected <svg>")

    metadata = root.find(f"{{{SVG_NS}}}metadata")
    if metadata is None:
        metadata = ET.Element(f"{{{SVG_NS}}}metadata")
        root.insert(0, metadata)

    for existing in metadata.findall(f"{{{BGCSCAPE_NS}}}{CONFIG_ELEMENT}"):
        metadata.remove(existing)

    config_el = ET.SubElement(metadata, f"{{{BGCSCAPE_NS}}}{CONFIG_ELEMENT}")
    config_el.text = config.model_dump_json()

    return ET.tostring(root, encoding="unicode", xml_declaration=False)


def extract_view_config(svg: str) -> ViewConfig | None:
    """Recover the `ViewConfig` from a previously-exported SVG.

    This is the payoff for embedding it: an SVG found attached to a paper
    can be asked what produced it. Returns None if the SVG carries no
    BGC-scape config (i.e. it wasn't exported by this tool).
    """
    try:
        root = ET.fromstring(svg)
    except ET.ParseError as exc:
        raise SvgRenderError(f"Input is not parseable SVG: {exc}") from exc

    element = root.find(f"{{{SVG_NS}}}metadata/{{{BGCSCAPE_NS}}}{CONFIG_ELEMENT}")
    if element is None or not element.text:
        return None
    return ViewConfig.model_validate_json(element.text)


def add_provenance_caption(svg: str, config: ViewConfig) -> str:
    """Append a visible provenance footer to the figure.

    The embedded metadata is machine-readable but invisible; a figure
    reproduced in print needs the provenance *visible*, because that's the
    form most readers actually encounter. The SVG's height and viewBox are
    both extended so the caption isn't clipped — modifying one without the
    other silently crops it, which is the obvious failure mode here.
    """
    ET.register_namespace("", SVG_NS)
    try:
        root = ET.fromstring(svg)
    except ET.ParseError as exc:
        raise SvgRenderError(f"Input is not parseable SVG: {exc}") from exc

    caption_height = 34
    width, height = _svg_dimensions(root)
    new_height = height + caption_height

    root.set("height", str(new_height))
    view_box = root.get("viewBox")
    if view_box:
        parts = view_box.replace(",", " ").split()
        if len(parts) == 4:
            min_x, min_y, vb_w, vb_h = (float(p) for p in parts)
            root.set("viewBox", f"{min_x} {min_y} {vb_w} {vb_h + caption_height}")

    group = ET.SubElement(root, f"{{{SVG_NS}}}g")
    group.set("transform", f"translate(0,{height})")

    rule = ET.SubElement(group, f"{{{SVG_NS}}}line")
    rule.set("x1", "0")
    rule.set("y1", "8")
    rule.set("x2", str(width))
    rule.set("y2", "8")
    rule.set("stroke", "#DEDFDA")
    rule.set("stroke-width", "1")

    text = ET.SubElement(group, f"{{{SVG_NS}}}text")
    text.set("x", "0")
    text.set("y", "24")
    text.set("font-family", "IBM Plex Mono, ui-monospace, monospace")
    text.set("font-size", "9")
    text.set("fill", "#5B5F58")
    text.text = config.provenance_caption()

    return ET.tostring(root, encoding="unicode", xml_declaration=False)


def _svg_dimensions(root: ET.Element) -> tuple[float, float]:
    """Pixel width/height, preferring viewBox.

    viewBox wins over the width/height attributes because the frontend
    renders with `width="100%"` for responsive layout — reading that
    attribute literally would yield a nonsense caption position. Percentage
    values are therefore ignored rather than coerced.
    """
    view_box = root.get("viewBox")
    if view_box:
        parts = view_box.replace(",", " ").split()
        if len(parts) == 4:
            return float(parts[2]), float(parts[3])

    width = _parse_length(root.get("width"))
    height = _parse_length(root.get("height"))
    if width is None or height is None:
        raise SvgRenderError("SVG has neither a usable viewBox nor absolute width/height")
    return width, height


def _parse_length(value: str | None) -> float | None:
    if not value or value.strip().endswith("%"):
        return None
    match = re.match(r"^\s*([0-9.]+)", value)
    return float(match.group(1)) if match else None


def render_pdf(svg: str) -> bytes:
    """Convert SVG to vector PDF.

    cairosvg is imported lazily so the rest of the engine — including all
    ingestion and the API — keeps working without the Cairo system
    libraries installed, which are a heavier dependency than everything
    else here combined.
    """
    try:
        import cairosvg
    except ImportError as exc:  # pragma: no cover - environment-dependent
        raise SvgRenderError(
            "PDF export needs cairosvg and its Cairo system libraries: pip install 'bgcscape[export]'"
        ) from exc

    return cairosvg.svg2pdf(bytestring=svg.encode("utf-8"))


def export_figure(svg: str, config: ViewConfig, *, with_caption: bool = True) -> tuple[str, bytes]:
    """The full export path: caption, embed config, render PDF.

    Returns `(svg_with_metadata, pdf_bytes)` — both, because the SVG is the
    editable vector master a figure-preparation workflow actually wants,
    while the PDF is what most journals ask for at submission.
    """
    rendered = add_provenance_caption(svg, config) if with_caption else svg
    rendered = embed_view_config(rendered, config)
    return rendered, render_pdf(rendered)
