import { describe, expect, it } from "vitest";
import {
  bgcComponentClasses,
  bgcMatchesActiveClasses,
  computeTreeLayout,
  countBgcClasses,
  genomeMatchesActiveClasses,
  hiddenChildrenCount,
  makeChildrenAccessor,
  matchesQuery,
  nodeKey,
  nodeVisibleClasses,
  toDisplayChildren,
  toRootDisplayNode,
} from "./tree-logic";
import { buildFixtureTree, findTaxonByName } from "./test-fixtures";
import type { GenomeDisplayNode } from "./api-types";

describe("nodeKey", () => {
  it("uses the sentinel for the null-id synthetic root", () => {
    const root = toRootDisplayNode(buildFixtureTree());
    expect(nodeKey(root)).toBe("__root__");
  });

  it("uses the real id for a normal taxon", () => {
    const tree = buildFixtureTree();
    const strep = findTaxonByName(tree, "Streptomyces")!;
    expect(nodeKey({ ...strep, _kind: "taxon" })).toBe(strep.id);
  });
});

describe("toDisplayChildren", () => {
  it("returns null for a genome (leaf)", () => {
    const tree = buildFixtureTree();
    const setae = findTaxonByName(tree, "Kitasatospora setae")!;
    const genomeNode: GenomeDisplayNode = { ...setae.direct_genomes[0]!, _kind: "genome" };
    expect(toDisplayChildren(genomeNode)).toBeNull();
  });

  it("combines children + direct_genomes for a taxon with both absent one", () => {
    const tree = buildFixtureTree();
    const strep = findTaxonByName(tree, "Streptomyces")!;
    const children = toDisplayChildren({ ...strep, _kind: "taxon" });
    expect(children).toHaveLength(3); // 3 species, no direct genomes at genus level
    expect(children!.every((c) => c._kind === "taxon")).toBe(true);
  });

  it("returns genome-kind children for a species with direct_genomes", () => {
    const tree = buildFixtureTree();
    const coelicolor = findTaxonByName(tree, "Streptomyces coelicolor")!;
    const children = toDisplayChildren({ ...coelicolor, _kind: "taxon" });
    expect(children).toHaveLength(1);
    expect(children![0]!._kind).toBe("genome");
  });

  it("returns null for a taxon with no children at all", () => {
    // Not present in the fixture tree by construction, but the function
    // must handle it since a real GTDB genus with zero classified genomes
    // yet is a legitimate state.
    const empty = toRootDisplayNode({
      id: "empty",
      name: "Emptygenus",
      rank: "genus",
      genome_count: 0,
      bgc_class_counts: {},
      direct_genomes: [],
      children: [],
    });
    expect(toDisplayChildren(empty)).toBeNull();
  });
});

describe("bgcComponentClasses / bgcMatchesActiveClasses — the hybrid-filtering regression", () => {
  const tree = buildFixtureTree();
  const avermitilis = findTaxonByName(tree, "Streptomyces avermitilis")!;
  const genome = avermitilis.direct_genomes[0]!;
  const hybridBgc = genome.bgcs.find((b) => b.bgc_class === "hybrid")!;
  const terpeneBgc = genome.bgcs.find((b) => b.bgc_class === "terpene")!;

  it("fixture sanity: the hybrid BGC exists with subtype nrps+pks", () => {
    expect(hybridBgc).toBeDefined();
    expect(hybridBgc.subtype).toBe("nrps+pks");
  });

  it("decomposes a hybrid BGC into its component classes", () => {
    expect(bgcComponentClasses(hybridBgc)).toEqual(["nrps", "pks"]);
  });

  it("a plain (non-hybrid) BGC decomposes to itself", () => {
    expect(bgcComponentClasses(terpeneBgc)).toEqual(["terpene"]);
  });

  it("THE BUG: a hybrid BGC must match an nrps-only filter via its component", () => {
    const nrpsOnly = new Set(["nrps"]);
    expect(bgcMatchesActiveClasses(hybridBgc, nrpsOnly)).toBe(true);
  });

  it("negative control: a plain terpene BGC does NOT match an nrps-only filter", () => {
    const nrpsOnly = new Set(["nrps"]);
    expect(bgcMatchesActiveClasses(terpeneBgc, nrpsOnly)).toBe(false);
  });

  it("genome-level match succeeds via the hybrid even though no plain 'nrps' BGC exists on it", () => {
    expect(genome.bgcs.some((b) => b.bgc_class === "nrps")).toBe(false); // fixture sanity
    const genomeDisplay: GenomeDisplayNode = { ...genome, _kind: "genome" };
    expect(genomeMatchesActiveClasses(genomeDisplay, new Set(["nrps"]))).toBe(true);
  });
});

describe("nodeVisibleClasses", () => {
  it("rolls up hybrid components at the genus level, never the literal 'hybrid'", () => {
    const tree = buildFixtureTree();
    const strep = findTaxonByName(tree, "Streptomyces")!;
    const visible = nodeVisibleClasses({ ...strep, _kind: "taxon" });
    expect(visible.has("nrps")).toBe(true);
    expect(visible.has("pks")).toBe(true);
    expect(visible.has("hybrid")).toBe(false);
  });
});

describe("countBgcClasses", () => {
  it("matches manual counts across the whole fixture tree", () => {
    const root = toRootDisplayNode(buildFixtureTree());
    const counts = countBgcClasses(root);
    // nrps: coelicolor(1) + avermitilis hybrid component(1) = 2
    expect(counts.nrps).toBe(2);
    // pks: coelicolor(1) + avermitilis plain pks(1) + avermitilis hybrid component(1) = 3
    expect(counts.pks).toBe(3);
    expect(counts.terpene).toBe(1);
    expect(counts.ripp).toBe(1);
    expect(counts.saccharide).toBe(1);
    expect(counts.hybrid).toBeUndefined();
  });
});

