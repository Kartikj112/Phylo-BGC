import { describe, expect, it } from "vitest";
import type { BackboneTreeNode, GenomeSummary } from "./api-types";
import {
  asTaxonTree,
  findBackboneNode,
  isComparable,
  isOmittedSummary,
  isReferenceOnly,
  isUnloaded,
  mergeBackbone,
  mergeBackboneAt,
  omittedSummaryParentKey,
  referenceGenomeCount,
  spliceBackboneNode,
  unloadedChildCount,
} from "./backbone";
import {
  EMPTY_FILTERS,
  applyGenomeFilters,
  coverageRollupIndex,
  pruneToBgcBearing,
  toRootDisplayNode,
} from "./tree-logic";

function node(
  name: string,
  over: Partial<BackboneTreeNode> = {},
  children: BackboneTreeNode[] = [],
): BackboneTreeNode {
  return {
    id: `id-${name}`,
    name,
    rank: "genus",
    genome_count: 0,
    examined_genome_count: 0,
    curated_only_genome_count: 0,
    bgc_genome_count: 0,
    bgc_class_counts: {},
    direct_genomes: [],
    children,
    backbone_id: `bb-${name}`,
    corpus_taxon_id: null,
    reference_genome_count: 10,
    reference_species_count: 2,
    representative_accession: null,
    child_count: children.length,
    children_loaded: true,
    omitted_child_count: 0,
    omitted_reference_genome_count: 0,
    ...over,
  };
}

function genome(accession: string, bgcClasses: string[]): GenomeSummary {
  return {
    id: `g-${accession}`,
    accession,
    bgcs: bgcClasses.map((c, i) => ({ id: `b-${accession}-${i}`, bgc_class: c, family_ids: [] })),
  } as unknown as GenomeSummary;
}

/** root > Bacteria > {Streptomyces (corpus, loaded), Bacillus (reference only, unloaded)} */
function sample(): BackboneTreeNode {
  const strep = node("Streptomyces", {
    genome_count: 1,
    bgc_class_counts: { pks: 1 },
    direct_genomes: [genome("GCF_1.1", ["pks"])],
  });
  const bacillus = node("Bacillus", { children_loaded: false, child_count: 40 });
  const bacteria = node("Bacteria", { rank: "domain", genome_count: 1, bgc_class_counts: { pks: 1 } }, [
    strep,
    bacillus,
  ]);
  return node("root", { id: null, rank: null, backbone_id: null, genome_count: 1, bgc_class_counts: { pks: 1 } }, [
    bacteria,
  ]);
}

describe("findBackboneNode", () => {
  it("finds by node key, including the root's", () => {
    const root = sample();
    expect(findBackboneNode(root, "id-Bacillus")?.name).toBe("Bacillus");
    expect(findBackboneNode(root, "__root__")).toBe(root);
    expect(findBackboneNode(root, "missing")).toBeNull();
  });
});

describe("spliceBackboneNode", () => {
  it("replaces the unloaded clade and shares every untouched subtree", () => {
    const root = sample();
    const loaded = node("Bacillus", { child_count: 1 }, [node("Bacillus subtilis", { rank: "species" })]);
    const next = spliceBackboneNode(root, loaded);

    const bacillus = findBackboneNode(next, "id-Bacillus")!;
    expect(isUnloaded(bacillus)).toBe(false);
    expect(bacillus.children.map((c) => c.name)).toEqual(["Bacillus subtilis"]);
    // Only the path to the change is new.
    expect(next).not.toBe(root);
    expect(findBackboneNode(next, "id-Streptomyces")).toBe(findBackboneNode(root, "id-Streptomyces"));
    // The original is untouched.
    expect(isUnloaded(findBackboneNode(root, "id-Bacillus")!)).toBe(true);
  });

  it("is a no-op for a clade not in the tree, e.g. a response after a taxonomy switch", () => {
    const root = sample();
    expect(spliceBackboneNode(root, node("Elsewhere"))).toBe(root);
    expect(spliceBackboneNode(root, node("Corpus only", { backbone_id: null }))).toBe(root);
  });
});

