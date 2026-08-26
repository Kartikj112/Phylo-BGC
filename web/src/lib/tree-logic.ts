/**
 * Pure tree/filtering logic — no React, no DOM. Ported from
 * web/design-prototype/tree-explorer-demo.jsx (already built and verified
 * there — real Babel transpile, real react-dom/server render, targeted
 * logic tests) rather than designed fresh here. See tree-logic.test.ts.
 *
 * One deliberate architecture improvement over the prototype: instead of
 * pre-pruning the tree into a new collapsed-aware copy before handing it
 * to d3.hierarchy(), this passes a *children-accessor function* that
 * itself checks collapse state — d3.hierarchy(root, accessor) is built
 * for exactly this. Simpler, and avoids re-deriving a parallel "pruned
 * tree" data shape on every collapse toggle.
 */
import * as d3 from "d3";
import type { BGCSummary, DisplayNode, GenomeDisplayNode, TaxonDisplayNode, TaxonTreeNode } from "./api-types";

export function toRootDisplayNode(tree: TaxonTreeNode): TaxonDisplayNode {
  return { ...tree, _kind: "taxon" };
}

/** Stable identity for Sets (collapsed, selected, ...): TaxonTreeNode.id
 * is `string | null` (null only for the synthetic API root), while
 * GenomeSummary.id is always a real UUID. Never use `node.id` directly in
 * a Set/Map key — always go through this. */
export function nodeKey(node: DisplayNode): string {
  return node.id ?? "__root__";
}

export function nodeLabel(node: DisplayNode): string {
  return node._kind === "genome" ? node.accession : node.name;
}

export function toDisplayChildren(node: DisplayNode): DisplayNode[] | null {
  if (node._kind === "genome") return null;
  const childTaxa: TaxonDisplayNode[] = node.children.map((c) => ({ ...c, _kind: "taxon" as const }));
  const childGenomes: GenomeDisplayNode[] = node.direct_genomes.map((g) => ({ ...g, _kind: "genome" as const }));
  const combined: DisplayNode[] = [...childTaxa, ...childGenomes];
  return combined.length ? combined : null;
}

export function makeChildrenAccessor(collapsed: ReadonlySet<string>) {
  return (node: DisplayNode): DisplayNode[] | null => {
    if (collapsed.has(nodeKey(node))) return null;
    return toDisplayChildren(node);
  };
}

export function hiddenChildrenCount(node: DisplayNode, collapsed: ReadonlySet<string>): number {
  if (!collapsed.has(nodeKey(node))) return 0;
  return toDisplayChildren(node)?.length ?? 0;
}

export function matchesQuery(node: DisplayNode, query: string): boolean {
  const trimmed = query.trim();
  if (!trimmed) return false;
  return nodeLabel(node).toLowerCase().includes(trimmed.toLowerCase());
}

/**
 * A hybrid BGC's "class" for filtering/counting purposes is its component
 * classes (e.g. "nrps+pks" -> ["nrps", "pks"]), not the literal string
 * "hybrid" — "hybrid" isn't a real filter option (see colors.ts'
 * CLASS_ORDER). Centralizing this in one place is the fix for a real bug
 * caught while verifying the prototype: the class-count panel decomposed
 * hybrids correctly but the tree's dimming check compared against the
 * literal (never-matching) string "hybrid", so a genome whose only NRPS
 * activity came from a hybrid BGC was wrongly dimmed when filtering to
 * NRPS-only. Every caller that needs to know "does this BGC count as
 * class X" goes through this function now, not an inline check.
 */
export function bgcComponentClasses(bgc: BGCSummary): string[] {
  if (bgc.bgc_class === "hybrid" && bgc.subtype) return bgc.subtype.split("+");
  return [bgc.bgc_class];
}

export function bgcMatchesActiveClasses(bgc: BGCSummary, activeClasses: ReadonlySet<string>): boolean {
  return bgcComponentClasses(bgc).some((c) => activeClasses.has(c));
}

export function genomeMatchesActiveClasses(genome: GenomeDisplayNode, activeClasses: ReadonlySet<string>): boolean {
  return genome.bgcs.some((b) => bgcMatchesActiveClasses(b, activeClasses));
}

