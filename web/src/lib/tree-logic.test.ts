import { describe, expect, it } from "vitest";
import {
  MAX_BRANCH_WIDTH,
  MIN_BRANCH_WIDTH,
  RANK_ABBREVIATIONS,
  computeRadialTreeLayout,
  isLeftHalf,
  rankAbbreviation,
  ancestorsOfMatches,
  bgcComponentClasses,
  branchWidth,
  collectMatchKeys,
  dominantBgcClass,
  effectiveCollapsed,
  nodeMatchesOrContains,
  subtreeBgcCount,
  bgcInFamily,
  genomeHasFamily,
  nodeHasFamily,
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
import { FAM_LOCAL, FAM_SHARED, buildFixtureTree, findTaxonByName } from "./test-fixtures";
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

describe("family highlighting", () => {
  it("bgcInFamily matches only BGCs carrying that family id", () => {
    const tree = buildFixtureTree();
    const coelicolor = findTaxonByName(tree, "Streptomyces coelicolor")!;
    const bgcs = coelicolor.direct_genomes[0]!.bgcs;
    const inFamily = bgcs.filter((b) => bgcInFamily(b, FAM_SHARED));
    expect(inFamily).toHaveLength(1);
    expect(inFamily[0]!.bgc_class).toBe("nrps");
  });

  it("bgcInFamily is false for a null selection (nothing highlighted by default)", () => {
    const tree = buildFixtureTree();
    const coelicolor = findTaxonByName(tree, "Streptomyces coelicolor")!;
    expect(coelicolor.direct_genomes[0]!.bgcs.some((b) => bgcInFamily(b, null))).toBe(false);
  });

  it("genomeHasFamily finds a genome via any of its BGCs", () => {
    const tree = buildFixtureTree();
    const setae = findTaxonByName(tree, "Kitasatospora setae")!;
    const g: GenomeDisplayNode = { ...setae.direct_genomes[0]!, _kind: "genome" };
    expect(genomeHasFamily(g, FAM_SHARED)).toBe(true);
    expect(genomeHasFamily(g, FAM_LOCAL)).toBe(false);
  });

  it("nodeHasFamily reaches down through several taxonomic levels", () => {
    const tree = buildFixtureTree();
    const family = findTaxonByName(tree, "Streptomycetaceae")!;
    // FAM_LOCAL lives on one genome three levels below this node.
    expect(nodeHasFamily({ ...family, _kind: "taxon" }, FAM_LOCAL)).toBe(true);
  });

  it("THE POINT: a scattered family is detected in BOTH genera, a local one in only one", () => {
    const tree = buildFixtureTree();
    const streptomyces = findTaxonByName(tree, "Streptomyces")!;
    const kitasatospora = findTaxonByName(tree, "Kitasatospora")!;

    // FAM_SHARED spans two different genera — the horizontal-transfer /
    // scattered-distribution signal the product exists to surface.
    expect(nodeHasFamily({ ...streptomyces, _kind: "taxon" }, FAM_SHARED)).toBe(true);
    expect(nodeHasFamily({ ...kitasatospora, _kind: "taxon" }, FAM_SHARED)).toBe(true);

    // FAM_LOCAL is confined to one species inside Streptomyces.
    expect(nodeHasFamily({ ...streptomyces, _kind: "taxon" }, FAM_LOCAL)).toBe(true);
    expect(nodeHasFamily({ ...kitasatospora, _kind: "taxon" }, FAM_LOCAL)).toBe(false);
  });

  it("nodeHasFamily is false for an unknown family id", () => {
    const root = toRootDisplayNode(buildFixtureTree());
    expect(nodeHasFamily(root, "no-such-family")).toBe(false);
  });
});

describe("search: the failures that made it look inert", () => {
  it("finds matches anywhere in the tree", () => {
    const root = toRootDisplayNode(buildFixtureTree());
    // Two hits: the species taxon and the genome accession that embeds
    // the same string. Matching is case-insensitive across both label
    // kinds, which is the intended behaviour.
    expect(collectMatchKeys(root, "avermitilis").size).toBe(2);
    expect(collectMatchKeys(root, "streptomyces").size).toBeGreaterThan(1);
    expect(collectMatchKeys(root, "GCF_TEST_SETAE").size).toBe(1);
  });

  it("empty query matches nothing rather than everything", () => {
    const root = toRootDisplayNode(buildFixtureTree());
    expect(collectMatchKeys(root, "").size).toBe(0);
    expect(collectMatchKeys(root, "   ").size).toBe(0);
  });

  it("THE BUG: a match inside a collapsed clade is force-opened", () => {
    // Previously this rendered nothing at all, so search read as broken.
    const tree = buildFixtureTree();
    const root = toRootDisplayNode(tree);
    const genus = findTaxonByName(tree, "Streptomyces")!;

    const collapsed = new Set([genus.id!]);
    expect(computeTreeLayout(root, collapsed, 800).nodes.some(
      (n) => n.data._kind === "taxon" && n.data.name === "Streptomyces avermitilis",
    )).toBe(false);

    const opened = effectiveCollapsed(root, collapsed, "avermitilis");
    expect(computeTreeLayout(root, opened, 800).nodes.some(
      (n) => n.data._kind === "taxon" && n.data.name === "Streptomyces avermitilis",
    )).toBe(true);
  });

  it("leaves collapse state untouched when not searching", () => {
    const tree = buildFixtureTree();
    const root = toRootDisplayNode(tree);
    const collapsed = new Set([findTaxonByName(tree, "Streptomyces")!.id!]);
    expect(effectiveCollapsed(root, collapsed, "")).toEqual(collapsed);
  });

  it("only opens the path to matches, not the whole tree", () => {
    const tree = buildFixtureTree();
    const root = toRootDisplayNode(tree);
    const collapsed = new Set([
      findTaxonByName(tree, "Streptomyces")!.id!,
      findTaxonByName(tree, "Kitasatospora")!.id!,
    ]);
    const opened = effectiveCollapsed(root, collapsed, "avermitilis");
    // Kitasatospora holds no match, so it stays collapsed.
    expect(opened.has(findTaxonByName(tree, "Kitasatospora")!.id!)).toBe(true);
    expect(opened.has(findTaxonByName(tree, "Streptomyces")!.id!)).toBe(false);
  });

  it("nodeMatchesOrContains keeps ancestor branches undimmed", () => {
    const tree = buildFixtureTree();
    const strep = findTaxonByName(tree, "Streptomyces")!;
    const kita = findTaxonByName(tree, "Kitasatospora")!;
    expect(nodeMatchesOrContains({ ...strep, _kind: "taxon" }, "avermitilis")).toBe(true);
    expect(nodeMatchesOrContains({ ...kita, _kind: "taxon" }, "avermitilis")).toBe(false);
  });
});

describe("branch weighting", () => {
  it("thicker branches lead to biosynthetically richer subtrees", () => {
    const tree = buildFixtureTree();
    const strep = { ...findTaxonByName(tree, "Streptomyces")!, _kind: "taxon" as const };
    const kita = { ...findTaxonByName(tree, "Kitasatospora")!, _kind: "taxon" as const };
    expect(subtreeBgcCount(strep)).toBeGreaterThan(subtreeBgcCount(kita));
    const max = subtreeBgcCount(strep);
    expect(branchWidth(strep, max)).toBeGreaterThan(branchWidth(kita, max));
  });

  it("stays within legible bounds even when maxCount is wrong", () => {
    const tree = buildFixtureTree();
    const strep = { ...findTaxonByName(tree, "Streptomyces")!, _kind: "taxon" as const };
    for (const max of [1, 10, 5000]) {
      const w = branchWidth(strep, max);
      expect(w).toBeGreaterThanOrEqual(MIN_BRANCH_WIDTH);
      expect(w).toBeLessThanOrEqual(MAX_BRANCH_WIDTH);
    }
  });

  it("an empty subtree gets the minimum width, not zero or NaN", () => {
    const empty = toRootDisplayNode({
      id: "e", name: "Empty", rank: "genus", genome_count: 0,
      bgc_class_counts: {}, direct_genomes: [], children: [],
    });
    expect(branchWidth(empty, 100)).toBe(MIN_BRANCH_WIDTH);
  });

  it("dominantBgcClass returns null on a genuine tie rather than picking arbitrarily", () => {
    const tied = toRootDisplayNode({
      id: "t", name: "Tied", rank: "genus", genome_count: 2,
      bgc_class_counts: { nrps: 3, pks: 3 }, direct_genomes: [], children: [],
    });
    expect(dominantBgcClass(tied)).toBeNull();
  });

  it("dominantBgcClass finds a clear winner", () => {
    const clear = toRootDisplayNode({
      id: "c", name: "Clear", rank: "genus", genome_count: 2,
      bgc_class_counts: { nrps: 9, pks: 2 }, direct_genomes: [], children: [],
    });
    expect(dominantBgcClass(clear)).toBe("nrps");
  });
});

describe("rank badges", () => {
  it("uses GTDB's own rank letters — domain, not kingdom", () => {
    expect(rankAbbreviation("domain")).toBe("D");
    expect(rankAbbreviation("phylum")).toBe("P");
    expect(rankAbbreviation("species")).toBe("S");
    // There is no kingdom rank in GTDB, so nothing should map to K.
    expect(Object.values(RANK_ABBREVIATIONS)).not.toContain("K");
  });

  it("returns null for the synthetic root, which has no rank", () => {
    expect(rankAbbreviation(null)).toBeNull();
    expect(rankAbbreviation(undefined)).toBeNull();
    expect(rankAbbreviation("not-a-rank")).toBeNull();
  });
});

describe("radial layout", () => {
  it("renders the same node set as the horizontal layout", () => {
    const root = toRootDisplayNode(buildFixtureTree());
    const flat = computeTreeLayout(root, new Set(), 800);
    const radial = computeRadialTreeLayout(root, new Set());
    expect(radial.nodes.length).toBe(flat.nodes.length);
  });

  it("places every node within the circle, at a finite angle and radius", () => {
    const root = toRootDisplayNode(buildFixtureTree());
    const { nodes, radius } = computeRadialTreeLayout(root, new Set());
    for (const n of nodes) {
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.y)).toBe(true);
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.x).toBeLessThanOrEqual(2 * Math.PI);
      expect(n.y).toBeLessThanOrEqual(radius);
    }
  });

  it("respects collapse state", () => {
    const tree = buildFixtureTree();
    const root = toRootDisplayNode(tree);
    const genus = findTaxonByName(tree, "Streptomyces")!;
    const full = computeRadialTreeLayout(root, new Set());
    const collapsed = computeRadialTreeLayout(root, new Set([genus.id!]));
    expect(collapsed.nodes.length).toBeLessThan(full.nodes.length);
  });

  it("grows the canvas with leaf count so tips don't crush together", () => {
    const small = computeRadialTreeLayout(toRootDisplayNode(buildFixtureTree()), new Set());
    const big = computeRadialTreeLayout(
      toRootDisplayNode({
        id: null, name: "root", rank: null, genome_count: 60, bgc_class_counts: {},
        direct_genomes: Array.from({ length: 60 }, (_, i) => ({
          id: `g${i}`, accession: `SYN_${i}.1`, assembly_level: "complete_genome" as const,
          is_mag: false, bgcs: [],
        })),
        children: [],
      }),
      new Set(),
    );
    expect(big.size).toBeGreaterThan(small.size);
  });

  it("flips labels on the left half so they read left-to-right", () => {
    expect(isLeftHalf(0)).toBe(false);
    expect(isLeftHalf(Math.PI / 2)).toBe(false);
    expect(isLeftHalf(Math.PI)).toBe(true);
    expect(isLeftHalf(1.5 * Math.PI)).toBe(true);
  });
});
