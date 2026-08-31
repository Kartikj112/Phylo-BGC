/**
 * Design tokens. See ARCHITECTURE.md "Phase 2" for the reasoning — ported
 * directly from web/design-prototype/tree-explorer-demo.jsx, which was
 * built and verified (rendered, unit-tested) before this production port,
 * not redesigned from scratch here.
 *
 * These duplicate the color values in tailwind.config.ts intentionally:
 * Tailwind's config isn't importable into runtime TS/TSX code (it's
 * consumed by the PostCSS build step, not bundled), and D3-computed SVG
 * fills need real color values at render time, not utility class names.
 * Keep the two in sync if either changes.
 */
export const COLORS = {
  paper: "#F7F7F4",
  card: "#FFFFFF",
  ink: "#1C1E1B",
  inkMuted: "#5B5F58",
  inkFaint: "#9A9D95",
  line: "#DEDFDA",
  lineStrong: "#C4C6BF",
  signal: "#2C5F52",
  signalWash: "#E7EEEC",
  /** Chrome — the top bar and the left filter rail. Deliberately dark:
   * see the comment in tailwind.config.ts. Kept here too because a few
   * SVG-rendered bits (the donut, inline legends) sit on chrome and need
   * the value at render time, not as a class name. */
  chrome: "#1E2A26",
  chromeSoft: "#2A3833",
  chromeLine: "#3B4A45",
  chromeLineStrong: "#56655F",
  chromeInk: "#EDF0EE",
  chromeInkMuted: "#A6B1AC",
  chromeInkFaint: "#8B9691",
  chromeAccent: "#7CD3B6",
  chromeAccentWash: "#2F4F46",
  /** ---- Figure typography -------------------------------------------
   *
   * Label colour and its halo are their own tokens rather than reuses of
   * `ink`/`paper`, following the separation a data-dense reference like
   * bklit makes between UI chrome and figure furniture: a label sitting on
   * a figure has a different job from body text on a card, and wants to be
   * tunable without dragging the interface's ink with it.
   *
   * `labelHalo` is painted as a stroke UNDER the glyph (`paint-order:
   * stroke fill`), which is what makes a name readable where it crosses a
   * branch, a clade wash or the BGC glyph track. It is the stage colour
   * rather than white, so the halo disappears into the paper instead of
   * announcing itself as a box.
   */
  label: "#1C1E1B",
  labelMuted: "#5B5F58",
  labelHalo: "#F7F7F4",
  /** Search hit. Darkened from the previous #8A6D0B, which cleared 4.5:1
   * on paper only barely, at 4.58:1. That margin is spent by the halo:
   * stroking the glyph's own outline in the stage colour thins the mark
   * optically, so a label that measured as passing stops looking it. 5.71:1
   * buys the headroom back, and this is the one label colour whose whole
   * job is to be found at a glance. */
  labelMatch: "#7A5E00",

  /** Presence-track + selected-family highlight fills. `present` is the
   * signal green at full weight; `presentSoft` backs bands and washes;
   * `absent` is the hollow-cell stroke. Kept distinct from the BGC-class
   * palette so "does this clade carry the selected family" never collides
   * with "what class are its clusters". */
  present: "#2C5F52",
  presentSoft: "#BFD6CF",
  absent: "#D8D9D3",
  /** How far non-members recede when a family is selected — a gentle step
   * back, not the near-invisible 0.15 used for hard class/search filters. */
  recedeOpacity: 0.32,
} as const;

export const BGC_CLASS_COLORS: Record<string, string> = {
  nrps: "#8B5A3C",
  pks: "#4A6FA5",
  ripp: "#7B5EA7",
  terpene: "#5B8C5A",
  siderophore: "#A67C3D",
  saccharide: "#5B9C94",
  alkaloid: "#8B4560",
  other: "#8A8D86",
};

export const BGC_CLASS_LABELS: Record<string, string> = {
  nrps: "NRPS",
  pks: "PKS",
  ripp: "RiPP",
  terpene: "Terpene",
  siderophore: "Siderophore",
  saccharide: "Saccharide",
  alkaloid: "Alkaloid",
  other: "Other",
};

export const CLASS_ORDER: string[] = Object.keys(BGC_CLASS_COLORS);

/** A hybrid BGC (e.g. "nrps+pks") renders as a split marker showing both
 * component colors rather than inventing a 9th flat hue — see tree-logic.ts
 * for the corresponding *filtering* logic, which decomposes hybrids the
 * same way (a real bug in the prototype came from doing this in only one
 * of the two places, not both — see that file's docstring). */
export function classColor(bgcClass: string, subtype: string | null | undefined): string[] {
  if (bgcClass === "hybrid" && subtype) {
    const [a, b] = subtype.toLowerCase().split("+");
    return [BGC_CLASS_COLORS[a ?? ""] ?? COLORS.inkFaint, BGC_CLASS_COLORS[b ?? ""] ?? COLORS.inkFaint];
  }
  return [BGC_CLASS_COLORS[bgcClass] ?? COLORS.inkFaint];
}


/**
 * Muted hues for the taxonomic-hierarchy background regions.
 *
 * Desaturated on purpose. These sit *behind* branches whose colour already
 * encodes BGC class, so a saturated backdrop would compete with the data
 * and start reading like a heatmap — which would be actively misleading,
 * since region colour carries no quantity at all. Colour here means only
 * "these clades are different"; depth is carried by opacity.
 */
export const CLADE_REGION_HUES: string[] = [
  "#4A6FA5",
  "#5B8C5A",
  "#8B5A3C",
  "#7B5EA7",
  "#5B9C94",
  "#A67C3D",
  "#8B4560",
  "#4F7A8B",
  "#7A6A4F",
  "#6B7F9E",
];

/**
 * Region opacity by taxonomic rank: broader clades recede, finer ones firm
 * up, so nesting is legible without any region competing with a branch, a
 * node or a label. The ceiling is deliberately low — every value here was
 * chosen to stay under the tree, not beside it.
 */
export const CLADE_REGION_OPACITY: Record<string, number> = {
  domain: 0.04,
  phylum: 0.07,
  class: 0.095,
  order: 0.12,
  family: 0.145,
  genus: 0.17,
  species: 0.19,
};

/** Stable hue for a clade, by name — so a clade keeps its colour across
 * re-renders, collapse changes and both orientations. */
export function cladeHue(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return CLADE_REGION_HUES[h % CLADE_REGION_HUES.length]!;
}
