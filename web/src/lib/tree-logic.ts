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