/**
 * Family highlighting: given a selected family id, which BGCs belong to
 * it. Kept as pure predicates here (rather than inline in the D3
 * component) for the same reason the class-filtering logic is —
 * hybrid-class filtering was a real bug precisely because the same
 * decision was made in two places that then drifted apart.
 */
export function bgcInFamily(bgc: BGCSummary, familyId: string | null): boolean {
  if (!familyId) return false;
  return bgc.family_ids.includes(familyId);
}

export function genomeHasFamily(genome: GenomeDisplayNode, familyId: string | null): boolean {
  if (!familyId) return false;
  return genome.bgcs.some((b) => bgcInFamily(b, familyId));
}

/**
 * Whether any genome at or below this node carries a member of the given
 * family. Drives the "which parts of the tree does this family reach"
 * highlight — the report's core distribution question ("is this family
 * confined to one clade, or scattered across distant organisms?").
 */
export function nodeHasFamily(node: DisplayNode, familyId: string | null): boolean {
  if (!familyId) return false;
  if (node._kind === "genome") return genomeHasFamily(node, familyId);
  if (node.direct_genomes.some((g) => genomeHasFamily({ ...g, _kind: "genome" }, familyId))) return true;
  return node.children.some((c) => nodeHasFamily({ ...c, _kind: "taxon" }, familyId));
}

/** All component BGC classes reachable from this node (any depth) —
 * used to decide whether an internal taxon node should be dimmed when a
 * filter is active but none of its descendants match. */
export function nodeVisibleClasses(node: DisplayNode): Set<string> {
  if (node._kind === "genome") {
    return new Set(node.bgcs.flatMap(bgcComponentClasses));
  }
  const set = new Set<string>();
  for (const g of node.direct_genomes) {
    for (const c of nodeVisibleClasses({ ...g, _kind: "genome" })) set.add(c);
  }
  for (const child of node.children) {
    for (const c of nodeVisibleClasses({ ...child, _kind: "taxon" })) set.add(c);
  }
  return set;
}

export function countBgcClasses(root: TaxonDisplayNode): Record<string, number> {
  const counts: Record<string, number> = {};
  function walk(node: DisplayNode): void {
    if (node._kind === "genome") {
      for (const bgc of node.bgcs) {
        for (const cls of bgcComponentClasses(bgc)) {
          counts[cls] = (counts[cls] ?? 0) + 1;
        }
      }
      return;
    }
    node.direct_genomes.forEach((g) => walk({ ...g, _kind: "genome" }));
    node.children.forEach((c) => walk({ ...c, _kind: "taxon" }));
  }
  walk(root);
  return counts;
}

export function countTotalGenomes(root: TaxonDisplayNode): number {
  return root.genome_count;
}

export interface TreeLayout {
  nodes: d3.HierarchyPointNode<DisplayNode>[];
  links: d3.HierarchyPointLink<DisplayNode>[];
  height: number;
}

const MIN_ROW_HEIGHT = 34;
const MIN_TREE_HEIGHT = 200;
const HEIGHT_MARGIN = 40;

export function computeTreeLayout(root: TaxonDisplayNode, collapsed: ReadonlySet<string>, width: number): TreeLayout {
  const hierarchy = d3.hierarchy<DisplayNode>(root, makeChildrenAccessor(collapsed));
  const leafCount = Math.max(hierarchy.leaves().length, 1);
  const innerHeight = Math.max(leafCount * MIN_ROW_HEIGHT, MIN_TREE_HEIGHT);

  const layout = d3
    .tree<DisplayNode>()
    .size([innerHeight, width])
    .separation((a, b) => (a.parent === b.parent ? 1 : 1.4));
  const positioned = layout(hierarchy);

  return {
    nodes: positioned.descendants(),
    links: positioned.links(),
    height: innerHeight + HEIGHT_MARGIN,
  };
}

/**
 * Search support.
 *
 * The first implementation only recolored matching labels, which failed
 * three ways at realistic scale: the highlight colour (signal teal) sits
 * too close to body ink to read at 12px; a match inside a collapsed node
 * isn't rendered at all; and with ~150 nodes a match is usually off the
 * visible scroll. The result looked completely inert even when it was
 * working. These helpers fix the first two structurally — the third is a
 * rendering concern (dimming non-matches so the eye finds them).
 */