describe("referenceGenomeCount", () => {
  it("reads backbone clades and is zero for plain corpus nodes", () => {
    const root = asTaxonTree(sample());
    expect(referenceGenomeCount(root.children[0]!)).toBe(10);
    const { reference_genome_count: _dropped, ...plain } = sample().children[0]!;
    expect(referenceGenomeCount(asTaxonTree(plain as BackboneTreeNode))).toBe(0);
  });
});

describe("pruneToBgcBearing with the backbone on", () => {
  it("keeps reference-only clades, which have no clusters because nothing examined them", () => {
    const root = toRootDisplayNode(asTaxonTree(sample()));
    const corpusView = pruneToBgcBearing(root, true);
    const bacteria = corpusView.root.children[0]!;
    expect(bacteria.children.map((c) => c.name)).toEqual(["Streptomyces"]);

    const backboneView = pruneToBgcBearing(root, true, true);
    expect(backboneView.root.children[0]!.children.map((c) => c.name)).toEqual(["Streptomyces", "Bacillus"]);
  });

  it("still drops corpus genomes without clusters", () => {
    const tree = sample();
    const strep = tree.children[0]!.children[0]!;
    strep.direct_genomes = [...strep.direct_genomes, genome("GCF_EMPTY.1", [])];
    const pruned = pruneToBgcBearing(toRootDisplayNode(asTaxonTree(tree)), true, true);
    expect(pruned.root.children[0]!.children[0]!.direct_genomes.map((g) => g.accession)).toEqual(["GCF_1.1"]);
  });
});

describe("unloaded clades keep the server's whole-clade counts", () => {
  /** Bacillus: unloaded, 40 corpus genomes, 5 examined and 30 curated-only. */
  function withUnloadedCorpus(): BackboneTreeNode {
    const tree = sample();
    const bacillus = tree.children[0]!.children[1]!;
    Object.assign(bacillus, {
      genome_count: 40,
      examined_genome_count: 5,
      curated_only_genome_count: 30,
      bgc_genome_count: 32,
      bgc_class_counts: { nrps: 12 },
    });
    return tree;
  }

  it("the prune neither recounts nor empties it", () => {
    const pruned = pruneToBgcBearing(toRootDisplayNode(asTaxonTree(withUnloadedCorpus())), true, true);
    const bacillus = pruned.root.children[0]!.children.find((c) => c.name === "Bacillus")!;
    expect(bacillus.genome_count).toBe(40);
    expect(pruned.root.children[0]!.genome_count).toBe(41); // Streptomyces 1 + Bacillus 40
    // The header's "shown" counts what the prune would keep: genomes with
    // clusters, 1 loaded + 32 the server counted in Bacillus.
    expect(pruned.shownGenomes).toBe(33);
  });

  it("genome filters pass it through untested", () => {
    const tree = withUnloadedCorpus();
    const strepGenome = tree.children[0]!.children[0]!.direct_genomes[0]!;
    strepGenome.completeness_pct = 95;
    const filters = { ...EMPTY_FILTERS, minCompletenessPct: 90 };
    const result = applyGenomeFilters(toRootDisplayNode(asTaxonTree(tree)), filters, true);
    // The filter really ran: the one loaded genome matched...
    expect(result.filteredEverythingOut).toBe(false);
    expect(result.matched).toBe(1);
    // ...and the unloaded clade came through untested and uncounted.
    const bacillus = result.root.children[0]!.children.find((c) => c.name === "Bacillus");
    expect(bacillus?.genome_count).toBe(40);
  });

  it("the coverage rollup takes the server's three-state split", () => {
    const index = coverageRollupIndex(toRootDisplayNode(asTaxonTree(withUnloadedCorpus())));
    expect(index.get("id-Bacillus")).toEqual({ genomeCount: 40, examined: 5, curatedOnly: 30, unexamined: 5 });
    // And it rolls up into the parent like any other child.
    expect(index.get("id-Bacteria")?.genomeCount).toBe(41);
  });
});

