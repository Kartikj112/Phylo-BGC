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

/** Key of the synthetic node that collects organisms with no place in the
 * GTDB backbone (MIBiG's fungi/plants, GTDB-reclassified genera). */
export const UNPLACED_KEY = "__unplaced__";

/**
 * Fold root-level orphans into one "Unplaced organisms" node.
 *
 * A real GTDB tree roots at a single `domain`. MIBiG entries whose genus
 * isn't in GTDB's bacterial taxonomy ingest as bare species with no
 * parent, so the API root ends up with the domain PLUS a fan of loose
 * species. Bundling them keeps the tree readable and says plainly that
 * they aren't phylogenetically placed, rather than scattering them beside
 * the real hierarchy. A no-op when everything is placed.
 */
export function groupUnplacedTaxa(root: TaxonDisplayNode): TaxonDisplayNode {
  const placed: TaxonTreeNode[] = [];
  const unplaced: TaxonTreeNode[] = [];
  for (const child of root.children) {
    (child.rank === "domain" ? placed : unplaced).push(child);
  }
  if (unplaced.length === 0) return root;

  const bgc_class_counts: Record<string, number> = {};
  let genome_count = 0;
  // Rolled up alongside genome_count, not defaulted to zero: this bucket is
  // a real part of the tree, and reporting it as wholly unexamined when its
  // children were examined would understate the corpus.
  let examined_genome_count = 0;
  for (const node of unplaced) {
    genome_count += node.genome_count;
    examined_genome_count += node.examined_genome_count;
    for (const [cls, n] of Object.entries(node.bgc_class_counts)) {
      bgc_class_counts[cls] = (bgc_class_counts[cls] ?? 0) + n;
    }
  }
  const bucket: TaxonTreeNode = {
    id: UNPLACED_KEY,
    name: "Unplaced organisms",
    rank: null,
    genome_count,
    examined_genome_count,
    bgc_class_counts,
    direct_genomes: [],
    children: unplaced,
  };
  return { ...root, children: [...placed, bucket] };
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

/**
 * One searchable field against an already-lowercased needle.
 *
 * The second clause is for the enum tokens the API spells with underscores
 * ("complete_genome", "observed_curated"): nobody types those, they type
 * "complete genome", and a search that only knew the wire spelling would
 * report "no matches" for a term the interface itself displays.
 *
 * Substring rather than whole-word throughout, so a half-typed query
 * narrows as you go — the search box has no submit button.
 */
function fieldMatches(field: string | null | undefined, needle: string): boolean {
  if (!field) return false;
  const value = field.toLowerCase();
  if (value.includes(needle)) return true;
  return value.includes("_") && value.replace(/_/g, " ").includes(needle);
}

/** Shared by bgcMatchesQuery and matchesQuery, which would otherwise
 * re-trim and re-lowercase the same query once per cluster per traversal —
 * and there are several traversals per keystroke over thousands of nodes. */
function bgcMatchesNeedle(bgc: BGCSummary, needle: string): boolean {
  if (fieldMatches(bgc.mibig_accession, needle)) return true;
  if ((bgc.compounds ?? []).some((name) => fieldMatches(name, needle))) return true;
  if (fieldMatches(bgc.subtype, needle)) return true;
  if (fieldMatches(bgc.evidence_level, needle)) return true;
  // What KIND of cluster it is. Hybrids go through bgcComponentClasses, so
  // "pks" answers an nrps+pks the same way the class filter does rather
  // than matching only the literal string "hybrid".
  if (fieldMatches(bgc.bgc_class, needle)) return true;
  return bgcComponentClasses(bgc).some((cls) => fieldMatches(cls, needle));
}

/**
 * Does this cluster answer the query?
 *
 * Matches the compound names MIBiG records for it, its MIBiG accession, and
 * what kind of cluster it is (class, hybrid subtype, evidence level). A
 * product name ("kocurin") is how a researcher actually refers to a
 * cluster — searching only taxa and genome accessions made the most natural
 * question you can ask this tool unanswerable.
 */
export function bgcMatchesQuery(bgc: BGCSummary, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return false;
  return bgcMatchesNeedle(bgc, needle);
}

/**
 * Does this node answer the query?
 *
 * Everything the node carries is searchable, not just its label: a taxon on
 * its name and its rank, a genome on its accession, how it was assembled,
 * and on every field of every cluster it holds. Routing all of it through
 * this one function rather than parallel paths means the
 * force-open-collapsed-clades logic, the dimming and the header match count
 * pick up each new field for free — they already call this.
 */
export function matchesQuery(node: DisplayNode, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return false;
  if (fieldMatches(nodeLabel(node), needle)) return true;
  // Rank is searchable so "genus" or "phylum" can pick out one stratum of
  // the hierarchy — the ranks are what the badges beside each taxon mean.
  if (node._kind === "taxon") return fieldMatches(node.rank, needle);
  if (fieldMatches(node.assembly_level, needle)) return true;
  // Whole word only: `is_mag` is a flag, not a field of text, so there is no
  // prefix of it to match against. Treating it as text would light up every
  // MAG in the corpus at "m", before the reader has typed anything.
  if (node.is_mag && needle === "mag") return true;
  return node.bgcs.some((b) => bgcMatchesNeedle(b, needle));
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
  /** Span of the depth axis actually used, so the caller can frame it. */
  width: number;
}

const MIN_ROW_HEIGHT = 34;
const MIN_TREE_HEIGHT = 200;
const HEIGHT_MARGIN = 40;

/** Horizontal span per level of depth, when spreading to fill the viewport.
 * Enough for a rank badge plus a readable label before the next column. */
const DEPTH_STEP_MIN = 150;
const DEPTH_STEP_MAX = 320;

/** Row height shrinks as leaves multiply, so a large clade stays navigable
 * instead of becoming a kilometre-tall ribbon. Labels are hidden by the
 * canvas's own semantic-zoom rules well before rows get this tight. */
function rowHeightFor(leafCount: number): number {
  if (leafCount > 600) return 11;
  if (leafCount > 300) return 16;
  if (leafCount > 120) return 24;
  return MIN_ROW_HEIGHT;
}

export function computeTreeLayout(
  root: TaxonDisplayNode,
  collapsed: ReadonlySet<string>,
  width: number,
  /** Viewport height. When given, the depth axis is stretched so the tree's
   * aspect ratio matches the screen's — see below. */
  viewportHeight?: number,
): TreeLayout {
  const hierarchy = d3.hierarchy<DisplayNode>(root, makeChildrenAccessor(collapsed));
  const leafCount = Math.max(hierarchy.leaves().length, 1);
  const innerHeight = Math.max(leafCount * rowHeightFor(leafCount), MIN_TREE_HEIGHT);

  // The depth axis is sized to the space actually available, not to a
  // constant.
  //
  // This used to be a fixed 760px regardless of viewport or tree shape,
  // while the cross axis grew with leaf count — so a real corpus produced
  // something ~26,000px tall by 760px wide, which fit-to-view then shrank
  // into an unreadable vertical smear. The hierarchy is the thing a reader
  // follows left-to-right, so it gets the screen's long dimension.
  const maxDepth = Math.max(1, d3.max(hierarchy.descendants(), (d) => d.depth) ?? 1);
  const step = Math.min(DEPTH_STEP_MAX, Math.max(DEPTH_STEP_MIN, width / (maxDepth + 1)));

  // Match the viewport's aspect ratio.
  //
  // The cross axis is driven by leaf count and routinely far exceeds the
  // window height, so fit-to-view is height-constrained: it scales the whole
  // tree down until the rows fit, and whatever width the layout claimed
  // shrinks with it. That is why this rendered as a narrow vertical smear in
  // a wide window no matter how large `width` was.
  //
  // Stretching the depth axis to `innerHeight * (viewportW / viewportH)`
  // makes the two constraints bind at the same scale, so the tree fills the
  // screen in both directions and the hierarchy reads left-to-right across
  // it. Branches get longer; nothing about the topology changes.
  const aspect = viewportHeight && viewportHeight > 0 ? width / viewportHeight : 0;
  const innerWidth = Math.max(width, step * maxDepth, aspect > 0 ? innerHeight * aspect : 0);

  const layout = d3
    .tree<DisplayNode>()
    .size([innerHeight, innerWidth])
    .separation((a, b) => (a.parent === b.parent ? 1 : 1.4));
  const positioned = layout(hierarchy);

  return {
    nodes: positioned.descendants(),
    links: positioned.links(),
    height: innerHeight + HEIGHT_MARGIN,
    width: innerWidth,
  };
}

/** How many nodes a collapse level would put on screen. */
export function visibleNodeCount(root: TaxonDisplayNode, collapsed: ReadonlySet<string>): number {
  return d3.hierarchy<DisplayNode>(root, makeChildrenAccessor(collapsed)).descendants().length;
}

/** Nodes to aim for on first paint — enough to show the shape of the corpus,
 * few enough to read at a glance. */
export const INITIAL_NODE_TARGET = 160;

/**
 * The collapse level to open on.
 *
 * Opening fully expanded meant a real corpus rendered 3,528 nodes before the
 * user had asked for anything — the broad distribution pattern, which is the
 * question this tool exists to answer, was buried under every leaf at once.
 *
 * Picked from the data rather than hardcoded: the DEEPEST rank that still
 * fits `INITIAL_NODE_TARGET`, so a small corpus opens detailed and a large
 * one opens coarse, and neither needs a different default. Falls back to the
 * shallowest available rank if even that overflows.
 */
export function initialCollapseLevel(root: TaxonDisplayNode): CollapseLevel {
  const present = ranksPresent(root);
  const candidates = RANK_DEPTH_ORDER.filter((r) => present.has(r));
  if (candidates.length === 0) return "phylum";

  let best: CollapseLevel = candidates[0] ?? "phylum";
  for (const level of candidates) {
    if (visibleNodeCount(root, collapseToLevel(root, level)) <= INITIAL_NODE_TARGET) {
      best = level;
    } else {
      break; // deeper levels only add nodes
    }
  }
  return best;
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
  // Negated comparisons rather than `<= 0`, because NaN fails EVERY
  // comparison and would slip through: `NaN <= 0` is false, so a NaN
  // maximum reached Math.sqrt and returned a NaN width, which SVG renders
  // as no stroke at all. The clamp below already exists to defend this
  // function against a caller passing a stale or wrongly-scoped maximum
  // (see the note on it); a NaN maximum is the same class of caller error
  // and was the one case the guard did not cover.
  if (!(count > 0) || !(maxCount > 0)) return MIN_BRANCH_WIDTH;
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
 * (`d__Bacteria;p__...;c__...`).
 *
 * GTDB's top rank is domain and it never emits a kingdom, so a bacterial
 * tree simply never shows K. NCBI ranks eukaryotes with one
 * (Eukaryota -> Fungi -> Ascomycota), so the eukaryote view does.
 */
export const RANK_ABBREVIATIONS: Record<string, string> = {
  domain: "D",
  kingdom: "K",
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

/** Arc an ANCHOR label (domain/phylum/class) has to clear.
 *
 * Lower than `MIN_LABEL_ARC_PX`, not zero. These labels are what orients a
 * reader in a radial tree, so they get priority — but the previous
 * `alwaysShow` bypass gave them an exemption rather than a priority, and an
 * exemption means every phylum in a tightly packed ring draws on top of its
 * neighbours. Overlapping text is not more informative than less text; it
 * is less, because none of it can be read.
 */
export const MIN_ANCHOR_LABEL_ARC_PX = 7;

export function hasRoomForLabel(
  radiusAtNode: number,
  angularStep: number,
  zoomScale: number,
  isAnchor = false,
): boolean {
  const arc = radiusAtNode * angularStep * Math.max(zoomScale, 0.01);
  return arc >= (isAnchor ? MIN_ANCHOR_LABEL_ARC_PX : MIN_LABEL_ARC_PX);
}

/** Vertical room one label needs, in SCREEN pixels.
 *
 * Screen pixels because the canvas draws labels at a constant screen size:
 * font size and label offsets are divided by the zoom (see `labelScale` in
 * TreeCanvas), so a name is ~12px whether the tree is at 0.2x or 3x. Type
 * that shrinks with the figure is unreadable long before it is crowded —
 * at fit-to-view a default tree sits near k=0.2, which rendered 12px labels
 * at about 2.4px.
 *
 * Holding type constant moves the whole problem into density: at 0.2x the
 * rows themselves are only a few screen pixels apart, so most labels cannot
 * be drawn and the placement pass below is what decides which ones are.
 * That is the trade — constant legibility, varying density — and it is why
 * this threshold is compared against layout distance MULTIPLIED by the
 * zoom, rather than against layout distance alone.
 *
 * 15 against 12-13px labels leaves a couple of pixels of air, which keeps
 * consecutive rows reading as separate lines rather than one block.
 */
export const MIN_LABEL_ROW_PX = 15;

/** Width of one character at the base label size, in layout units.
 *
 * An estimate, deliberately: the alternative is a `getBBox()` per node per
 * render, and the tree routinely draws thousands. The same 6.6-6.9 figure
 * the rank badge and hit boxes have always used, now shared so every
 * consumer moves together instead of drifting apart.
 */
export const LABEL_CHAR_WIDTH = 6.9;

/**
 * How much horizontal room a label occupies, in LAYOUT units.
 *
 * Multiplied by `labelScale` (1/zoom) because labels are drawn at a
 * constant screen size — so the further out a reader zooms, the MORE layout
 * space a name covers. Anything that has to sit clear of a label therefore
 * has to be positioned with this, not with a constant.
 *
 * That is the bug this exists to fix. The aligned glyph track sat a flat
 * `GLYPH_TRACK_GUTTER` of 26 units past the deepest tip, while a 15-
 * character accession is ~104 units wide at 1x — so the bars have always
 * been drawn through the accessions, and holding labels at a constant
 * screen size widened the overlap to ~517 units at the default 0.2x view.
 */
export function estimateLabelWidth(text: string, labelScale = 1): number {
  return text.length * LABEL_CHAR_WIDTH * labelScale;
}

/**
 * Which labels can be drawn in the rectangular layout without colliding.
 *
 * The rectangular layout had no such rule at all. `showLabel` read
 * `!isRadial || hasRoomForLabel(...)`, which short-circuits to `true` for
 * every node whenever the tree is not radial — so every label always
 * rendered. Meanwhile `rowHeightFor` takes rows down to 11px once a clade
 * passes 600 leaves, against 12-13px text: text taller than its own row, on
 * every row. The comment on `rowHeightFor` claiming the canvas hides labels
 * "well before rows get this tight" described a rule that existed only for
 * the radial case.
 *
 * Because labels hold a constant screen size, this is the only thing
 * standing between the reader and a pile of overlapping names: nothing else
 * thins them out as the tree zooms away. `zoomScale` is therefore load-
 * bearing — the separation a label needs in layout units is
 * `MIN_LABEL_ROW_PX / k`, which grows as the reader zooms out and shrinks
 * back as they zoom in. Labels reappear on zoom, which is the behaviour the
 * radial layout has always had.
 *
 * Placement is greedy rather than all-or-nothing, because "no labels below
 * a threshold" trades one unreadable state for a blank one. Labels are
 * bucketed by depth — each depth is its own column, and a column can only
 * collide with itself — then taken in priority order, and each kept only if
 * it clears every label already placed in that column.
 *
 * `boost` lets the caller raise something above the depth ordering (a
 * search hit, a selected family's clade) so the labels a reader is
 * currently looking for survive the cut. Ties break on position, so the
 * result is stable across renders and does not flicker while panning.
 */
export interface LabelPlacement {
  /** `nodeKey()` of every node whose label can be drawn. */
  visible: Set<string>;
  /** How many were suppressed, so the canvas can say so rather than
   * leaving a reader to wonder why a name they expected is missing. */
  suppressed: number;
}

/**
 * For each node, the distance to the nearest HIGHER-priority label in its
 * own column — the largest separation at which that label still survives.
 *
 * This replaces a greedy "place it if it clears everything placed so far"
 * pass, which was not monotonic in zoom. Greedy packing can admit a nearer
 * label at a finer threshold and thereby block a further one that a coarser
 * threshold had kept:
 *
 *     x = [0, 10, 12]
 *     separation 11 (zoomed out) -> {0, 12}
 *     separation  9 (zoomed in)  -> {0, 10}
 *
 * The label at 12 is visible zoomed out and vanishes when the reader zooms
 * IN, which is precisely backwards. Found by a property test asserting
 * monotonicity, not by reading the code.
 *
 * Keying on "nearest higher-priority neighbour" fixes it by construction:
 * the value does not depend on the threshold at all, so lowering the
 * threshold can only ever add labels. It is still collision-free — if two
 * labels are both shown and i outranks j, then i is one of j's
 * higher-priority neighbours, so their distance is at least j's separation,
 * which is at least the threshold.
 *
 * Being zoom-independent, it is also computed once per layout rather than
 * once per zoom step.
 */
export function computeLabelSeparations(
  nodes: d3.HierarchyPointNode<DisplayNode>[],
  options: { boost?: (node: d3.HierarchyPointNode<DisplayNode>) => number } = {},
): Map<string, number> {
  const { boost } = options;
  const ranked = nodes.map((n) => {
    const node = n.data;
    const rank = node._kind === "taxon" ? node.rank : null;
    let priority = isAnchorRank(rank) ? 1000 : 500 - n.depth;
    if (boost) priority += boost(n);
    return { n, priority };
  });
  // Descending priority, then position — so everything already inserted
  // when a node is processed outranks it, and ties break stably.
  ranked.sort((a, b) => b.priority - a.priority || a.n.x - b.n.x);

  const seen = new Map<number, number[]>(); // depth -> sorted x of higher-priority
  const out = new Map<string, number>();

  for (const { n } of ranked) {
    const column = seen.get(n.depth) ?? [];
    // Binary search for the insertion point, then the nearest neighbour is
    // one of the two entries either side of it.
    let lo = 0;
    let hi = column.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((column[mid] as number) < n.x) lo = mid + 1;
      else hi = mid;
    }
    let nearest = Infinity;
    if (lo > 0) nearest = Math.min(nearest, n.x - (column[lo - 1] as number));
    if (lo < column.length) nearest = Math.min(nearest, (column[lo] as number) - n.x);
    out.set(nodeKey(n.data), nearest);
    column.splice(lo, 0, n.x);
    seen.set(n.depth, column);
  }
  return out;
}

/** Apply a zoom to precomputed separations. Cheap enough to run per frame. */
export function selectLabels(
  separations: Map<string, number>,
  zoomScale: number,
  minSeparationPx = MIN_LABEL_ROW_PX,
): LabelPlacement {
  const needed = minSeparationPx / Math.max(zoomScale, 0.001);
  const visible = new Set<string>();
  let suppressed = 0;
  for (const [key, gap] of separations) {
    if (gap >= needed) visible.add(key);
    else suppressed += 1;
  }
  return { visible, suppressed };
}

export function placeRectangularLabels(
  nodes: d3.HierarchyPointNode<DisplayNode>[],
  zoomScale: number,
  options: {
    /** Higher wins. Anchor ranks already outrank ordinary nodes. */
    boost?: (node: d3.HierarchyPointNode<DisplayNode>) => number;
    /** Screen pixels of separation a label needs. */
    minSeparationPx?: number;
  } = {},
): LabelPlacement {
  return selectLabels(
    computeLabelSeparations(nodes, options),
    zoomScale,
    options.minSeparationPx ?? MIN_LABEL_ROW_PX,
  );
}

/** Ranks that orient a reader, and therefore get label priority.
 *
 * `kingdom` belongs here even though GTDB never emits it. It exists only in
 * the NCBI eukaryote tree, where `Fungi` and `Viridiplantae` are exactly
 * the labels that say which half of the tree you are looking at — the same
 * job `Bacteria` and `Actinomycetota` do on the prokaryote side. Leaving it
 * out gave the two trees different behaviour from one shared renderer:
 * ordinary priority for the eukaryote anchors, so they were the FIRST
 * labels dropped when space ran short, on the tree that can least afford
 * to lose them.
 */
export function isAnchorRank(rank: string | null | undefined): boolean {
  return rank === "domain" || rank === "kingdom" || rank === "phylum" || rank === "class";
}

/** Ranks drawn larger and bolder — the tree's top structure. Carries
 * `kingdom` for the same reason `isAnchorRank` does: without it `Fungi`
 * rendered at ordinary weight beside a bold `Bacteria` on the other tab. */
export function isHighRank(rank: string | null | undefined): boolean {
  return rank === "domain" || rank === "kingdom" || rank === "phylum";
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
  // Only the NCBI eukaryote tree uses this: GTDB is prokaryote-only and its
  // top rank is domain. It still has to appear in the ORDER, or a kingdom
  // node scores rankDepth -1, is treated like an unrankable orphan, and can
  // never be collapsed by "Show down to".
  "kingdom",
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
  // Present only in the eukaryote tree; `ranksPresent` disables it for the
  // bacterial one rather than offering a level that would do nothing.
  { id: "kingdom", label: "Kingdom", badge: "K" },
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
    // The "Unplaced organisms" bucket has no rank, so a depth comparison can
    // never collapse it — which meant every level, including "Domain", left
    // its full fan of species on screen (285 of them on the bundled corpus)
    // and the control did not do what it said. It is a container, not a
    // rank, so it collapses at every level and opens on demand like any
    // other node.
    const isUnplacedBucket = nodeKey(node) === UNPLACED_KEY;
    const shouldCollapse = isUnplacedBucket || (depth >= targetDepth && depth !== -1);

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
  /** How many of `genomeCount` a cluster-detection run has covered.
   *
   * The denominator for anything this glyph says about absence. A clade
   * showing zero clusters over 40 examined genomes is a finding; the same
   * zero over 40 unexamined genomes is an empty database, and the glyph
   * drew both identically until this existed. */
  examinedGenomeCount: number;
  bgcCount: number;
  /** Class proportions, largest first. Ordered so the glyph's dominant
   * segment is always leftmost and comparable across clades at a glance. */
  composition: { bgcClass: string; count: number; fraction: number }[];
}

/** Whether an empty glyph means "we looked and found nothing" or "nothing
 * has looked". Only meaningful when `bgcCount` is 0; a clade with clusters
 * is drawn from its composition either way. */
export function emptyCladeReading(
  summary: CladeSummary,
): "examined-empty" | "unexamined" | "partly-examined" {
  if (summary.examinedGenomeCount === 0) return "unexamined";
  if (summary.examinedGenomeCount < summary.genomeCount) return "partly-examined";
  return "examined-empty";
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
    examinedGenomeCount:
      node._kind === "genome"
        ? node.coverage === "examined"
          ? 1
          : 0
        : node.examined_genome_count,
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

/**
 * BGC-count size tiers.
 *
 * A genome with no clusters should not command the same visual attention
 * as one with fifty. Tiers rather than a continuous scale because the
 * distinction that matters is categorical — "worth looking at" vs "not" —
 * and a smooth ramp makes every genome look mid-range.
 *
 * BGC-negative genomes stay deliberately visible but subdued: they are
 * evolutionary context, not noise, and deleting them from the tree would
 * misrepresent the phylogeny.
 */
export interface BgcSizeTier {
  id: string;
  label: string;
  radius: number;
  /** Muted for empty genomes so they recede without disappearing. */
  muted: boolean;
}

/** Tip radii, in SCREEN pixels — the canvas divides them by the zoom so a
 * node is the same size however far the tree is scaled (see `screenScale`
 * in TreeCanvas). Like branch width, a node's size is only ever read
 * against other nodes, never against the tree's geometry, so scaling them
 * all together preserves the comparison exactly while keeping it visible.
 * Drawn in layout units these were 0.4-1.9px at the default 0.2x view.
 *
 * Sized down from 2.5-12: at the old radii a dense clade read as a string of
 * touching beads, which hid the branch structure the tree exists to show.
 * The tiers stay clearly ordered and the spread between the extremes is
 * roughly preserved, so size still reads as count. The empty tier shrinks
 * least (2.5 to 2, against 12 to 8.5) because BGC-negative genomes have to
 * stay legibly present — they are context, not noise, as above. */
export const BGC_SIZE_TIERS: BgcSizeTier[] = [
  { id: "none", label: "0", radius: 2, muted: true },
  { id: "low", label: "1–5", radius: 3, muted: false },
  { id: "medium", label: "6–20", radius: 4.5, muted: false },
  { id: "high", label: "21–50", radius: 6.25, muted: false },
  { id: "very-high", label: ">50", radius: 8.5, muted: false },
];

export function bgcSizeTier(bgcCount: number): BgcSizeTier {
  if (bgcCount <= 0) return BGC_SIZE_TIERS[0]!;
  if (bgcCount <= 5) return BGC_SIZE_TIERS[1]!;
  if (bgcCount <= 20) return BGC_SIZE_TIERS[2]!;
  if (bgcCount <= 50) return BGC_SIZE_TIERS[3]!;
  return BGC_SIZE_TIERS[4]!;
}

/**
 * Genome filters.
 *
 * Every field here is backed by real data in the model — no filter is
 * offered for something the database can't answer. `null` bounds mean
 * "unconstrained", which is distinct from a bound of zero.
 */
export interface GenomeFilters {
  minBgcCount: number | null;
  maxBgcCount: number | null;
  mibigMatched: "any" | "matched" | "unmatched";
  minGenomeSizeMb: number | null;
  maxGenomeSizeMb: number | null;
  minGcPct: number | null;
  maxGcPct: number | null;
  minCompletenessPct: number | null;
  magOnly: boolean;
}

export const EMPTY_FILTERS: GenomeFilters = {
  minBgcCount: null,
  maxBgcCount: null,
  mibigMatched: "any",
  minGenomeSizeMb: null,
  maxGenomeSizeMb: null,
  minGcPct: null,
  maxGcPct: null,
  minCompletenessPct: null,
  magOnly: false,
};

export function filtersAreActive(f: GenomeFilters): boolean {
  return (
    f.minBgcCount !== null ||
    f.maxBgcCount !== null ||
    f.mibigMatched !== "any" ||
    f.minGenomeSizeMb !== null ||
    f.maxGenomeSizeMb !== null ||
    f.minGcPct !== null ||
    f.maxGcPct !== null ||
    f.minCompletenessPct !== null ||
    f.magOnly
  );
}

export function genomePassesFilters(genome: GenomeDisplayNode, f: GenomeFilters): boolean {
  const bgcCount = genome.bgcs.length;
  if (f.minBgcCount !== null && bgcCount < f.minBgcCount) return false;
  if (f.maxBgcCount !== null && bgcCount > f.maxBgcCount) return false;

  if (f.mibigMatched !== "any") {
    const hasMatch = genome.bgcs.some((b) => b.mibig_accession);
    if (f.mibigMatched === "matched" && !hasMatch) return false;
    if (f.mibigMatched === "unmatched" && hasMatch) return false;
  }

  // A missing measurement is not a failed one: a genome without a
  // recorded GC content shouldn't vanish because a GC filter is set. It
  // passes, and the filter simply can't speak to it.
  const sizeMb = genome.genome_size_bp != null ? genome.genome_size_bp / 1_000_000 : null;
  if (sizeMb !== null) {
    if (f.minGenomeSizeMb !== null && sizeMb < f.minGenomeSizeMb) return false;
    if (f.maxGenomeSizeMb !== null && sizeMb > f.maxGenomeSizeMb) return false;
  }
  if (genome.gc_content_pct != null) {
    if (f.minGcPct !== null && genome.gc_content_pct < f.minGcPct) return false;
    if (f.maxGcPct !== null && genome.gc_content_pct > f.maxGcPct) return false;
  }
  if (genome.completeness_pct != null && f.minCompletenessPct !== null) {
    if (genome.completeness_pct < f.minCompletenessPct) return false;
  }
  if (f.magOnly && !genome.is_mag) return false;
  return true;
}

/** Apply filters to the tree, dropping taxa left with nothing. Shares the
 * fallback behaviour of pruneToBgcBearing: filtering everything away
 * returns the unfiltered tree rather than a blank canvas. */
export function applyGenomeFilters(
  root: TaxonDisplayNode,
  filters: GenomeFilters,
): { root: TaxonDisplayNode; matched: number; filteredEverythingOut: boolean } {
  if (!filtersAreActive(filters)) {
    return { root, matched: root.genome_count, filteredEverythingOut: false };
  }

  let matched = 0;
  function prune(node: TaxonTreeNode): TaxonTreeNode {
    const genomes = node.direct_genomes.filter((g) =>
      genomePassesFilters({ ...g, _kind: "genome" }, filters),
    );
    matched += genomes.length;
    const children = node.children.map(prune).filter((c) => c.genome_count > 0);
    return {
      ...node,
      direct_genomes: genomes,
      children,
      genome_count: genomes.length + children.reduce((s, c) => s + c.genome_count, 0),
    };
  }

  const filtered: TaxonDisplayNode = { ...prune(root), _kind: "taxon" };
  if (matched === 0) return { root, matched: 0, filteredEverythingOut: true };
  return { root: filtered, matched, filteredEverythingOut: false };
}

/* ===========================================================================
 * GCF distribution across the tree — the product's central question.
 *
 * "Where is this gene cluster family found across the tree of life, and what
 * does its distribution look like?" These pure functions turn the raw
 * `family_ids` already carried on every BGCSummary into the aggregate
 * quantities a reader would otherwise have to reconstruct by eye: how many
 * genomes, how many clades at each rank, how concentrated, how broad, how
 * many separate lineages, how many lone occurrences.
 *
 * Everything here is DESCRIPTIVE. Nothing infers horizontal gene transfer,
 * gene loss, or any evolutionary process — `patternLabel` states only what is
 * observed in the loaded dataset. The same caution the comparison endpoint
 * takes (see api/comparison.py) applies: absence from a clade is "not found
 * in this dataset", not "the clade lacks it".
 *
 * Meant to run against the FULL (unpruned, unfiltered) tree, so the numbers
 * are stable dataset-wide properties rather than artefacts of the current
 * view. Complexity is one pass over the tree; the results are memoised by the
 * page on [fullRoot, familyId] and handed to the canvas as ready-made Sets,
 * which also removes the previous per-node nodeHasFamily() recursion.
 * ======================================================================== */

const RANKS_BROAD_TO_DEEP = [
  "domain",
  "phylum",
  "class",
  "order",
  "family",
  "genus",
  "species",
] as const;

export interface FamilyMembershipSets {
  /** nodeKey() of every node — taxon or genome — whose subtree carries at
   * least one BGC in the family. Drives the "which parts of the tree does
   * this reach" highlight in O(1) per node at render time. */
  nodeKeys: Set<string>;
  /** nodeKey() of every genome node that itself carries a family member. */
  genomeKeys: Set<string>;
  /** nodeKey() → member-bearing genome count in that subtree (inclusive).
   * A missing key means zero. */
  memberGenomeCountByNode: Map<string, number>;
  /** nodeKey() → member BGC count in that subtree (inclusive). */
  memberBgcCountByNode: Map<string, number>;
}

export function familyMembershipSets(
  root: TaxonDisplayNode,
  familyId: string | null,
): FamilyMembershipSets {
  if (!familyId) return emptyMembership();
  return membershipSets(root, (b) => b.family_ids.includes(familyId));
}

/**
 * The same sets, for membership in ANY of several families at once.
 *
 * What an antiSMASH upload needs. A genome carries many clusters, each
 * landing in its own BiG-SCAPE family, and the question the reader is
 * asking — "where else does what I just found occur?" — is answered by the
 * union, not by one family at a time. Counts are per BGC, so a node holding
 * members of two of the families counts two.
 */
export function familyMembershipSetsForAny(
  root: TaxonDisplayNode,
  familyIds: readonly string[],
): FamilyMembershipSets {
  if (familyIds.length === 0) return emptyMembership();
  const wanted = new Set(familyIds);
  return membershipSets(root, (b) => b.family_ids.some((id) => wanted.has(id)));
}

function emptyMembership(): FamilyMembershipSets {
  return {
    nodeKeys: new Set<string>(),
    genomeKeys: new Set<string>(),
    memberGenomeCountByNode: new Map<string, number>(),
    memberBgcCountByNode: new Map<string, number>(),
  };
}

/** One walk, parameterised by what counts as a member — so the single-family
 * and any-of-many cases cannot drift apart in how they aggregate. */
function membershipSets(
  root: TaxonDisplayNode,
  isMember: (bgc: BGCSummary) => boolean,
): FamilyMembershipSets {
  const nodeKeys = new Set<string>();
  const genomeKeys = new Set<string>();
  const memberGenomeCountByNode = new Map<string, number>();
  const memberBgcCountByNode = new Map<string, number>();

  function walk(node: DisplayNode): { genomes: number; bgcs: number } {
    const key = nodeKey(node);
    if (node._kind === "genome") {
      const bgcs = node.bgcs.filter(isMember).length;
      if (bgcs > 0) {
        genomeKeys.add(key);
        nodeKeys.add(key);
        memberGenomeCountByNode.set(key, 1);
        memberBgcCountByNode.set(key, bgcs);
      }
      return { genomes: bgcs > 0 ? 1 : 0, bgcs };
    }
    let genomes = 0;
    let bgcs = 0;
    for (const g of node.direct_genomes) {
      const r = walk({ ...g, _kind: "genome" });
      genomes += r.genomes;
      bgcs += r.bgcs;
    }
    for (const c of node.children) {
      const r = walk({ ...c, _kind: "taxon" });
      genomes += r.genomes;
      bgcs += r.bgcs;
    }
    if (bgcs > 0) {
      nodeKeys.add(key);
      memberGenomeCountByNode.set(key, genomes);
      memberBgcCountByNode.set(key, bgcs);
    }
    return { genomes, bgcs };
  }

  walk(root);
  return { nodeKeys, genomeKeys, memberGenomeCountByNode, memberBgcCountByNode };
}

export interface UploadLineage {
  /** nodeKey() of every node on the path from the root down to and including
   * each named genome. Drives the "here is where your genome sits" highlight
   * in O(1) per node at render time, the same shape as
   * FamilyMembershipSets.nodeKeys. */
  lineageKeys: Set<string>;
  /** nodeKey() of the named genomes themselves, so the tip can be marked
   * differently from the branches leading to it. */
  genomeKeys: Set<string>;
}

/**
 * The root-to-tip path for freshly uploaded genomes, found by accession.
 *
 * Keyed on accession rather than id because that is what the upload
 * response returns and what the reader typed into the filename; the genome's
 * uuid is assigned server-side and is not otherwise interesting here.
 *
 * Every ancestor is included, so highlighting the set draws an unbroken
 * branch from the root — which is the point. A partial path (say, only the
 * genus and the species) reads as two disconnected marks rather than as a
 * lineage.
 */
export function uploadLineage(
  root: TaxonDisplayNode,
  accessions: readonly string[],
): UploadLineage {
  const lineageKeys = new Set<string>();
  const genomeKeys = new Set<string>();
  if (accessions.length === 0) return { lineageKeys, genomeKeys };
  const wanted = new Set(accessions);

  function walk(node: DisplayNode, path: string[]): void {
    const key = nodeKey(node);
    if (node._kind === "genome") {
      if (wanted.has(node.accession)) {
        genomeKeys.add(key);
        lineageKeys.add(key);
        for (const ancestor of path) lineageKeys.add(ancestor);
      }
      return;
    }
    const nextPath = [...path, key];
    for (const g of node.direct_genomes) walk({ ...g, _kind: "genome" }, nextPath);
    for (const c of node.children) walk({ ...c, _kind: "taxon" }, nextPath);
  }

  walk(root, []);
  return { lineageKeys, genomeKeys };
}

/** Occupancy of one taxonomic rank by a family: how many distinct taxa at
 * that rank carry it, out of how many exist in the tree. "3 of 34 genera"
 * says far more than "3 genera". */
export interface RankOccupancy {
  rank: string;
  containing: number;
  total: number;
}

/** A clade that wraps some or all of a family's occurrences — used both for
 * the tree brackets and for the plain-language summary. */
export interface EnclosingClade {
  key: string;
  name: string;
  rank: string | null;
  memberGenomes: number;
}

export interface FamilyDistribution {
  familyId: string;
  memberBgcCount: number;
  memberGenomeCount: number;
  totalGenomes: number;
  /** memberGenomeCount / totalGenomes, 0..1 — "found in X% of genomes". */
  prevalence: number;
  /** occupancy per taxonomic rank, broad → deep, only ranks the tree has. */
  byRank: RankOccupancy[];
  /** the deepest single taxon whose subtree contains EVERY occurrence, or
   * null when the family spans more than one top-level lineage. */
  commonAncestor: EnclosingClade | null;
  /** the tightest clade(s) wrapping the occurrences: one entry when there is
   * a common ancestor, several when the family sits in disjoint lineages. */
  enclosingClades: EnclosingClade[];
  /** the broadest rank at which the family occupies more than one taxon —
   * i.e. how deep you go before its distribution splits. null when it never
   * splits (a single tip lineage). */
  spreadRank: string | null;
  /** distinct taxa at spreadRank the family occupies (1 when it never splits). */
  separateLineages: number;
  /** the single taxon holding the largest share of occurrences, taken at the
   * broadest informative rank present (phylum, else genus, …). */
  dominantClade: { name: string; rank: string; share: number } | null;
  /** dominantClade.share; 1 when confined to one clade, 0 when empty. */
  concentration: number;
  /** phyla occupied ÷ phyla present. null when the tree has no phylum rank
   * (e.g. MIBiG-only data, which is a flat fan of species). */
  phylumBreadth: number | null;
  /** occurrences that sit alone in their genus, with at least one other
   * member-bearing genus elsewhere — lone hits away from the main mass. */
  isolatedOccurrences: number;
  /** a purely descriptive one-liner. Never an evolutionary inference. */
  patternLabel: string;
}

export function rankPlural(rank: string | null | undefined): string {
  switch (rank) {
    case "domain":
      return "domains";
    case "phylum":
      return "phyla";
    case "class":
      return "classes";
    case "order":
      return "orders";
    case "family":
      return "families";
    case "genus":
      return "genera";
    case "species":
      return "species";
    default:
      return rank ? `${rank}s` : "lineages";
  }
}

/** The tightest clade(s) that wrap a family's occurrences. Returns one clade
 * when a single taxon contains every occurrence; one per disjoint lineage
 * otherwise. A clade that funnels all its members through a single child
 * taxon is skipped in favour of that child — the point is the *smallest*
 * wrapper, not the first. */
export function familyEnclosingClades(
  root: TaxonDisplayNode,
  familyId: string | null,
): EnclosingClade[] {
  if (!familyId) return [];
  const { memberGenomeCountByNode } = familyMembershipSets(root, familyId);
  if ((memberGenomeCountByNode.get(nodeKey(root)) ?? 0) === 0) return [];

  const out: EnclosingClade[] = [];

  function descend(node: DisplayNode): void {
    if (node._kind === "genome") {
      out.push({ key: nodeKey(node), name: node.accession, rank: null, memberGenomes: 1 });
      return;
    }
    const childrenWithMembers: DisplayNode[] = [
      ...node.children.map((c) => ({ ...c, _kind: "taxon" as const })),
      ...node.direct_genomes.map((g) => ({ ...g, _kind: "genome" as const })),
    ].filter((c) => (memberGenomeCountByNode.get(nodeKey(c)) ?? 0) > 0);

    if (node.id === null) {
      // synthetic root: each member-bearing lineage is wrapped on its own.
      for (const child of childrenWithMembers) descend(child);
      return;
    }
    if (
      childrenWithMembers.length === 1 &&
      childrenWithMembers[0]!._kind === "taxon" &&
      node.rank !== "species"
    ) {
      descend(childrenWithMembers[0]!);
      return;
    }
    out.push({
      key: nodeKey(node),
      name: node.name,
      rank: node.rank,
      memberGenomes: memberGenomeCountByNode.get(nodeKey(node)) ?? 0,
    });
  }

  descend(root);
  return out;
}

function describeFamilyPattern(d: {
  memberGenomeCount: number;
  commonAncestor: EnclosingClade | null;
  enclosingClades: EnclosingClade[];
  spreadRank: string | null;
  separateLineages: number;
  dominantClade: { name: string; rank: string; share: number } | null;
  concentration: number;
  isolatedOccurrences: number;
}): string {
  if (d.memberGenomeCount === 0) return "Not found in the loaded tree";

  let main: string;
  if (d.memberGenomeCount === 1) {
    const where = d.commonAncestor?.name ?? d.enclosingClades[0]?.name ?? "one genome";
    main = `Single occurrence, in ${where}`;
  } else if (d.spreadRank === null && d.commonAncestor) {
    main = `Confined to ${d.commonAncestor.name}`;
  } else if (d.commonAncestor) {
    const rankNote = d.commonAncestor.rank ? ` (${d.commonAncestor.rank})` : "";
    main = `Within ${d.commonAncestor.name}${rankNote}, across ${d.separateLineages} ${rankPlural(d.spreadRank)}`;
  } else if (d.concentration >= 0.75 && d.dominantClade) {
    const pct = Math.round(d.dominantClade.share * 100);
    const others = d.separateLineages - 1;
    main = `Concentrated in ${d.dominantClade.name} (${pct}% of occurrences)${
      others > 0 ? `, also in ${others} other ${rankPlural(d.dominantClade.rank)}` : ""
    }`;
  } else {
    main = `Dispersed across ${d.separateLineages} ${rankPlural(d.spreadRank ?? "lineage")}`;
  }

  if (d.isolatedOccurrences > 0) {
    main += ` · ${d.isolatedOccurrences} isolated single-genome occurrence${
      d.isolatedOccurrences === 1 ? "" : "s"
    }`;
  }
  return main;
}

/** The full distribution picture for one family. Returns null only when no
 * family id is given; an unknown id yields a well-formed "empty" result so
 * callers never have to special-case it. */
export function familyDistribution(
  root: TaxonDisplayNode,
  familyId: string | null,
): FamilyDistribution | null {
  if (!familyId) return null;

  const { memberGenomeCountByNode, memberBgcCountByNode } = familyMembershipSets(root, familyId);
  const rootKey = nodeKey(root);
  const memberGenomeCount = memberGenomeCountByNode.get(rootKey) ?? 0;
  const memberBgcCount = memberBgcCountByNode.get(rootKey) ?? 0;
  const totalGenomes = root.genome_count;

  const totalByRank = new Map<string, number>();
  const containingByRank = new Map<string, number>();
  const generaMemberCounts: number[] = [];

  (function walk(node: DisplayNode): void {
    if (node._kind === "genome") return;
    if (node.rank) {
      totalByRank.set(node.rank, (totalByRank.get(node.rank) ?? 0) + 1);
      const membersHere = memberGenomeCountByNode.get(nodeKey(node)) ?? 0;
      if (membersHere > 0) {
        containingByRank.set(node.rank, (containingByRank.get(node.rank) ?? 0) + 1);
        if (node.rank === "genus") generaMemberCounts.push(membersHere);
      }
    }
    node.children.forEach((c) => walk({ ...c, _kind: "taxon" }));
  })(root);

  const byRank: RankOccupancy[] = RANKS_BROAD_TO_DEEP.filter(
    (r) => (totalByRank.get(r) ?? 0) > 0,
  ).map((r) => ({
    rank: r,
    containing: containingByRank.get(r) ?? 0,
    total: totalByRank.get(r) ?? 0,
  }));

  const enclosingClades = familyEnclosingClades(root, familyId);
  const commonAncestor =
    enclosingClades.length === 1 && enclosingClades[0]!.rank !== null ? enclosingClades[0]! : null;

  const spreadRank = RANKS_BROAD_TO_DEEP.find((r) => (containingByRank.get(r) ?? 0) > 1) ?? null;
  const separateLineages = spreadRank ? (containingByRank.get(spreadRank) ?? 1) : 1;

  const domRank: string | null =
    (totalByRank.get("phylum") ?? 0) > 0
      ? "phylum"
      : (totalByRank.get("genus") ?? 0) > 0
        ? "genus"
        : (RANKS_BROAD_TO_DEEP.find((r) => (totalByRank.get(r) ?? 0) > 0) ?? null);

  let dominantClade: FamilyDistribution["dominantClade"] = null;
  if (domRank && memberGenomeCount > 0) {
    let bestName = "";
    let bestCount = 0;
    (function walk(node: DisplayNode): void {
      if (node._kind === "genome") return;
      if (node.rank === domRank) {
        const c = memberGenomeCountByNode.get(nodeKey(node)) ?? 0;
        if (c > bestCount) {
          bestCount = c;
          bestName = node.name;
        }
      }
      node.children.forEach((child) => walk({ ...child, _kind: "taxon" }));
    })(root);
    if (bestCount > 0) {
      dominantClade = { name: bestName, rank: domRank, share: bestCount / memberGenomeCount };
    }
  }
  const concentration = memberGenomeCount === 0 ? 0 : dominantClade ? dominantClade.share : 1;

  const phylaTotal = totalByRank.get("phylum") ?? 0;
  const phylaContaining = containingByRank.get("phylum") ?? 0;
  const phylumBreadth = phylaTotal > 0 ? phylaContaining / phylaTotal : null;

  const generaWithMembers = generaMemberCounts.length;
  const isolatedOccurrences =
    generaWithMembers >= 2 ? generaMemberCounts.filter((n) => n === 1).length : 0;

  const patternLabel = describeFamilyPattern({
    memberGenomeCount,
    commonAncestor,
    enclosingClades,
    spreadRank,
    separateLineages,
    dominantClade,
    concentration,
    isolatedOccurrences,
  });

  return {
    familyId,
    memberBgcCount,
    memberGenomeCount,
    totalGenomes,
    prevalence: totalGenomes > 0 ? memberGenomeCount / totalGenomes : 0,
    byRank,
    commonAncestor,
    enclosingClades,
    spreadRank,
    separateLineages,
    dominantClade,
    concentration,
    phylumBreadth,
    isolatedOccurrences,
    patternLabel,
  };
}

/** A cheap per-family distribution summary for EVERY family in the tree,
 * built in a single pass. Used to make the family browser searchable and
 * sortable by distribution shape without running the full
 * `familyDistribution` for each one. */
export interface FamilyIndexEntry {
  genomeCount: number;
  speciesCount: number;
  genusCount: number;
  phylumCount: number;
  /** phylum names carrying the family, for a compact browser glyph. */
  phyla: string[];
  bgcClasses: string[];
}

export function familyTreeIndex(root: TaxonDisplayNode): Map<string, FamilyIndexEntry> {
  const acc = new Map<
    string,
    {
      genomes: Set<string>;
      species: Set<string>;
      genera: Set<string>;
      phyla: Set<string>;
      classes: Set<string>;
    }
  >();

  const get = (fid: string) => {
    let e = acc.get(fid);
    if (!e) {
      e = { genomes: new Set(), species: new Set(), genera: new Set(), phyla: new Set(), classes: new Set() };
      acc.set(fid, e);
    }
    return e;
  };

  function walk(node: DisplayNode, ancestry: { rank: string | null; name: string }[]): void {
    if (node._kind === "genome") {
      const phylum = ancestry.find((a) => a.rank === "phylum")?.name;
      const genus = ancestry.find((a) => a.rank === "genus")?.name;
      const species = ancestry.find((a) => a.rank === "species")?.name;
      for (const bgc of node.bgcs) {
        for (const fid of bgc.family_ids) {
          const e = get(fid);
          e.genomes.add(nodeKey(node));
          if (phylum) e.phyla.add(phylum);
          if (genus) e.genera.add(genus);
          if (species) e.species.add(species);
          for (const cls of bgcComponentClasses(bgc)) e.classes.add(cls);
        }
      }
      return;
    }
    const next = node.rank ? [...ancestry, { rank: node.rank, name: node.name }] : ancestry;
    node.direct_genomes.forEach((g) => walk({ ...g, _kind: "genome" }, next));
    node.children.forEach((c) => walk({ ...c, _kind: "taxon" }, next));
  }

  walk(root, []);

  const out = new Map<string, FamilyIndexEntry>();
  for (const [fid, e] of acc) {
    out.set(fid, {
      genomeCount: e.genomes.size,
      speciesCount: e.species.size,
      genusCount: e.genera.size,
      phylumCount: e.phyla.size,
      phyla: [...e.phyla].sort(),
      bgcClasses: [...e.classes].sort(),
    });
  }
  return out;
}

/**
 * Resolve an incoming MIBiG accession (e.g. from an antiSMASH
 * KnownClusterBlast hit, passed as `?bgc=BGC0000123`) to a place on the
 * tree: the genome that carries it, the clade to frame on, and the
 * biosynthetic class(es) to highlight the distribution of. Returns null if
 * that accession isn't in the loaded dataset.
 */
export interface MibigHit {
  genomeId: string;
  focusKey: string;
  bgcClasses: string[];
  taxonName: string | null;
}

export function findMibigEntry(
  root: TaxonDisplayNode,
  mibigAccession: string,
): MibigHit | null {
  const target = mibigAccession.trim();
  let hit: MibigHit | null = null;

  function walk(node: DisplayNode, ancestors: TaxonDisplayNode[]): void {
    if (hit) return;
    if (node._kind === "genome") {
      const bgc = node.bgcs.find((b) => b.mibig_accession === target);
      if (bgc) {
        const framed =
          [...ancestors].reverse().find((a) => a.rank === "genus" || a.rank === "family") ??
          ancestors[ancestors.length - 1] ??
          root;
        hit = {
          genomeId: node.id,
          focusKey: nodeKey(framed),
          bgcClasses: bgcComponentClasses(bgc),
          taxonName: ancestors[ancestors.length - 1]?.name ?? null,
        };
      }
      return;
    }
    const next = [...ancestors, node];
    for (const g of node.direct_genomes) walk({ ...g, _kind: "genome" }, next);
    for (const c of node.children) walk({ ...c, _kind: "taxon" }, next);
  }

  walk(root, []);
  return hit;
}

/** nodeKey of the first taxon whose name matches (case-insensitive) — for
 * a `?taxon=Streptomyces` deep link. */
export function findTaxonKeyByName(root: TaxonDisplayNode, name: string): string | null {
  const target = name.trim().toLowerCase();
  let found: string | null = null;
  function walk(node: TaxonDisplayNode): void {
    if (found) return;
    if (node.name.toLowerCase() === target) {
      found = nodeKey(node);
      return;
    }
    for (const c of node.children) walk({ ...c, _kind: "taxon" });
  }
  walk(root);
  return found;
}

/** bgc id → the families it belongs to. Lets a BGC selection offer "show
 * this cluster's family across the tree" without a second request — the
 * family_ids are already on every BGCSummary in the tree payload. */
export function bgcFamilyIndex(root: TaxonDisplayNode): Map<string, string[]> {
  const out = new Map<string, string[]>();
  (function walk(node: DisplayNode): void {
    if (node._kind === "genome") {
      for (const b of node.bgcs) {
        if (b.family_ids.length) out.set(b.id, [...b.family_ids]);
      }
      return;
    }
    node.direct_genomes.forEach((g) => walk({ ...g, _kind: "genome" }));
    node.children.forEach((c) => walk({ ...c, _kind: "taxon" }));
  })(root);
  return out;
}

/**
 * Frame the tree on a family: the collapse set that keeps every lineage
 * containing the family fully expanded and folds everything else down to a
 * single summary glyph. Turns "a few pale nodes lost in a large canvas"
 * into "the containing lineages, and a rim of collapsed context".
 *
 * `memberNodeKeys` is `familyMembershipSets(...).nodeKeys`. Only the
 * shallowest non-member node on each branch is collapsed — collapsing its
 * descendants too would be redundant and leave stale keys on re-expand,
 * the same rule collapseToLevel follows.
 */
export function collapseToFamily(
  root: TaxonDisplayNode,
  memberNodeKeys: ReadonlySet<string>,
): Set<string> {
  const collapsed = new Set<string>();

  function walk(node: DisplayNode): void {
    if (node._kind === "genome") return;
    const key = nodeKey(node);
    if (!memberNodeKeys.has(key)) {
      if (node.id !== null) collapsed.add(key);
      return; // nothing below a collapsed node needs a key
    }
    node.children.forEach((c) => walk({ ...c, _kind: "taxon" }));
  }

  // The synthetic root is never collapsed; its children are evaluated
  // individually so non-member top-level clades fold away too.
  root.children.forEach((c) => walk({ ...c, _kind: "taxon" }));
  return collapsed;
}