export function collectMatchKeys(root: TaxonDisplayNode, query: string): Set<string> {
  const matches = new Set<string>();
  if (!query.trim()) return matches;

  function walk(node: DisplayNode): void {
    if (matchesQuery(node, query)) matches.add(nodeKey(node));
    if (node._kind === "genome") return;
    node.direct_genomes.forEach((g) => walk({ ...g, _kind: "genome" }));
    node.children.forEach((c) => walk({ ...c, _kind: "taxon" }));
  }
  walk(root);
  return matches;
}

/** Keys of every ancestor of a match, so the path to it can be forced
 * open. Without this, searching for something inside a collapsed clade
 * silently finds nothing. */
export function ancestorsOfMatches(root: TaxonDisplayNode, query: string): Set<string> {
  const needed = new Set<string>();
  if (!query.trim()) return needed;

  function walk(node: DisplayNode, path: string[]): boolean {
    const selfMatches = matchesQuery(node, query);
    let descendantMatches = false;

    if (node._kind === "taxon") {
      const nextPath = [...path, nodeKey(node)];
      for (const g of node.direct_genomes) {
        if (walk({ ...g, _kind: "genome" }, nextPath)) descendantMatches = true;
      }
      for (const c of node.children) {
        if (walk({ ...c, _kind: "taxon" }, nextPath)) descendantMatches = true;
      }
    }

    if (selfMatches || descendantMatches) {
      path.forEach((key) => needed.add(key));
    }
    return selfMatches || descendantMatches;
  }

  walk(root, []);
  return needed;
}

/** Collapse state with the paths to search matches forced open. */
export function effectiveCollapsed(
  root: TaxonDisplayNode,
  collapsed: ReadonlySet<string>,
  query: string,
): Set<string> {
  if (!query.trim()) return new Set(collapsed);
  const mustOpen = ancestorsOfMatches(root, query);
  return new Set([...collapsed].filter((key) => !mustOpen.has(key)));
}

/** Whether a node is a match or contains one — used to keep whole
 * branches visible rather than dimming the context around a hit. */
export function nodeMatchesOrContains(node: DisplayNode, query: string): boolean {
  if (!query.trim()) return false;
  if (matchesQuery(node, query)) return true;
  if (node._kind === "genome") return false;
  return (
    node.direct_genomes.some((g) => matchesQuery({ ...g, _kind: "genome" }, query)) ||
    node.children.some((c) => nodeMatchesOrContains({ ...c, _kind: "taxon" }, query))
  );
}

/**
 * Branch weighting.
 *
 * Every branch was a 1.25px hairline carrying no information, which is
 * the main reason the tree read as thin and diagrammatic rather than as a
 * data figure. Scaling stroke width by the BGC count in the subtree a
 * branch leads to makes the tree's visual mass *be* the biosynthetic
 * signal — thick branches lead somewhere biosynthetically rich.
 *
 * Deliberately NOT a Sankey: a real Sankey needs conserved flow, and
 * ribbon widths on a phylogeny would compete with branch length for the
 * same visual channel. This keeps the tree a tree and adds one honest
 * encoding on top. (The root → phylum → class flow IS conserved and would
 * make a legitimate Sankey — but as a separate view, not grafted onto
 * ancestry.)
 *
 * Uses a sqrt scale, not linear: BGC counts span roughly two orders of
 * magnitude across a real corpus, and a linear map makes the trunk a slab
 * while every tip vanishes. sqrt keeps small clades legible while the
 * ordering still reads correctly.
 */
export const MIN_BRANCH_WIDTH = 1;
export const MAX_BRANCH_WIDTH = 11;

export function subtreeBgcCount(node: DisplayNode): number {
  if (node._kind === "genome") return node.bgcs.length;
  // Taxon nodes already carry rolled-up counts from the API, so this
  // avoids re-walking the whole subtree per branch on every render.
  return Object.values(node.bgc_class_counts).reduce((sum, n) => sum + n, 0);
}