describe("GTDB-only clades, unopened clades and comparison", () => {
  it("a clade is GTDB-only when it has reference genomes and no corpus taxon", () => {
    const root = asTaxonTree(sample());
    const bacteria = root.children[0]!;
    // Bacteria in the sample has no corpus taxon id either, so give it one.
    const corpusClade = { ...bacteria, corpus_taxon_id: "taxon-1" } as unknown as typeof bacteria;
    expect(isReferenceOnly(corpusClade)).toBe(false);
    expect(isReferenceOnly(bacteria.children.find((c) => c.name === "Bacillus")!)).toBe(true);
    // A plain corpus node (no backbone fields at all) never is.
    expect(isReferenceOnly({ ...bacteria, reference_genome_count: undefined } as unknown as typeof bacteria)).toBe(false);
  });

  it("an unopened clade reports its server-side child count, an opened one none", () => {
    const root = asTaxonTree(sample());
    const bacillus = root.children[0]!.children.find((c) => c.name === "Bacillus")!;
    const strep = root.children[0]!.children.find((c) => c.name === "Streptomyces")!;
    expect(unloadedChildCount(bacillus)).toBe(40);
    expect(unloadedChildCount(strep)).toBe(0);
  });

  it("only corpus clades can be compared", () => {
    const root = asTaxonTree(sample());
    const bacillus = root.children[0]!.children.find((c) => c.name === "Bacillus")!;
    expect(isComparable(bacillus)).toBe(false);
    expect(isComparable({ ...bacillus, corpus_taxon_id: "taxon-2" } as unknown as typeof bacillus)).toBe(true);
    // Outside the backbone view, any real taxon can be compared.
    const plain = { ...bacillus, reference_genome_count: undefined } as unknown as typeof bacillus;
    expect(isComparable(plain)).toBe(true);
  });
});

describe("asTaxonTree adds a row for children the server summarised", () => {
  it("names the count and rank, carries the omitted genomes, and comes last", () => {
    const tree = sample();
    const bacteria = tree.children[0]!;
    bacteria.children = bacteria.children.map((c) => ({ ...c, rank: "genus" as const }));
    bacteria.omitted_child_count = 2080;
    bacteria.omitted_reference_genome_count = 9431;
    const out = asTaxonTree(tree).children[0]!;
    const last = out.children[out.children.length - 1]!;
    expect(isOmittedSummary(last)).toBe(true);
    expect(last.name).toBe("2,080 more genera");
    expect(last.rank).toBe("genus");
    expect(referenceGenomeCount(last)).toBe(9431);
    expect(isReferenceOnly(last)).toBe(true);
    expect(last.id).toBe("id-Bacteria::more");
  });

  it("adds nothing when nothing was omitted, or when the clade is not loaded", () => {
    const tree = sample();
    const bacillus = tree.children[0]!.children[1]!;
    bacillus.omitted_child_count = 5; // unloaded: its children are not on the client at all
    const out = asTaxonTree(tree).children[0]!;
    expect(out.children.some(isOmittedSummary)).toBe(false);
    expect(out.children.find((c) => c.name === "Bacillus")!.children).toEqual([]);
  });

  it("the summary row survives the BGC prune, like any GTDB-only clade", () => {
    const tree = sample();
    tree.children[0]!.omitted_child_count = 3;
    tree.children[0]!.omitted_reference_genome_count = 7;
    const pruned = pruneToBgcBearing(toRootDisplayNode(asTaxonTree(tree)), true, true);
    expect(pruned.root.children[0]!.children.map((c) => c.name)).toContain("3 more genera");
  });
});

describe("the synthetic root", () => {
  it("is never drawn as GTDB-only, though it has no corpus taxon of its own", () => {
    expect(isReferenceOnly(asTaxonTree(sample()))).toBe(false);
  });
});


