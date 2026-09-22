/**
 * The reference backbone, loaded a clade at a time. Pure logic: no React.
 *
 * `/api/v1/backbone/tree` answers with nodes shaped like `TaxonTreeNode` plus
 * `reference_*` counts and a `children_loaded` flag (see
 * engine/src/bgcscape/api/backbone_tree.py). The page keeps ONE growing tree:
 * it starts with the top levels, and each clade the reader opens is fetched
 * and spliced in where it was. Because every corpus field keeps its
 * `/taxonomy-tree` meaning, that tree goes through the same filter, focus and
 * collapse pipeline as the corpus tree.
 */
import type { BackboneTreeNode, TaxonTreeNode } from "./api-types";

/** A backbone node that has not had its children fetched yet. */
export function isUnloaded(node: Pick<BackboneTreeNode, "children_loaded">): boolean {
  return !node.children_loaded;
}

/** Whether a node counts reference genomes, i.e. is a backbone clade. Read
 * off a `TaxonTreeNode`, which is how the rest of the page sees the tree. */
export function referenceGenomeCount(node: TaxonTreeNode): number {
  return (node as Partial<BackboneTreeNode>).reference_genome_count ?? 0;
}

/** Whether a node in the page's tree is a backbone clade whose children have
 * not been fetched. Its counts came from the server and cover the whole
 * clade; nothing below it is on the client to recount, filter or prune. */
export function isUnloadedClade(node: TaxonTreeNode): boolean {
  return (node as Partial<BackboneTreeNode>).children_loaded === false;
}

/** Curated-only corpus genomes in a backbone clade, as the server counted
 * them. Zero for plain corpus nodes, which carry their genomes instead. */
export function curatedOnlyCount(node: TaxonTreeNode): number {
  return (node as Partial<BackboneTreeNode>).curated_only_genome_count ?? 0;
}

/** The node whose `id` (the tree's node key) is `key`, or null. */
export function findBackboneNode(root: BackboneTreeNode, key: string): BackboneTreeNode | null {
  if ((root.id ?? "__root__") === key) return root;
  for (const child of root.children) {
    const hit = findBackboneNode(child, key);
    if (hit) return hit;
  }
  return null;
}

/**
 * Put a freshly fetched clade into the tree, in place of its unloaded self.
 *
 * Matched on `backbone_id`, which is what was fetched. Returns a new tree
 * that shares every untouched subtree with the old one, so React memos
 * keyed on those subtrees stay valid. Returns `root` itself when the clade
 * is not in the tree (a response that arrived after a taxonomy switch).
 */
export function spliceBackboneNode(root: BackboneTreeNode, loaded: BackboneTreeNode): BackboneTreeNode {
  if (!loaded.backbone_id) return root;
  function visit(node: BackboneTreeNode): BackboneTreeNode {
    if (node.backbone_id === loaded.backbone_id) return loaded;
    let changed = false;
    const children = node.children.map((child) => {
      const next = visit(child);
      if (next !== child) changed = true;
      return next;
    });
    return changed ? { ...node, children } : node;
  }
  return visit(root);
}

/** The backbone tree as the corpus tree type the rest of the page reads.
 *
 * A widening, not a conversion: `BackboneTreeNode` carries every
 * `TaxonTreeNode` field with the same meaning, and the extras ride along
 * for the parts of the interface that know to look for them. */
export function asTaxonTree(root: BackboneTreeNode): TaxonTreeNode {
  return root as unknown as TaxonTreeNode;
}