export function branchWidth(node: DisplayNode, maxCount: number): number {
  const count = subtreeBgcCount(node);
  if (count <= 0 || maxCount <= 0) return MIN_BRANCH_WIDTH;
  // Clamped, not merely scaled. Without this the width is unbounded
  // whenever a node's count exceeds `maxCount` — which happens if a
  // caller passes a stale or wrongly-scoped max, and produced a 27px
  // branch in testing. A rendering bug that draws a slab across the
  // figure is worth making structurally impossible rather than relying
  // on callers to pass the right maximum.
  const scaled = Math.min(1, Math.sqrt(count) / Math.sqrt(maxCount));
  return MIN_BRANCH_WIDTH + scaled * (MAX_BRANCH_WIDTH - MIN_BRANCH_WIDTH);
}

/** The BGC class contributing most to a subtree, for branch tinting.
 * Returns null on ties or when empty — a tinted branch should mean
 * something, and "no clear dominant class" is a real answer. */
export function dominantBgcClass(node: DisplayNode): string | null {
  const counts: Record<string, number> =
    node._kind === "genome"
      ? node.bgcs.reduce<Record<string, number>>((acc, b) => {
          for (const cls of bgcComponentClasses(b)) acc[cls] = (acc[cls] ?? 0) + 1;
          return acc;
        }, {})
      : node.bgc_class_counts;

  const entries = Object.entries(counts).filter(([, n]) => n > 0);
  if (entries.length === 0) return null;
  entries.sort((a, b) => b[1] - a[1]);
  const [topClass, topCount] = entries[0]!;
  if (entries.length > 1 && entries[1]![1] === topCount) return null; // genuine tie
  return topClass;
}

/**
 * Rank abbreviations, matching GTDB's own taxonomy-string prefixes
 * (`d__Bacteria;p__...;c__...`). Note there is no "kingdom" here: GTDB's
 * top rank is domain, so the badge is D, not K. Using K would be wrong
 * for the data this tool actually renders.
 */
export const RANK_ABBREVIATIONS: Record<string, string> = {
  domain: "D",
  phylum: "P",
  class: "C",
  order: "O",
  family: "F",
  genus: "G",
  species: "S",
};

export function rankAbbreviation(rank: string | null | undefined): string | null {
  if (!rank) return null;
  return RANK_ABBREVIATIONS[rank] ?? null;
}

export type TreeOrientation = "horizontal" | "radial";

export interface RadialTreeLayout {
  nodes: d3.HierarchyPointNode<DisplayNode>[];
  links: d3.HierarchyPointLink<DisplayNode>[];
  size: number;
  radius: number;
  /** Angle between adjacent leaves, in radians. Multiplied by a node's
   * radius this gives the arc length available to its label — which is
   * what decides whether the label can be shown without colliding. */
  angularStep: number;
}

const RADIAL_MIN_RADIUS = 300;
// Arc length each leaf gets on the outer ring. Below ~22px, genome
// accessions in 11.5px mono start colliding with their neighbours.
const ARC_PER_LEAF = 26;
const RADIAL_PADDING = 210; // room for labels radiating outward

/**
 * Radial layout. `x` becomes an angle in radians and `y` a radius, which
 * is what d3.tree produces when sized `[2π, r]` — the same layout
 * algorithm, read in polar coordinates.
 *
 * Radius grows with leaf count so a large tree doesn't crush its tips
 * together; a fixed radius looks fine at 20 leaves and becomes unreadable
 * at 150.
 */