describe("matchesQuery", () => {
  it("matches case-insensitively on taxon name", () => {
    const tree = buildFixtureTree();
    const strep = findTaxonByName(tree, "Streptomyces avermitilis")!;
    expect(matchesQuery({ ...strep, _kind: "taxon" }, "AVERMITILIS")).toBe(true);
  });

  it("matches on genome accession", () => {
    const tree = buildFixtureTree();
    const coelicolor = findTaxonByName(tree, "Streptomyces coelicolor")!;
    const g: GenomeDisplayNode = { ...coelicolor.direct_genomes[0]!, _kind: "genome" };
    expect(matchesQuery(g, "test_coelicolor")).toBe(true);
  });

  it("empty query never matches", () => {
    const tree = buildFixtureTree();
    const strep = findTaxonByName(tree, "Streptomyces")!;
    expect(matchesQuery({ ...strep, _kind: "taxon" }, "")).toBe(false);
    expect(matchesQuery({ ...strep, _kind: "taxon" }, "   ")).toBe(false);
  });
});

describe("collapse: makeChildrenAccessor / hiddenChildrenCount", () => {
  it("a collapsed node reports no children via the accessor", () => {
    const tree = buildFixtureTree();
    const strep = findTaxonByName(tree, "Streptomyces")!;
    const node = { ...strep, _kind: "taxon" as const };
    const accessor = makeChildrenAccessor(new Set([strep.id!]));
    expect(accessor(node)).toBeNull();
  });

  it("an uncollapsed node still reports its children", () => {
    const tree = buildFixtureTree();
    const strep = findTaxonByName(tree, "Streptomyces")!;
    const node = { ...strep, _kind: "taxon" as const };
    const accessor = makeChildrenAccessor(new Set());
    expect(accessor(node)).toHaveLength(3);
  });

  it("hiddenChildrenCount reports the real count only when collapsed", () => {
    const tree = buildFixtureTree();
    const strep = findTaxonByName(tree, "Streptomyces")!;
    const node = { ...strep, _kind: "taxon" as const };
    expect(hiddenChildrenCount(node, new Set())).toBe(0);
    expect(hiddenChildrenCount(node, new Set([strep.id!]))).toBe(3);
  });
});

describe("computeTreeLayout", () => {
  it("includes every visible node when nothing is collapsed", () => {
    const root = toRootDisplayNode(buildFixtureTree());
    const layout = computeTreeLayout(root, new Set(), 800);
    // root + Bacteria + Actinomycetota + Actinomycetes + Streptomycetales +
    // Streptomycetaceae + (Streptomyces + 3 species + 3 genomes) +
    // (Kitasatospora + 1 species + 1 genome) = 1+1+1+1+1+1 + 7 + 3 = 16
    expect(layout.nodes.length).toBe(16);
  });

  it("collapsing a node removes its descendants from the layout but keeps the node itself", () => {
    const tree = buildFixtureTree();
    const root = toRootDisplayNode(tree);
    const strep = findTaxonByName(tree, "Streptomyces")!;
    const full = computeTreeLayout(root, new Set(), 800);
    const collapsed = computeTreeLayout(root, new Set([strep.id!]), 800);

    expect(collapsed.nodes.length).toBeLessThan(full.nodes.length);
    expect(collapsed.nodes.some((n) => n.data._kind === "taxon" && n.data.id === strep.id)).toBe(true);
    expect(collapsed.nodes.some((n) => n.data._kind === "taxon" && n.data.name === "Streptomyces coelicolor")).toBe(
      false,
    );
  });

  it("every node has finite x/y coordinates after layout", () => {
    const root = toRootDisplayNode(buildFixtureTree());
    const layout = computeTreeLayout(root, new Set(), 800);
    for (const n of layout.nodes) {
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.y)).toBe(true);
    }
  });

  it("height grows with the number of visible leaves", () => {
    // The shared fixture tree only has 4 genomes total, which floor-clamps
    // to MIN_TREE_HEIGHT (200px) in both the full and collapsed case —
    // a real property of the implementation (a tiny tree shouldn't shrink
    // below a usable minimum), not something to test against here. Build
    // a purpose-sized tree instead so both cases clear the floor and the
    // comparison actually exercises the leaf-count scaling logic.
    const bigGenus = {
      id: "big-genus",
      name: "Biggenus",
      rank: "genus" as const,
      genome_count: 0,
      bgc_class_counts: {},
      direct_genomes: [],
      children: Array.from({ length: 6 }, (_, i) => ({
        id: `big-species-${i}`,
        name: `Biggenus species${i}`,
        rank: "species" as const,
        genome_count: 1,
        bgc_class_counts: { other: 1 },
        direct_genomes: [
          {
            id: `big-genome-${i}`,
            accession: `GCF_BIG_${i}.1`,
            assembly_level: "complete_genome" as const,
            is_mag: false,
            bgcs: [],
          },
        ],
        children: [],
      })),
    };
    const bigGenus2 = { ...bigGenus, id: "big-genus-2", name: "Biggenus2" };
    const root = toRootDisplayNode({
      id: null,
      name: "root",
      rank: null,
      genome_count: 12,
      bgc_class_counts: {},
      direct_genomes: [],
      children: [bigGenus, bigGenus2],
    });

    const full = computeTreeLayout(root, new Set(), 800);
    const collapsed = computeTreeLayout(root, new Set(["big-genus"]), 800);

    expect(full.height).toBeGreaterThan(200 + 40); // sanity: actually clears the floor
    expect(collapsed.height).toBeLessThan(full.height);
  });
});
