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

/** Corpus genomes with at least one cluster in a backbone clade, as the
 * server counted them. What "only genomes with BGCs" counts for a clade
 * whose genomes are not on the client. */
export function bgcGenomeCount(node: TaxonTreeNode): number {
  return (node as Partial<BackboneTreeNode>).bgc_genome_count ?? 0;
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

/** A clade that is in the reference taxonomy but not in the corpus: nothing
 * in this database is recorded for it, and none of its genomes has been
 * examined for clusters. Plain corpus trees have none. */
export function isReferenceOnly(node: TaxonTreeNode): boolean {
  const b = node as Partial<BackboneTreeNode>;
  // The synthetic root (id null) is neither: it holds the corpus too.
  return node.id !== null && b.reference_genome_count !== undefined && b.corpus_taxon_id == null;
}

/** Children an unloaded clade has on the server, for the "(+N)" a collapsed
 * clade shows. Zero once loaded, and for plain corpus nodes. */
export function unloadedChildCount(node: TaxonTreeNode): number {
  return isUnloadedClade(node) ? ((node as Partial<BackboneTreeNode>).child_count ?? 0) : 0;
}

/** Whether a node is the synthetic "N more species" row (see asTaxonTree). */
export function isOmittedSummary(node: TaxonTreeNode): boolean {
  return (node as { omitted_summary?: boolean }).omitted_summary === true;
}

/** Whether clade comparison can take this node: the comparison endpoint
 * reads corpus taxa, so a GTDB-only clade has nothing for it to compare. */
export function isComparable(node: TaxonTreeNode): boolean {
  const b = node as Partial<BackboneTreeNode>;
  if (b.reference_genome_count === undefined) return node.id !== null;
  return b.corpus_taxon_id != null;
}

const RANK_PLURAL: Record<string, string> = {
  domain: "domains",
  kingdom: "kingdoms",
  phylum: "phyla",
  class: "classes",
  order: "orders",
  family: "families",
  genus: "genera",
  species: "species",
};

/** The row standing in for a clade's children the server summarised rather
 * than listed. Reference-only by construction: the server never omits a
 * child that holds corpus genomes. */
function omittedSummaryNode(parent: BackboneTreeNode, siblingRank: BackboneTreeNode["rank"]): BackboneTreeNode {
  const n = parent.omitted_child_count;
  const noun = siblingRank ? (RANK_PLURAL[siblingRank] ?? "clades") : "clades";
  return {
    id: `${parent.id ?? "__root__"}::more`,
    name: `${n.toLocaleString("en-US")} more ${noun}`,
    rank: siblingRank,
    genome_count: 0,
    examined_genome_count: 0,
    curated_only_genome_count: 0,
    bgc_genome_count: 0,
    bgc_class_counts: {},
    direct_genomes: [],
    children: [],
    backbone_id: null,
    corpus_taxon_id: null,
    reference_genome_count: parent.omitted_reference_genome_count,
    reference_species_count: 0,
    representative_accession: null,
    child_count: 0,
    children_loaded: true,
    omitted_child_count: 0,
    omitted_reference_genome_count: 0,
    ...({ omitted_summary: true } as object),
  };
}

/** The backbone tree as the corpus tree type the rest of the page reads.
 *
 * A widening, not a conversion: `BackboneTreeNode` carries every
 * `TaxonTreeNode` field with the same meaning, and the extras ride along
 * for the parts of the interface that know to look for them. The one thing
 * added is a synthetic last child wherever the server summarised a clade's
 * children, so "and 2,080 more species" is on the tree rather than silently
 * missing from it. */
export function asTaxonTree(root: BackboneTreeNode): TaxonTreeNode {
  function withSummaries(node: BackboneTreeNode): BackboneTreeNode {
    const children = node.children.map(withSummaries);
    if (node.children_loaded && node.omitted_child_count > 0) {
      const siblingRank = node.children.find((c) => c.backbone_id)?.rank ?? node.children[0]?.rank ?? null;
      children.push(omittedSummaryNode(node, siblingRank));
    }
    return { ...node, children };
  }
  return withSummaries(root) as unknown as TaxonTreeNode;
}