export function computeRadialTreeLayout(
  root: TaxonDisplayNode,
  collapsed: ReadonlySet<string>,
): RadialTreeLayout {
  const hierarchy = d3.hierarchy<DisplayNode>(root, makeChildrenAccessor(collapsed));
  const leafCount = Math.max(hierarchy.leaves().length, 1);
  // Radius is derived from the arc each leaf needs, not chosen and hoped
  // for: circumference = leafCount * ARC_PER_LEAF, so r = that / 2pi.
  // Without this the outer ring stays fixed while leaves multiply, which
  // is exactly how labels end up stacked on top of each other.
  const radius = Math.max(RADIAL_MIN_RADIUS, (leafCount * ARC_PER_LEAF) / (2 * Math.PI));

  const layout = d3
    .tree<DisplayNode>()
    .size([2 * Math.PI, radius])
    // Angular separation must scale inversely with radius, or inner
    // nodes overlap while outer ones sit too far apart.
    .separation((a, b) => (a.parent === b.parent ? 1 : 2) / a.depth || 1);
  const positioned = layout(hierarchy);

  return {
    nodes: positioned.descendants(),
    links: positioned.links(),
    size: (radius + RADIAL_PADDING) * 2,
    radius,
    angularStep: (2 * Math.PI) / leafCount,
  };
}

/** Whether a radial label sits on the left half and must be flipped so it
 * reads left-to-right rather than upside down. */
export function isLeftHalf(angleRadians: number): boolean {
  return angleRadians >= Math.PI;
}


/**
 * Semantic label management (the approach iTOL and Krona take).
 *
 * In a radial layout the space available to a label is an *arc*, so it
 * shrinks toward the centre and with every additional leaf. Inner taxon
 * nodes are the worst case: dozens of siblings sharing a small
 * circumference. Rendering every label regardless produces the stacked,
 * unreadable ring seen at 80 genomes.
 *
 * So a label is drawn only when its own arc — scaled by the current zoom —
 * can actually hold it. Zooming in progressively reveals more labels
 * rather than magnifying an unreadable tangle, and no label is ever
 * silently dropped at a zoom level where it would have fit.
 *
 * High ranks are always drawn: there are few of them, they anchor
 * orientation, and losing "Bacteria" to a spacing rule would be worse
 * than a slight overlap.
 */
export const MIN_LABEL_ARC_PX = 11;

export function hasRoomForLabel(
  radiusAtNode: number,
  angularStep: number,
  zoomScale: number,
  alwaysShow = false,
): boolean {
  if (alwaysShow) return true;
  const arc = radiusAtNode * angularStep * Math.max(zoomScale, 0.01);
  return arc >= MIN_LABEL_ARC_PX;
}

export function isAnchorRank(rank: string | null | undefined): boolean {
  return rank === "domain" || rank === "phylum" || rank === "class";
}

/**
 * Rank-level collapse presets.
 *
 * "Show the tree down to order" is a far more natural way to control
 * depth than clicking individual nodes, especially on a large tree where
 * the node you want to collapse may not even be on screen.
 *
 * Levels stop at genome (assembly). BGCs are rendered as tick marks *on*
 * a genome rather than as tree nodes, so there is no BGC level to
 * collapse to — they appear or don't with their genome.
 */
export const RANK_DEPTH_ORDER = [
  "domain",
  "phylum",
  "class",
  "order",
  "family",
  "genus",
  "species",
] as const;

export type CollapseLevel = (typeof RANK_DEPTH_ORDER)[number] | "genome";

export const COLLAPSE_LEVELS: { id: CollapseLevel; label: string; badge: string }[] = [
  { id: "domain", label: "Domain", badge: "D" },
  { id: "phylum", label: "Phylum", badge: "P" },
  { id: "class", label: "Class", badge: "C" },
  { id: "order", label: "Order", badge: "O" },
  { id: "family", label: "Family", badge: "F" },
  { id: "genus", label: "Genus", badge: "G" },
  { id: "species", label: "Species", badge: "S" },
  { id: "genome", label: "Genomes", badge: "⌾" },
];

function rankDepth(rank: string | null | undefined): number {
  if (!rank) return -1;
  const index = RANK_DEPTH_ORDER.indexOf(rank as (typeof RANK_DEPTH_ORDER)[number]);
  return index === -1 ? -1 : index;
}

/**
 * The collapse set that shows the tree down to `level` and no deeper.
 *
 * Collapses every taxon at or below the target depth, which makes nodes
 * *at* the target the visible leaves. Real taxonomies skip ranks — a
 * genus can sit directly under a family with no order in between — so
 * when the exact rank is missing from a branch, the shallowest rank
 * present below the target becomes that branch's leaf instead. Showing
 * one rank deeper than asked is better than hiding the branch entirely,
 * which is what matching on rank equality alone would do.
 */