describe("mergeBackbone", () => {
  const unloaded = (name: string, over: Partial<BackboneTreeNode> = {}) =>
    node(name, { children_loaded: false, child_count: 3, ...over });

  it("keeps what was opened before and adds the path", () => {
    // Held: Bacteria open with Actinomycetota open; Bacillota closed.
    const held = node("root", { id: null, backbone_id: null }, [
      node("Bacteria", { rank: "domain" }, [
        node("Actinomycetota", { rank: "phylum" }, [unloaded("Actinomycetes")]),
        unloaded("Bacillota"),
      ]),
    ]);
    // Path: down to Bacilli, with Actinomycetota closed.
    const path = node("root", { id: null, backbone_id: null }, [
      node("Bacteria", { rank: "domain" }, [
        unloaded("Actinomycetota"),
        node("Bacillota", { rank: "phylum" }, [node("Bacilli", { rank: "class" })]),
      ]),
    ]);
    const merged = mergeBackbone(held, path);
    const bacteria = merged.children[0]!;
    expect(bacteria.children.map((c) => c.name)).toEqual(["Actinomycetota", "Bacillota"]);
    // The earlier opening survives, and is the very same object.
    expect(bacteria.children[0]).toBe(held.children[0]!.children[0]);
    expect(bacteria.children[1]!.children_loaded).toBe(true);
    expect(bacteria.children[1]!.children.map((c) => c.name)).toEqual(["Bacilli"]);
  });

  it("adds a clade the held response summarised away, and recounts the summary", () => {
    const held = node("Streptomyces", { omitted_child_count: 5, omitted_reference_genome_count: 40 }, [
      node("S. alpha"),
    ]);
    const path = node("Streptomyces", { omitted_child_count: 5 }, [
      node("S. alpha"),
      node("S. zeta", { reference_genome_count: 3 }),
    ]);
    const merged = mergeBackbone(held, path);
    expect(merged.children.map((c) => c.name)).toEqual(["S. alpha", "S. zeta"]);
    expect(merged.omitted_child_count).toBe(4);
    expect(merged.omitted_reference_genome_count).toBe(37);
  });

  it("returns the held tree itself when the response adds nothing", () => {
    const held = node("root", { id: null, backbone_id: null }, [node("Bacteria")]);
    expect(mergeBackbone(held, node("root", { id: null, backbone_id: null }, [unloaded("Bacteria")]))).toBe(held);
    expect(mergeBackbone(held, unloaded("root"))).toBe(held);
  });
});

describe("mergeBackboneAt", () => {
  it("lists a deep clade's remaining children and keeps its open ones open", () => {
    const opened = node("S. alpha", { rank: "species" }, [node("strain", { rank: null })]);
    const genus = node("Streptomyces", { omitted_child_count: 2, omitted_reference_genome_count: 5 }, [opened]);
    const root = node("root", { id: null, backbone_id: null }, [node("Bacteria", { rank: "domain" }, [genus])]);
    const all = node("Streptomyces", {}, [
      node("S. alpha", { rank: "species", children_loaded: false, child_count: 1 }),
      node("S. beta", { rank: "species", reference_genome_count: 3 }),
      node("S. gamma", { rank: "species", reference_genome_count: 2 }),
    ]);
    const merged = mergeBackboneAt(root, all);
    const g = merged.children[0]!.children[0]!;
    expect(g.children.map((c) => c.name)).toEqual(["S. alpha", "S. beta", "S. gamma"]);
    expect(g.children[0]).toBe(opened);
    expect(g.omitted_child_count).toBe(0);
    expect(g.omitted_reference_genome_count).toBe(0);
  });
});

describe("omittedSummaryParentKey", () => {
  it("names the clade a summary row belongs to, and nothing else", () => {
    expect(omittedSummaryParentKey("abc::more")).toBe("abc");
    expect(omittedSummaryParentKey("__root__::more")).toBe("__root__");
    expect(omittedSummaryParentKey("abc")).toBeNull();
  });
});
