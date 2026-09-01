/**
 * Export helpers — pure functions, unit-tested (see export.test.ts).
 *
 * The scientific point of export here is *reproducibility*: a published
 * figure should carry enough information to be regenerated. The engine
 * owns the schema and the PDF rendering (see
 * engine/src/bgcscape/export/); this module's job is to capture the live
 * view state accurately and hand the browser's SVG over in a form that
 * survives leaving the browser.
 */
import type { DatasetProvenanceResponse } from "./api-types";

export interface TreeViewState {
  collapsed_node_ids: string[];
  active_bgc_classes: string[];
  selected_family_id: string | null;
  comparison_taxon_ids: string[];
  search_query: string;
}

export interface ViewConfigPayload {
  config_version: number;
  view_type: "taxonomy_tree" | "clade_comparison";
  title: string | null;
  caption: string | null;
  tree_state: TreeViewState;
  dataset: {
    sources: { name: string; version: string | null; source_type: string; license: string | null }[];
    genome_count: number;
    bgc_count: number;
    taxon_count: number;
    family_count: number;
    engine_version: string;
  };
}

export const CONFIG_VERSION = 1;

export interface BuildConfigArgs {
  provenance: DatasetProvenanceResponse;
  collapsed: ReadonlySet<string>;
  activeClasses: ReadonlySet<string>;
  allClasses: readonly string[];
  selectedFamilyId: string | null;
  comparisonTaxonIds: readonly string[];
  searchQuery: string;
  title?: string | null;
}

export function buildViewConfig({
  provenance,
  collapsed,
  activeClasses,
  allClasses,
  selectedFamilyId,
  comparisonTaxonIds,
  searchQuery,
  title = null,
}: BuildConfigArgs): ViewConfigPayload {
  // "Every class selected" is recorded as an empty filter list, matching
  // the engine's TreeViewState contract: an empty list means "no filter
  // was applied", which is what selecting everything actually means. The
  // UI's default state is all-selected, so recording all eight class
  // names would make every default export look deliberately filtered.
  const noFilterApplied = activeClasses.size === allClasses.length;

  return {
    config_version: CONFIG_VERSION,
    view_type: comparisonTaxonIds.length >= 2 ? "clade_comparison" : "taxonomy_tree",
    title,
    caption: null,
    tree_state: {
      collapsed_node_ids: [...collapsed].sort(),
      active_bgc_classes: noFilterApplied ? [] : [...activeClasses].sort(),
      selected_family_id: selectedFamilyId,
      comparison_taxon_ids: [...comparisonTaxonIds],
      search_query: searchQuery,
    },
    dataset: {
      sources: provenance.sources.map((s) => ({
        name: s.name,
        version: s.version ?? null,
        source_type: s.source_type,
        license: s.license ?? null,
      })),
      genome_count: provenance.genome_count,
      bgc_count: provenance.bgc_count,
      taxon_count: provenance.taxon_count,
      family_count: provenance.family_count,
      engine_version: provenance.engine_version,
    },
  };
}

/** Fonts referenced by the tree, needed once the SVG leaves the page. */
const EXPORT_FONT_STACK = "IBM Plex Sans, system-ui, sans-serif";
const EXPORT_MONO_STACK = "IBM Plex Mono, ui-monospace, monospace";

/**
 * Serialize a live `<svg>` element into a standalone document.
 *
 * The tree is styled by Tailwind classes and CSS custom properties, which
 * exist only in the page's stylesheet — an SVG lifted straight out of the
 * DOM loses all of it and renders as unstyled black text in any other
 * program. This walks the tree and writes computed font properties onto
 * the elements themselves.
 *
 * Only font properties are inlined, not every computed style: `fill` and
 * `stroke` are already set as SVG attributes by the D3 rendering code
 * (see TreeCanvas.tsx), and copying the browser's full computed style
 * would bloat the file with hundreds of irrelevant declarations per node.
 */
export function serializeSvgForExport(source: SVGSVGElement): string {
  const clone = source.cloneNode(true) as SVGSVGElement;

  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");

  // The on-screen SVG fills the viewport and is navigated by pan/zoom, so
  // its viewBox is the container size and its content sits under a
  // translate/scale. For export we want the figure itself, tightly framed
  // and in its own coordinates: crop the viewBox to the drawing's bounding
  // box and neutralise the pan/zoom transform. Falls back to copying the
  // viewBox when the figure marker or getBBox isn't available (e.g. the
  // unit-test DOM), which keeps older behaviour byte-for-byte.
  let framed = false;
  try {
    const srcFigure = source.querySelector("[data-figure-root]");
    const cloneFigure = clone.querySelector("[data-figure-root]");
    if (
      srcFigure &&
      cloneFigure &&
      typeof (srcFigure as SVGGraphicsElement).getBBox === "function"
    ) {
      const bb = (srcFigure as SVGGraphicsElement).getBBox();
      if (bb && bb.width > 0 && bb.height > 0) {
        const t = /translate\(\s*(-?[\d.]+)[\s,]+(-?[\d.]+)\s*\)/.exec(
          cloneFigure.getAttribute("transform") ?? "",
        );
        const ox = t ? parseFloat(t[1]!) : 0;
        const oy = t ? parseFloat(t[2]!) : 0;
        const pad = 24;
        const x = bb.x + ox - pad;
        const y = bb.y + oy - pad;
        const w = bb.width + pad * 2;
        const h = bb.height + pad * 2;
        clone.setAttribute("viewBox", `${x} ${y} ${w} ${h}`);
        clone.setAttribute("width", String(Math.round(w)));
        clone.setAttribute("height", String(Math.round(h)));
        clone.querySelector("[data-canvas-bg]")?.remove();
        const zoomLayer = clone.querySelector("g");
        zoomLayer?.setAttribute("transform", "translate(0,0) scale(1)");
        framed = true;
      }
    }
  } catch {
    /* fall through to the viewBox copy below */
  }

  if (!framed) {
    // A responsive width="100%" is meaningless outside the page; the
    // viewBox carries the real dimensions, so pin width/height to it.
    const viewBox = clone.getAttribute("viewBox");
    if (viewBox) {
      const parts = viewBox.split(/[\s,]+/);
      if (parts.length === 4) {
        clone.setAttribute("width", String(parts[2]));
        clone.setAttribute("height", String(parts[3]));
      }
    }
  }

  clone.style.backgroundColor = "#FFFFFF";

  const sourceNodes = source.querySelectorAll("text");
  const clonedNodes = clone.querySelectorAll("text");
  sourceNodes.forEach((node, index) => {
    const target = clonedNodes[index];
    if (!target) return;
    const isMono = node.classList.contains("font-mono");
    target.removeAttribute("class");
    target.setAttribute("font-family", isMono ? EXPORT_MONO_STACK : EXPORT_FONT_STACK);
    if (!target.getAttribute("font-size")) {
      target.setAttribute("font-size", "12");
    }
  });

  // Tailwind classes on non-text nodes (e.g. cursor-pointer) mean nothing
  // in an exported file and only add noise.
  clone.querySelectorAll("[class]").forEach((el) => el.removeAttribute("class"));

  return new XMLSerializer().serializeToString(clone);
}

/** Filename stem for a figure, safe across filesystems. */
export function figureFilename(title: string | null, format: "svg" | "pdf"): string {
  const base = (title ?? "phylo-bgc-figure")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${base || "phylo-bgc-figure"}.${format}`;
}