export function collapseToLevel(root: TaxonDisplayNode, level: CollapseLevel): Set<string> {
  const collapsed = new Set<string>();
  if (level === "genome") return collapsed; // nothing collapsed: show everything

  const targetDepth = rankDepth(level);

  function walk(node: DisplayNode, parentCollapsed: boolean): void {
    if (node._kind === "genome") return;
    const depth = rankDepth(node.rank);
    const shouldCollapse = depth >= targetDepth && depth !== -1;

    if (shouldCollapse && !parentCollapsed) collapsed.add(nodeKey(node));

    const nowCollapsed = parentCollapsed || shouldCollapse;
    node.children.forEach((c) => walk({ ...c, _kind: "taxon" }, nowCollapsed));
  }

  walk(root, false);
  return collapsed;
}

/** The deepest rank actually present in this tree — so the control can
 * disable levels the data doesn't contain rather than offering a button
 * that does nothing. */
export function ranksPresent(root: TaxonDisplayNode): Set<string> {
  const found = new Set<string>();
  function walk(node: DisplayNode): void {
    if (node._kind === "genome") {
      found.add("genome");
      return;
    }
    if (node.rank) found.add(node.rank);
    node.direct_genomes.forEach(() => found.add("genome"));
    node.children.forEach((c) => walk({ ...c, _kind: "taxon" }));
  }
  walk(root);
  return found;
}

/**
 * Pruning to BGC-bearing genomes.
 *
 * A real GTDB ingest brings in every genome in the release, but only the
 * ones antiSMASH has actually been run on carry BGCs. At 5,000 GTDB rows
 * with a few hundred BGC-bearing genomes, the tree is overwhelmingly
 * empty scaffolding and the signal is buried.
 *
 * Uses the rolled-up `bgc_class_counts` the API already computes per
 * node, so deciding whether a whole subtree is empty is O(1) per node
 * rather than a walk — this runs on every render.
 */
export function subtreeHasBgcs(node: DisplayNode): boolean {
  if (node._kind === "genome") return node.bgcs.length > 0;
  return Object.values(node.bgc_class_counts).some((n) => n > 0);
}

export interface PrunedTree {
  root: TaxonDisplayNode;
  /** Genomes kept vs. present in the source tree. Surfaced so the UI can
   * say "showing N of M" — a filtered tree that doesn't announce itself
   * is indistinguishable from missing data. */
  shownGenomes: number;
  totalGenomes: number;
  /** True when pruning was requested but nothing carries BGCs, so the
   * full tree was returned instead. Pruning to an empty canvas would
   * look like a broken app rather than an empty result. */
  fellBackToFull: boolean;
}

export function pruneToBgcBearing(root: TaxonDisplayNode, enabled: boolean): PrunedTree {
  const totalGenomes = root.genome_count;

  if (!enabled) {
    return { root, shownGenomes: totalGenomes, totalGenomes, fellBackToFull: false };
  }

  if (!subtreeHasBgcs(root)) {
    // Nothing anywhere has BGCs — most likely GTDB ingested without
    // antiSMASH. Show everything rather than a blank canvas.
    return { root, shownGenomes: totalGenomes, totalGenomes, fellBackToFull: true };
  }

  let shown = 0;

  function prune(node: TaxonTreeNode): TaxonTreeNode {
    const genomes = node.direct_genomes.filter((g) => g.bgcs.length > 0);
    shown += genomes.length;
    const children = node.children
      .filter((c) => subtreeHasBgcs({ ...c, _kind: "taxon" }))
      .map(prune);
    return {
      ...node,
      direct_genomes: genomes,
      children,
      // Recomputed so downstream consumers (branch weighting, level
      // collapse, the header count) describe the tree being drawn rather
      // than the one before pruning.
      genome_count: genomes.length + children.reduce((sum, c) => sum + c.genome_count, 0),
    };
  }

  const prunedRoot: TaxonDisplayNode = { ...prune(root), _kind: "taxon" };
  return { root: prunedRoot, shownGenomes: shown, totalGenomes, fellBackToFull: false };
}

/**
 * Collapsed-clade summary glyphs.
 *
 * Collapsing currently *hides* information, which is why zooming out makes
 * the tree less interpretable rather than more. A collapsed clade should
 * instead *summarize* what it contains: how many genomes, how many
 * clusters, and what the biosynthetic composition looks like. Then a
 * phylum-level view is ~30 informative objects rather than 30 dots, and
 * the "Show down to" control becomes a real analytical tool instead of a
 * way to make the tree smaller.
 */
export interface CladeSummary {
  genomeCount: number;
  bgcCount: number;
  /** Class proportions, largest first. Ordered so the glyph's dominant
   * segment is always leftmost and comparable across clades at a glance. */
  composition: { bgcClass: string; count: number; fraction: number }[];
}

export function cladeSummary(node: DisplayNode): CladeSummary {
  const counts: Record<string, number> =
    node._kind === "genome"
      ? node.bgcs.reduce<Record<string, number>>((acc, b) => {
          for (const cls of bgcComponentClasses(b)) acc[cls] = (acc[cls] ?? 0) + 1;
          return acc;
        }, {})
      : node.bgc_class_counts;

  const bgcCount = Object.values(counts).reduce((sum, n) => sum + n, 0);
  const composition = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([bgcClass, count]) => ({
      bgcClass,
      count,
      fraction: bgcCount > 0 ? count / bgcCount : 0,
    }));

  return {
    genomeCount: node._kind === "genome" ? 1 : node.genome_count,
    bgcCount,
    composition,
  };
}

/** Glyph width from genome count. sqrt for the same reason branch widths
 * use it: clade sizes span orders of magnitude, and a linear map makes
 * one clade a slab and the rest invisible. */
export const MIN_GLYPH_WIDTH = 26;
export const MAX_GLYPH_WIDTH = 120;

export function glyphWidth(genomeCount: number, maxGenomeCount: number): number {
  if (genomeCount <= 0 || maxGenomeCount <= 0) return MIN_GLYPH_WIDTH;
  const scaled = Math.min(1, Math.sqrt(genomeCount) / Math.sqrt(maxGenomeCount));
  return MIN_GLYPH_WIDTH + scaled * (MAX_GLYPH_WIDTH - MIN_GLYPH_WIDTH);
}

/**
 * Focus mode.
 *
 * Navigating a large tree by scrolling is hopeless; navigating by drilling
 * is not. Focusing re-roots the view on a clade so the researcher always
 * sees a bounded number of objects regardless of corpus size, with
 * breadcrumbs to climb back out.
 */
export function findNodeByKey(root: TaxonDisplayNode, key: string): TaxonDisplayNode | null {
  if (nodeKey(root) === key) return root;
  for (const child of root.children) {
    const found = findNodeByKey({ ...child, _kind: "taxon" }, key);
    if (found) return found;
  }
  return null;
}

/** Ancestor chain from the true root down to `key`, inclusive — the
 * breadcrumb trail. Empty when the key isn't in this tree, which happens
 * legitimately when the BGC-bearing filter prunes away the focused clade. */
export function pathToNode(root: TaxonDisplayNode, key: string): TaxonDisplayNode[] {
  const path: TaxonDisplayNode[] = [];

  function walk(node: TaxonDisplayNode): boolean {
    path.push(node);
    if (nodeKey(node) === key) return true;
    for (const child of node.children) {
      if (walk({ ...child, _kind: "taxon" })) return true;
    }
    path.pop();
    return false;
  }

  return walk(root) ? path : [];
}

/** The subtree to draw, given an optional focus. Falls back to the whole
 * tree when the focused clade is no longer present — otherwise toggling
 * the BGC filter while focused would blank the canvas. */
export function applyFocus(
  root: TaxonDisplayNode,
  focusKey: string | null,
): { root: TaxonDisplayNode; path: TaxonDisplayNode[]; focusLost: boolean } {
  if (!focusKey) return { root, path: [], focusLost: false };
  const path = pathToNode(root, focusKey);
  if (path.length === 0) return { root, path: [], focusLost: true };
  return { root: path[path.length - 1]!, path, focusLost: false };
}
