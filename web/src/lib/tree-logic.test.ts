import { describe, expect, it } from "vitest";
import {
  MAX_BRANCH_WIDTH,
  MIN_BRANCH_WIDTH,
  MIN_ANCHOR_LABEL_ARC_PX,
  MIN_LABEL_ARC_PX,
  MIN_LABEL_ROW_PX,
  RANK_ABBREVIATIONS,
  RANK_DEPTH_ORDER,
  computeRadialTreeLayout,
  estimateLabelWidth,
  hasRoomForLabel,
  placeRectangularLabels,
  BGC_SIZE_TIERS,
  isAnchorRank,
  isHighRank,
  isLeftHalf,
  rankAbbreviation,
  MAX_GLYPH_WIDTH,
  MIN_GLYPH_WIDTH,
  ancestorsOfMatches,
  EMPTY_FILTERS,
  applyFocus,
  applyGenomeFilters,
  bgcSizeTier,
  filtersAreActive,
  genomePassesFilters,
  cladeSummary,
  findNodeByKey,
  glyphWidth,
  bgcComponentClasses,
  branchWidth,
  collapseToLevel,
  collectMatchKeys,
  ranksPresent,
  type CollapseLevel,
  dominantBgcClass,
  effectiveCollapsed,
  nodeMatchesOrContains,
  pruneToBgcBearing,
  subtreeBgcCount,
  bgcInFamily,
  genomeHasFamily,
  nodeHasFamily,
  familyMembershipSets,
  familyEnclosingClades,
  familyDistribution,
  familyTreeIndex,
  bgcFamilyIndex,
  collapseToFamily,
  groupUnplacedTaxa,
  findMibigEntry,
  findTaxonKeyByName,
  UNPLACED_KEY,
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
import type { GenomeDisplayNode, TaxonTreeNode } from "./api-types";

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

/** The single genome hanging off a fixture species, as a display node. */
function genomeIn(tree: ReturnType<typeof buildFixtureTree>, species: string): GenomeDisplayNode {
  const taxon = findTaxonByName(tree, species)!;
  return { ...taxon.direct_genomes[0]!, _kind: "genome" };
}

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

  it("matches a taxon on its rank, not only its name", () => {
    const tree = buildFixtureTree();
    const genus = findTaxonByName(tree, "Streptomyces")!;
    const species = findTaxonByName(tree, "Streptomyces coelicolor")!;
    expect(matchesQuery({ ...genus, _kind: "taxon" }, "genus")).toBe(true);
    expect(matchesQuery({ ...species, _kind: "taxon" }, "genus")).toBe(false);
    expect(matchesQuery({ ...species, _kind: "taxon" }, "SPECIES")).toBe(true);
  });

  it("matches a genome on its assembly level, spelled either way", () => {
    const g = genomeIn(buildFixtureTree(), "Streptomyces coelicolor");
    // The API spells it "complete_genome"; nobody types the underscore.
    expect(matchesQuery(g, "complete_genome")).toBe(true);
    expect(matchesQuery(g, "complete genome")).toBe(true);
    expect(matchesQuery(g, "scaffold")).toBe(false);
  });

  it("matches a MAG on the whole word only", () => {
    const mag = genomeIn(buildFixtureTree(), "Streptomyces venezuelae");
    const notMag = genomeIn(buildFixtureTree(), "Streptomyces coelicolor");
    expect(matchesQuery(mag, "mag")).toBe(true);
    expect(matchesQuery(notMag, "mag")).toBe(false);
    // A prefix must not light up every MAG in the corpus while the reader
    // is still typing. ("m" alone would be a poor probe here: every fixture
    // genome is a "complete_genome", which contains one.)
    expect(matchesQuery(mag, "ma")).toBe(false);
  });

  it("matches a genome on its clusters' class, subtype and evidence", () => {
    const tree = buildFixtureTree();
    const coelicolor = genomeIn(tree, "Streptomyces coelicolor");
    const venezuelae = genomeIn(tree, "Streptomyces venezuelae");

    expect(matchesQuery(coelicolor, "nrps")).toBe(true);
    expect(matchesQuery(coelicolor, "terpene")).toBe(false);
    expect(matchesQuery(coelicolor, "type II")).toBe(true);
    expect(matchesQuery(venezuelae, "lanthipeptide")).toBe(true);
    expect(matchesQuery(venezuelae, "predicted")).toBe(true);
  });

  it("a hybrid answers a search for either component class", () => {
    // The avermitilis genome's only NRPS activity is inside an nrps+pks
    // hybrid — the same case bgcComponentClasses exists for on the filter
    // side. Searching "nrps" must find it.
    const avermitilis = genomeIn(buildFixtureTree(), "Streptomyces avermitilis");
    expect(matchesQuery(avermitilis, "nrps")).toBe(true);
    expect(matchesQuery(avermitilis, "ripp")).toBe(false);
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
  it("uses GTDB's own rank letters, and D is its top rank", () => {
    expect(rankAbbreviation("domain")).toBe("D");
    expect(rankAbbreviation("phylum")).toBe("P");
    expect(rankAbbreviation("species")).toBe("S");
  });

  it("has a K badge for eukaryotes, which GTDB alone would never need", () => {
    // This used to assert nothing mapped to K — true while GTDB was the only
    // taxonomy, since its top rank is domain. NCBI ranks eukaryotes with a
    // kingdom (Eukaryota -> Fungi -> Ascomycota), so the badge now exists and
    // appears only in the eukaryote tree.
    expect(rankAbbreviation("kingdom")).toBe("K");
    expect(RANK_DEPTH_ORDER.indexOf("kingdom")).toBe(
      RANK_DEPTH_ORDER.indexOf("domain") + 1,
    );
    // ...and it sits above phylum, or "Show down to" would order wrongly.
    expect(RANK_DEPTH_ORDER.indexOf("kingdom")).toBeLessThan(
      RANK_DEPTH_ORDER.indexOf("phylum"),
    );
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
    // Both counts must clear RADIAL_MIN_RADIUS, or the floor makes them
    // equal and the test proves nothing.
    const small = computeRadialTreeLayout(
      toRootDisplayNode({
        id: null, name: "root", rank: null, genome_count: 90, bgc_class_counts: {},
        direct_genomes: Array.from({ length: 90 }, (_, i) => ({
          id: `s${i}`, accession: `SYN_${i}.1`, assembly_level: "complete_genome" as const,
          is_mag: false, bgcs: [],
        })),
        children: [],
      }),
      new Set(),
    );
    const big = computeRadialTreeLayout(
      toRootDisplayNode({
        id: null, name: "root", rank: null, genome_count: 300, bgc_class_counts: {},
        direct_genomes: Array.from({ length: 300 }, (_, i) => ({
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

describe("semantic label management", () => {
  it("hides a label when its arc is too small, shows it when zoomed in", () => {
    const step = (2 * Math.PI) / 80; // 80 leaves
    // An inner node at r=60 has ~4.7px of arc — nowhere near enough.
    expect(hasRoomForLabel(60, step, 1)).toBe(false);
    // Zooming 4x gives it ~19px, which fits.
    expect(hasRoomForLabel(60, step, 4)).toBe(true);
  });

  it("gives outer leaves room at default zoom", () => {
    const step = (2 * Math.PI) / 80;
    expect(hasRoomForLabel(340, step, 1)).toBe(true);
  });

  it("gives anchor ranks a lower bar, not an exemption", () => {
    // This used to assert `alwaysShow`, which returned true for an anchor
    // at ANY arc. An exemption is not a priority: every phylum in a tightly
    // packed ring drew on top of its neighbours, and overlapping text is
    // not more informative than less text — none of it can be read.
    const step = (2 * Math.PI) / 400;

    // An arc that clears the anchor bar but not the ordinary one: the
    // anchor label survives where a species label would be dropped.
    const roomy = MIN_ANCHOR_LABEL_ARC_PX / (step * 1);
    expect(hasRoomForLabel(roomy, step, 1)).toBe(false);
    expect(hasRoomForLabel(roomy, step, 1, true)).toBe(true);

    // But an anchor with essentially no arc at all is still suppressed.
    expect(hasRoomForLabel(5, step, 0.3, true)).toBe(false);

    expect(MIN_ANCHOR_LABEL_ARC_PX).toBeLessThan(MIN_LABEL_ARC_PX);
    expect(isAnchorRank("domain")).toBe(true);
    expect(isAnchorRank("phylum")).toBe(true);
    expect(isAnchorRank("species")).toBe(false);
  });

  it("radius scales with leaf count so the outer ring keeps its spacing", () => {
    const mk = (n: number) =>
      computeRadialTreeLayout(
        toRootDisplayNode({
          id: null, name: "root", rank: null, genome_count: n, bgc_class_counts: {},
          direct_genomes: Array.from({ length: n }, (_, i) => ({
            id: `g${i}`, accession: `SYN_${i}.1`,
            assembly_level: "complete_genome" as const, is_mag: false, bgcs: [],
          })),
          children: [],
        }),
        new Set(),
      );
    const small = mk(20);
    const large = mk(200);
    expect(large.radius).toBeGreaterThan(small.radius);

    // The real guarantee: per-leaf arc never falls below the minimum,
    // however many leaves there are. Small trees get MORE than the
    // minimum because RADIAL_MIN_RADIUS floors the radius — generous
    // spacing on a sparse tree is fine; collapsing spacing on a dense one
    // is not, and that's what this protects against.
    const arc = (l: ReturnType<typeof mk>) => l.radius * l.angularStep;
    expect(arc(large)).toBeGreaterThanOrEqual(MIN_LABEL_ARC_PX);
    expect(arc(mk(2000))).toBeGreaterThanOrEqual(MIN_LABEL_ARC_PX);
    expect(arc(small)).toBeGreaterThan(arc(large)); // floor gives sparse trees room
  });
});

describe("rank-level collapse", () => {
  const tree = buildFixtureTree();
  const root = toRootDisplayNode(tree);

  function visibleRanks(level: CollapseLevel): Set<string> {
    const layout = computeTreeLayout(root, collapseToLevel(root, level), 800);
    const ranks = new Set<string>();
    layout.nodes.forEach((n) => {
      if (n.data._kind === "genome") ranks.add("genome");
      else if (n.data.rank) ranks.add(n.data.rank);
    });
    return ranks;
  }

  it("showing down to phylum hides everything deeper", () => {
    const ranks = visibleRanks("phylum");
    expect(ranks.has("domain")).toBe(true);
    expect(ranks.has("phylum")).toBe(true);
    expect(ranks.has("class")).toBe(false);
    expect(ranks.has("genus")).toBe(false);
    expect(ranks.has("genome")).toBe(false);
  });

  it("showing down to genus reveals genera but not species or genomes", () => {
    const ranks = visibleRanks("genus");
    expect(ranks.has("genus")).toBe(true);
    expect(ranks.has("species")).toBe(false);
    expect(ranks.has("genome")).toBe(false);
  });

  it("the genome level collapses nothing", () => {
    expect(collapseToLevel(root, "genome").size).toBe(0);
    expect(visibleRanks("genome").has("genome")).toBe(true);
  });

  it("collapses only the topmost node of a branch, not every descendant", () => {
    // Collapsing descendants of an already-collapsed node is redundant
    // and would leave stale keys behind when the user re-expands.
    const collapsed = collapseToLevel(root, "phylum");
    const phylum = findTaxonByName(tree, "Actinomycetota")!;
    const genus = findTaxonByName(tree, "Streptomyces")!;
    expect(collapsed.has(phylum.id!)).toBe(true);
    expect(collapsed.has(genus.id!)).toBe(false);
  });

  it("handles a branch that skips the requested rank", () => {
    // Real taxonomies skip ranks. Here a genus sits directly under a
    // domain with no phylum/class/order between. Asking for "order"
    // should still terminate the branch rather than showing all of it.
    const skipped = toRootDisplayNode({
      id: null, name: "root", rank: null, genome_count: 1, bgc_class_counts: {},
      direct_genomes: [],
      children: [
        {
          id: "d1", name: "Bacteria", rank: "domain", genome_count: 1, bgc_class_counts: {},
          direct_genomes: [],
          children: [
            {
              id: "g1", name: "Orphangenus", rank: "genus", genome_count: 1, bgc_class_counts: {},
              direct_genomes: [
                { id: "gm1", accession: "SYN_1.1", assembly_level: "complete_genome", is_mag: false, bgcs: [] },
              ],
              children: [],
            },
          ],
        },
      ],
    });
    const collapsed = collapseToLevel(skipped, "order");
    // The genus is deeper than order, so it becomes this branch's leaf —
    // one rank deeper than asked, but better than hiding the branch.
    expect(collapsed.has("g1")).toBe(true);
    const layout = computeTreeLayout(skipped, collapsed, 800);
    expect(layout.nodes.some((n) => n.data._kind === "genome")).toBe(false);
    expect(layout.nodes.some((n) => n.data._kind === "taxon" && n.data.name === "Orphangenus")).toBe(true);
  });

  it("ranksPresent reports only what the dataset actually contains", () => {
    const present = ranksPresent(root);
    expect(present.has("genus")).toBe(true);
    expect(present.has("species")).toBe(true);
    expect(present.has("genome")).toBe(true);
    // The fixture has no order rank, so the control should disable it.
    expect(present.has("order")).toBe(true); // fixture does include order
    expect(present.has("kingdom")).toBe(false);
  });
});

describe("pruning to BGC-bearing genomes", () => {
  /** A tree shaped like a real GTDB ingest: mostly genomes antiSMASH has
   * never been run on, with a few that carry clusters. */
  function mixedTree(): TaxonTreeNode {
    const withBgcs = {
      id: "g-has", accession: "GCF_HAS.1", assembly_level: "complete_genome" as const,
      is_mag: false,
      bgcs: [{
        id: "b1", bgc_class: "nrps" as const, subtype: null,
        mibig_accession: null, evidence_level: "predicted" as const, family_ids: [], compounds: [],
      }],
    };
    const empties = Array.from({ length: 5 }, (_, i) => ({
      id: `g-empty-${i}`, accession: `GCF_EMPTY_${i}.1`,
      assembly_level: "complete_genome" as const, is_mag: false, bgcs: [],
    }));
    return {
      id: null, name: "root", rank: null, genome_count: 6,
      bgc_class_counts: { nrps: 1 }, direct_genomes: [],
      children: [
        {
          id: "productive", name: "Productivegenus", rank: "genus", genome_count: 1,
          bgc_class_counts: { nrps: 1 }, direct_genomes: [withBgcs], children: [],
        },
        {
          id: "barren", name: "Barrengenus", rank: "genus", genome_count: 5,
          bgc_class_counts: {}, direct_genomes: empties, children: [],
        },
      ],
    };
  }

  it("keeps only genomes that carry BGCs", () => {
    const result = pruneToBgcBearing(toRootDisplayNode(mixedTree()), true);
    expect(result.shownGenomes).toBe(1);
    expect(result.totalGenomes).toBe(6);
    expect(result.fellBackToFull).toBe(false);
  });

  it("drops taxa whose entire subtree is empty", () => {
    const result = pruneToBgcBearing(toRootDisplayNode(mixedTree()), true);
    const names = result.root.children.map((c) => c.name);
    expect(names).toContain("Productivegenus");
    expect(names).not.toContain("Barrengenus");
  });

  it("recomputes genome_count so downstream consumers describe what's drawn", () => {
    // Branch weighting, level collapse and the header count all read
    // this; a stale count would describe the pre-pruned tree.
    const result = pruneToBgcBearing(toRootDisplayNode(mixedTree()), true);
    expect(result.root.genome_count).toBe(1);
  });

  it("passes the tree through untouched when disabled", () => {
    const full = toRootDisplayNode(mixedTree());
    const result = pruneToBgcBearing(full, false);
    expect(result.root).toBe(full);
    expect(result.shownGenomes).toBe(6);
  });

  it("falls back to the full tree when NOTHING has BGCs", () => {
    // GTDB ingested without antiSMASH. Pruning to an empty canvas would
    // read as a broken app rather than an empty result.
    const barren = toRootDisplayNode({
      id: null, name: "root", rank: null, genome_count: 3, bgc_class_counts: {},
      direct_genomes: Array.from({ length: 3 }, (_, i) => ({
        id: `g${i}`, accession: `GCF_${i}.1`, assembly_level: "complete_genome" as const,
        is_mag: false, bgcs: [],
      })),
      children: [],
    });
    const result = pruneToBgcBearing(barren, true);
    expect(result.fellBackToFull).toBe(true);
    expect(result.shownGenomes).toBe(3);
  });

  it("the pruned tree still lays out and collapses correctly", () => {
    const result = pruneToBgcBearing(toRootDisplayNode(mixedTree()), true);
    const layout = computeTreeLayout(result.root, new Set(), 800);
    expect(layout.nodes.some((n) => n.data._kind === "genome")).toBe(true);
    expect(
      layout.nodes.some((n) => n.data._kind === "genome" && n.data.accession.includes("EMPTY")),
    ).toBe(false);
    expect(collapseToLevel(result.root, "genus").size).toBeGreaterThan(0);
  });
});

describe("clade summary glyphs", () => {
  const tree = buildFixtureTree();
  const root = toRootDisplayNode(tree);

  it("summarises a collapsed clade instead of hiding it", () => {
    const strep = { ...findTaxonByName(tree, "Streptomyces")!, _kind: "taxon" as const };
    const summary = cladeSummary(strep);
    // Three species, one genome each.
    expect(summary.genomeCount).toBe(3);
    expect(summary.bgcCount).toBeGreaterThan(0);
    expect(summary.composition.length).toBeGreaterThan(1);
  });

  it("orders composition largest-first so glyphs are comparable at a glance", () => {
    const summary = cladeSummary(root);
    const fractions = summary.composition.map((c) => c.fraction);
    expect(fractions).toEqual([...fractions].sort((a, b) => b - a));
    expect(fractions.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
  });

  it("reports an empty clade as zero rather than omitting it", () => {
    const empty = toRootDisplayNode({
      id: "e", name: "Empty", rank: "genus", genome_count: 3, bgc_class_counts: {},
      direct_genomes: [], children: [],
    });
    const summary = cladeSummary(empty);
    expect(summary.bgcCount).toBe(0);
    expect(summary.composition).toEqual([]);
    expect(summary.genomeCount).toBe(3);
  });

  it("glyph width is bounded and scales with clade size", () => {
    expect(glyphWidth(1, 100)).toBeGreaterThanOrEqual(MIN_GLYPH_WIDTH);
    expect(glyphWidth(100, 100)).toBeLessThanOrEqual(MAX_GLYPH_WIDTH);
    expect(glyphWidth(100, 100)).toBeGreaterThan(glyphWidth(4, 100));
    // Clamped when the caller's maximum is wrong, same as branchWidth.
    expect(glyphWidth(500, 10)).toBeLessThanOrEqual(MAX_GLYPH_WIDTH);
  });
});

describe("focus mode", () => {
  const tree = buildFixtureTree();
  const root = toRootDisplayNode(tree);

  it("re-roots the view on the focused clade", () => {
    const genus = findTaxonByName(tree, "Streptomyces")!;
    const result = applyFocus(root, genus.id!);
    expect(result.root.name).toBe("Streptomyces");
    expect(result.focusLost).toBe(false);
  });

  it("builds a breadcrumb path from the true root down to the focus", () => {
    const species = findTaxonByName(tree, "Streptomyces coelicolor")!;
    const names = applyFocus(root, species.id!).path.map((n) => n.name);
    expect(names[0]).toBe("root");
    expect(names).toContain("Streptomyces");
    expect(names[names.length - 1]).toBe("Streptomyces coelicolor");
  });

  it("returns the whole tree when no focus is set", () => {
    const result = applyFocus(root, null);
    expect(result.root).toBe(root);
    expect(result.path).toEqual([]);
  });

  it("falls back to the full tree when the focused clade is gone", () => {
    // Happens legitimately: toggling the BGC-bearing filter can prune away
    // whatever was focused. Blanking the canvas would look like a crash.
    const result = applyFocus(root, "no-such-node");
    expect(result.focusLost).toBe(true);
    expect(result.root).toBe(root);
  });

  it("the focused subtree lays out on its own", () => {
    const genus = findTaxonByName(tree, "Streptomyces")!;
    const focusedRoot = applyFocus(root, genus.id!).root;
    const layout = computeTreeLayout(focusedRoot, new Set(), 800);
    expect(layout.nodes.length).toBeGreaterThan(1);
    expect(
      layout.nodes.every((n) => n.data._kind === "genome" || n.data.name !== "Kitasatospora"),
    ).toBe(true);
  });

  it("findNodeByKey locates nodes at any depth", () => {
    const species = findTaxonByName(tree, "Kitasatospora setae")!;
    expect(findNodeByKey(root, species.id!)?.name).toBe("Kitasatospora setae");
    expect(findNodeByKey(root, "missing")).toBeNull();
  });
});

describe("BGC-count size tiers", () => {
  it("assigns tiers at the documented boundaries", () => {
    expect(bgcSizeTier(0).id).toBe("none");
    expect(bgcSizeTier(1).id).toBe("low");
    expect(bgcSizeTier(5).id).toBe("low");
    expect(bgcSizeTier(6).id).toBe("medium");
    expect(bgcSizeTier(20).id).toBe("medium");
    expect(bgcSizeTier(21).id).toBe("high");
    expect(bgcSizeTier(50).id).toBe("high");
    expect(bgcSizeTier(51).id).toBe("very-high");
  });

  it("radius increases monotonically with BGC count", () => {
    const radii = [0, 3, 10, 30, 100].map((n) => bgcSizeTier(n).radius);
    expect(radii).toEqual([...radii].sort((a, b) => a - b));
  });

  it("only the empty tier is muted — BGC-negative genomes recede but stay visible", () => {
    expect(bgcSizeTier(0).muted).toBe(true);
    expect(bgcSizeTier(1).muted).toBe(false);
    expect(bgcSizeTier(0).radius).toBeGreaterThan(0);
  });
});

describe("genome filters", () => {
  function g(overrides: Partial<GenomeDisplayNode> = {}): GenomeDisplayNode {
    return {
      _kind: "genome", id: "g1", accession: "GCF_1.1",
      assembly_level: "complete_genome", is_mag: false,
      genome_size_bp: 5_000_000, gc_content_pct: 60, completeness_pct: 98,
      bgcs: [], ...overrides,
    } as GenomeDisplayNode;
  }
  const bgc = (mibig: string | null = null) => ({
    id: `b${Math.random()}`, bgc_class: "nrps" as const, subtype: null,
    mibig_accession: mibig, evidence_level: "predicted" as const, family_ids: [], compounds: [],
  });

  it("no active filter passes everything", () => {
    expect(filtersAreActive(EMPTY_FILTERS)).toBe(false);
    expect(genomePassesFilters(g(), EMPTY_FILTERS)).toBe(true);
  });

  it("filters on BGC count range", () => {
    const f = { ...EMPTY_FILTERS, minBgcCount: 2 };
    expect(genomePassesFilters(g({ bgcs: [bgc()] }), f)).toBe(false);
    expect(genomePassesFilters(g({ bgcs: [bgc(), bgc()] }), f)).toBe(true);
  });

  it("filters on MIBiG match", () => {
    const matched = { ...EMPTY_FILTERS, mibigMatched: "matched" as const };
    const unmatched = { ...EMPTY_FILTERS, mibigMatched: "unmatched" as const };
    expect(genomePassesFilters(g({ bgcs: [bgc("BGC001")] }), matched)).toBe(true);
    expect(genomePassesFilters(g({ bgcs: [bgc()] }), matched)).toBe(false);
    expect(genomePassesFilters(g({ bgcs: [bgc()] }), unmatched)).toBe(true);
  });

  it("a MISSING measurement passes rather than fails", () => {
    // A genome with no recorded GC shouldn't vanish because a GC filter
    // is set — the filter simply can't speak to it.
    const f = { ...EMPTY_FILTERS, minGcPct: 50 };
    expect(genomePassesFilters(g({ gc_content_pct: null }), f)).toBe(true);
    expect(genomePassesFilters(g({ gc_content_pct: 40 }), f)).toBe(false);
  });

  it("filters on genome size in Mb, converting from bp", () => {
    const f = { ...EMPTY_FILTERS, minGenomeSizeMb: 6 };
    expect(genomePassesFilters(g({ genome_size_bp: 5_000_000 }), f)).toBe(false);
    expect(genomePassesFilters(g({ genome_size_bp: 7_000_000 }), f)).toBe(true);
  });

  it("applyGenomeFilters prunes taxa left with nothing", () => {
    const tree = buildFixtureTree();
    const root = toRootDisplayNode(tree);
    const result = applyGenomeFilters(root, { ...EMPTY_FILTERS, minBgcCount: 3 });
    expect(result.matched).toBeGreaterThan(0);
    expect(result.matched).toBeLessThan(root.genome_count);
    expect(result.filteredEverythingOut).toBe(false);
  });

  it("falls back to the unfiltered tree when nothing matches", () => {
    // Same reasoning as the BGC-bearing filter: a blank canvas reads as
    // a crash rather than an empty result.
    const root = toRootDisplayNode(buildFixtureTree());
    const result = applyGenomeFilters(root, { ...EMPTY_FILTERS, minBgcCount: 9999 });
    expect(result.filteredEverythingOut).toBe(true);
    expect(result.root).toBe(root);
  });
});

describe("family distribution — the central question", () => {
  const tree = buildFixtureTree();
  const root = toRootDisplayNode(tree);

  it("returns null only when no family id is given", () => {
    expect(familyDistribution(root, null)).toBeNull();
    expect(familyDistribution(root, FAM_SHARED)).not.toBeNull();
  });

  it("membership sets flag every node on the path to a member, and nothing else", () => {
    const { nodeKeys, genomeKeys } = familyMembershipSets(root, FAM_SHARED);
    const coel = findTaxonByName(tree, "Streptomyces coelicolor")!;
    const setae = findTaxonByName(tree, "Kitasatospora setae")!;
    expect(genomeKeys.has(coel.direct_genomes[0]!.id)).toBe(true);
    expect(genomeKeys.has(setae.direct_genomes[0]!.id)).toBe(true);
    expect(nodeKeys.has(findTaxonByName(tree, "Streptomycetaceae")!.id!)).toBe(true);
    expect(nodeKeys.has(findTaxonByName(tree, "Kitasatospora")!.id!)).toBe(true);
    // a sibling species with no member of this family is never flagged
    expect(nodeKeys.has(findTaxonByName(tree, "Streptomyces venezuelae")!.id!)).toBe(false);
  });

  it("counts a scattered family across the right ranks and names its common ancestor", () => {
    const d = familyDistribution(root, FAM_SHARED)!;
    expect(d.memberGenomeCount).toBe(2);
    expect(d.memberBgcCount).toBe(2);
    expect(d.byRank.find((r) => r.rank === "genus")!.containing).toBe(2);
    const phylum = d.byRank.find((r) => r.rank === "phylum")!;
    expect(phylum.containing).toBe(1);
    expect(phylum.total).toBe(1);
    expect(d.spreadRank).toBe("genus");
    expect(d.separateLineages).toBe(2);
    expect(d.commonAncestor?.name).toBe("Streptomycetaceae");
    expect(d.patternLabel).toContain("Streptomycetaceae");
    expect(d.patternLabel).toContain("2 genera");
  });

  it("prevalence is member genomes over every genome in the tree", () => {
    const d = familyDistribution(root, FAM_SHARED)!;
    expect(d.totalGenomes).toBe(4);
    expect(d.prevalence).toBeCloseTo(0.5, 5);
  });

  it("a confined family reports a single tip lineage", () => {
    const d = familyDistribution(root, FAM_LOCAL)!;
    expect(d.memberGenomeCount).toBe(1);
    expect(d.spreadRank).toBeNull();
    expect(d.separateLineages).toBe(1);
    expect(d.enclosingClades).toHaveLength(1);
    expect(d.enclosingClades[0]!.name).toBe("Streptomyces avermitilis");
    expect(d.patternLabel).toContain("Single occurrence");
  });

  it("an unknown family id yields an empty distribution, not a crash", () => {
    const d = familyDistribution(root, "no-such-family")!;
    expect(d.memberGenomeCount).toBe(0);
    expect(d.enclosingClades).toEqual([]);
    expect(d.patternLabel).toBe("Not found in the loaded tree");
  });

  it("splits into disjoint enclosing clades when a family spans two top-level lineages", () => {
    const twoPhyla = toRootDisplayNode({
      id: null,
      name: "root",
      rank: null,
      genome_count: 2,
      bgc_class_counts: { nrps: 2 },
      direct_genomes: [],
      children: ["A", "B"].map((p, i) => ({
        id: `phy-${p}`,
        name: `Phylum${p}`,
        rank: "phylum" as const,
        genome_count: 1,
        bgc_class_counts: { nrps: 1 },
        direct_genomes: [],
        children: [
          {
            id: `gen-${p}`,
            name: `Genus${p}`,
            rank: "genus" as const,
            genome_count: 1,
            bgc_class_counts: { nrps: 1 },
            direct_genomes: [
              {
                id: `gm-${p}`,
                accession: `SYN_${i}.1`,
                assembly_level: "complete_genome" as const,
                is_mag: false,
                bgcs: [
                  {
                    id: `b-${p}`,
                    bgc_class: "nrps" as const,
                    subtype: null,
                    mibig_accession: null,
                    evidence_level: "predicted" as const,
                    family_ids: ["fam-x"],
                    compounds: [],
                  },
                ],
              },
            ],
            children: [],
          },
        ],
      })),
    });
    const d = familyDistribution(twoPhyla, "fam-x")!;
    expect(d.commonAncestor).toBeNull();
    expect(d.enclosingClades.map((c) => c.name).sort()).toEqual(["GenusA", "GenusB"]);
    expect(d.spreadRank).toBe("phylum");
    expect(d.separateLineages).toBe(2);
    expect(d.phylumBreadth).toBe(1);
  });

  it("familyEnclosingClades returns the tightest wrapper, not the first", () => {
    // FAM_SHARED funnels through domain→…→family before branching into two
    // genera, so the wrapper is the family node, not Bacteria.
    const clades = familyEnclosingClades(root, FAM_SHARED);
    expect(clades).toHaveLength(1);
    expect(clades[0]!.name).toBe("Streptomycetaceae");
    expect(clades[0]!.rank).toBe("family");
  });

  it("familyTreeIndex summarises every family in one pass", () => {
    const idx = familyTreeIndex(root);
    const shared = idx.get(FAM_SHARED)!;
    expect(shared.genomeCount).toBe(2);
    expect(shared.genusCount).toBe(2);
    expect(shared.phylumCount).toBe(1);
    expect(shared.phyla).toEqual(["Actinomycetota"]);

    const local = idx.get(FAM_LOCAL)!;
    expect(local.genomeCount).toBe(1);
    expect(local.genusCount).toBe(1);
    expect(local.speciesCount).toBe(1);
  });

  it("bgcFamilyIndex maps a cluster id to its families", () => {
    const idx = bgcFamilyIndex(root);
    const coel = findTaxonByName(tree, "Streptomyces coelicolor")!;
    const nrpsBgc = coel.direct_genomes[0]!.bgcs.find((b) => b.bgc_class === "nrps")!;
    expect(idx.get(nrpsBgc.id)).toEqual([FAM_SHARED]);
    const pksBgc = coel.direct_genomes[0]!.bgcs.find((b) => b.bgc_class === "pks")!;
    expect(idx.has(pksBgc.id)).toBe(false); // no family membership
  });

  it("groupUnplacedTaxa folds root-level orphans under one node, leaving the domain alone", () => {
    const withOrphans = toRootDisplayNode({
      id: null,
      name: "root",
      rank: null,
      genome_count: 6,
      bgc_class_counts: { nrps: 2, pks: 1 },
      direct_genomes: [],
      children: [
        // the real GTDB tree
        { ...tree.children[0]!, genome_count: 4, bgc_class_counts: { nrps: 1, pks: 1 } },
        // MIBiG orphans with no GTDB placement
        {
          id: "orphan-1",
          name: "Aspergillus oryzae",
          rank: "species",
          genome_count: 1,
          bgc_class_counts: { nrps: 1 },
          direct_genomes: [],
          children: [],
        },
        {
          id: "orphan-2",
          name: "Alternaria alternata",
          rank: "species",
          genome_count: 1,
          bgc_class_counts: { pks: 0, nrps: 0 },
          direct_genomes: [],
          children: [],
        },
      ],
    });
    const grouped = groupUnplacedTaxa(withOrphans);
    expect(grouped.children).toHaveLength(2); // domain + bucket
    const bucket = grouped.children.find((c) => c.id === UNPLACED_KEY)!;
    expect(bucket.name).toBe("Unplaced organisms");
    expect(bucket.children.map((c) => c.name).sort()).toEqual([
      "Alternaria alternata",
      "Aspergillus oryzae",
    ]);
    expect(bucket.genome_count).toBe(2);
    expect(grouped.children.some((c) => c.rank === "domain")).toBe(true);
  });

  it("groupUnplacedTaxa is a no-op when every top-level node is a domain", () => {
    const root = toRootDisplayNode(tree);
    expect(groupUnplacedTaxa(root)).toBe(root);
  });

  it("findMibigEntry resolves an accession to a genome, clade and class", () => {
    // Give a fixture BGC a MIBiG accession by hand.
    const t = buildFixtureTree();
    const coel = findTaxonByName(t, "Streptomyces coelicolor")!;
    coel.direct_genomes[0]!.bgcs[0]!.mibig_accession = "BGC9999999";
    coel.direct_genomes[0]!.bgcs[0]!.bgc_class = "nrps";
    const hit = findMibigEntry(toRootDisplayNode(t), "BGC9999999");
    expect(hit).not.toBeNull();
    expect(hit!.genomeId).toBe(coel.direct_genomes[0]!.id);
    expect(hit!.bgcClasses).toEqual(["nrps"]);
    // framed on the nearest genus/family ancestor
    expect(hit!.focusKey).toBe(findTaxonByName(t, "Streptomyces")!.id);
    expect(findMibigEntry(toRootDisplayNode(t), "BGC0000000")).toBeNull();
  });

  it("findTaxonKeyByName is case-insensitive and returns a usable key", () => {
    const root = toRootDisplayNode(tree);
    expect(findTaxonKeyByName(root, "streptomyces")).toBe(
      findTaxonByName(tree, "Streptomyces")!.id,
    );
    expect(findTaxonKeyByName(root, "nope")).toBeNull();
  });

  it("collapseToFamily keeps member lineages open and folds the rest", () => {
    const { nodeKeys } = familyMembershipSets(root, FAM_SHARED);
    const collapsed = collapseToFamily(root, nodeKeys);
    // non-member siblings of a member genus fold to glyphs
    expect(collapsed.has(findTaxonByName(tree, "Streptomyces avermitilis")!.id!)).toBe(true);
    expect(collapsed.has(findTaxonByName(tree, "Streptomyces venezuelae")!.id!)).toBe(true);
    // member lineages stay expanded
    expect(collapsed.has(findTaxonByName(tree, "Streptomyces")!.id!)).toBe(false);
    expect(collapsed.has(findTaxonByName(tree, "Kitasatospora")!.id!)).toBe(false);
    expect(collapsed.has(findTaxonByName(tree, "Actinomycetota")!.id!)).toBe(false);
    // the layout still resolves and drops the collapsed descendants
    const layout = computeTreeLayout(root, collapsed, 800);
    expect(
      layout.nodes.some((n) => n.data._kind === "genome" && n.data.accession.includes("AVERMITILIS")),
    ).toBe(false);
  });
});

describe("rectangular label placement", () => {
  /** A stand-in for what d3.tree() hands the canvas: `x` is the cross-axis
   * position (the row), `depth` is the column. Only those three fields and
   * `data` are read, so the fixture stays honest about its coupling. */
  function row(name: string, x: number, depth: number, rank = "genus") {
    return {
      x,
      y: depth * 150,
      depth,
      data: { _kind: "taxon", id: name, name, rank, children: [], direct_genomes: [], bgcs: [] },
    } as never;
  }

  it("suppresses labels whose rows are too close to read", () => {
    // This is the bug. `rowHeightFor` takes rows to 11px past 600 leaves,
    // against 12-13px text, and the rectangular layout had no rule at all:
    // `showLabel` read `!isRadial || …`, which short-circuits to true for
    // every node whenever the tree is not radial.
    // 11px rows against 12-13px text: text taller than its own row.
    const nodes = [row("a", 0, 3), row("b", 11, 3), row("c", 22, 3)];
    const { visible, suppressed } = placeRectangularLabels(nodes, 1);

    expect(visible.size).toBeLessThan(nodes.length);
    expect(suppressed).toBeGreaterThan(0);
    // Whatever survives must be mutually legible.
    const kept = nodes.filter((n) => visible.has((n as never as { data: { name: string } }).data.name));
    for (let i = 1; i < kept.length; i += 1) {
      const gap = Math.abs((kept[i] as never as { x: number }).x - (kept[i - 1] as never as { x: number }).x);
      expect(gap).toBeGreaterThanOrEqual(MIN_LABEL_ROW_PX);
    }
  });

  it("keeps every label once rows are far enough apart", () => {
    const nodes = [row("a", 0, 3), row("b", 40, 3), row("c", 80, 3)];
    const { visible, suppressed } = placeRectangularLabels(nodes, 1);
    expect(visible.size).toBe(3);
    expect(suppressed).toBe(0);
  });

  it("reveals suppressed labels as the reader zooms in", () => {
    // Labels hold a constant screen size, so zooming spreads the rows apart
    // underneath type that does not grow — which is exactly the room a
    // suppressed label was waiting for. Density varies, size does not.
    const nodes = [row("a", 0, 3), row("b", 8, 3), row("c", 16, 3)];
    expect(placeRectangularLabels(nodes, 1).visible.size).toBeLessThan(3);
    expect(placeRectangularLabels(nodes, 4).visible.size).toBe(3);
  });

  it("suppresses more as the reader zooms out", () => {
    // The other direction, and the one that matters at first paint:
    // fit-to-view lands near k=0.2 for a default tree, where rows are only
    // a few screen pixels apart and almost nothing can be labelled.
    const nodes = Array.from({ length: 40 }, (_, i) => row(`n${i}`, i * 24, 3));
    const wide = placeRectangularLabels(nodes, 1).visible.size;
    const far = placeRectangularLabels(nodes, 0.2).visible.size;
    expect(far).toBeLessThan(wide);
    expect(far).toBeGreaterThan(0);
  });

  it("does not let one column crowd out another", () => {
    // Each depth is its own column on screen, so nodes at different depths
    // cannot collide however close their rows are. Treating the tree as one
    // flat list would throw away most of the labels for nothing.
    const nodes = [row("a", 0, 1), row("b", 1, 2), row("c", 2, 3)];
    expect(placeRectangularLabels(nodes, 1).visible.size).toBe(3);
  });

  it("drops an ordinary label before an orienting one", () => {
    // Anchor ranks are what tells a reader where they are in the tree, so
    // they win the row when something has to give.
    const nodes = [row("Streptomyces", 0, 3, "genus"), row("Actinomycetota", 4, 3, "phylum")];
    const { visible } = placeRectangularLabels(nodes, 1);
    expect(visible.has("Actinomycetota")).toBe(true);
    expect(visible.has("Streptomyces")).toBe(false);
  });

  it("keeps a search hit even against an anchor", () => {
    // A name the reader is actively looking for is the last thing to drop,
    // never the first — otherwise searching hides its own answer.
    const nodes = [row("Actinomycetota", 0, 3, "phylum"), row("Streptomyces", 4, 3, "genus")];
    const { visible } = placeRectangularLabels(nodes, 1, {
      boost: (n) => ((n as never as { data: { name: string } }).data.name === "Streptomyces" ? 5000 : 0),
    });
    expect(visible.has("Streptomyces")).toBe(true);
  });

  it("is stable across repeated calls so panning does not reshuffle labels", () => {
    const nodes = [row("a", 0, 3), row("b", 7, 3), row("c", 14, 3), row("d", 21, 3)];
    const first = [...placeRectangularLabels(nodes, 1).visible].sort();
    const second = [...placeRectangularLabels(nodes, 1).visible].sort();
    expect(first).toEqual(second);
  });

  it("keeps at least one label per column however tight it gets", () => {
    // Going blank would trade an unreadable state for an empty one, which
    // is not an improvement. Something is always labelled.
    const nodes = [row("a", 0, 3), row("b", 0.5, 3), row("c", 1, 3)];
    expect(placeRectangularLabels(nodes, 1).visible.size).toBe(1);
  });
});

describe("label clearance for the aligned glyph track", () => {
  it("is wide enough that bars cannot land on an accession", () => {
    // The bug: the track sat a flat GLYPH_TRACK_GUTTER of 26 layout units
    // past the deepest tip, while a real accession is far wider than that
    // — so the cluster bars were drawn straight through the names.
    const accession = "GCF_000156695.2"; // 15 chars, a real one from the corpus
    expect(estimateLabelWidth(accession)).toBeGreaterThan(26);
  });

  it("grows as the reader zooms out, because the label does not shrink", () => {
    // Labels hold a constant SCREEN size, so the further out the tree is
    // zoomed the more LAYOUT space a name covers. Clearance computed from a
    // constant would be right at exactly one zoom level and wrong at every
    // other, which is how the overlap got worse rather than better.
    const accession = "GCF_000156695.2";
    const atOne = estimateLabelWidth(accession, 1);
    const atFit = estimateLabelWidth(accession, 5); // labelScale at k=0.2
    expect(atFit).toBeCloseTo(atOne * 5);
    expect(atFit).toBeGreaterThan(500);
  });

  it("scales with the name, so a long one is not clipped by a short one", () => {
    expect(estimateLabelWidth("Streptomyces coelicolor")).toBeGreaterThan(
      estimateLabelWidth("Bacillus"),
    );
    expect(estimateLabelWidth("")).toBe(0);
  });
});

describe("rank vocabulary spans both trees", () => {
  it("treats kingdom as an anchor, so the eukaryote tree keeps its bearings", () => {
    // GTDB never emits `kingdom`; NCBI does, and `Fungi` / `Viridiplantae`
    // are the two labels that say which half of the eukaryote tree you are
    // in — the job `Bacteria` and `Actinomycetota` do on the other tab.
    // Omitting it gave one shared renderer two different behaviours: the
    // eukaryote anchors took ordinary priority and were the FIRST labels
    // dropped, on the tree least able to lose them.
    expect(isAnchorRank("kingdom")).toBe(true);
    expect(isAnchorRank("domain")).toBe(true);
    expect(isAnchorRank("phylum")).toBe(true);
    expect(isAnchorRank("species")).toBe(false);
  });

  it("draws kingdom at the same weight as the other top ranks", () => {
    expect(isHighRank("kingdom")).toBe(true);
    expect(isHighRank("domain")).toBe(true);
    expect(isHighRank("phylum")).toBe(true);
    expect(isHighRank("genus")).toBe(false);
  });

  it("keeps an anchor label ahead of an ordinary one on either tree", () => {
    // The behaviour the two rules above exist to produce, asserted on the
    // eukaryote lineage specifically.
    const nodes = [
      { x: 0, y: 300, depth: 2, data: { _kind: "taxon", id: "Aspergillus", name: "Aspergillus", rank: "genus", children: [], direct_genomes: [], bgcs: [] } },
      { x: 4, y: 300, depth: 2, data: { _kind: "taxon", id: "Fungi", name: "Fungi", rank: "kingdom", children: [], direct_genomes: [], bgcs: [] } },
    ] as never[];
    const { visible } = placeRectangularLabels(nodes, 1);
    expect(visible.has("Fungi")).toBe(true);
    expect(visible.has("Aspergillus")).toBe(false);
  });
});

describe("tip sizing", () => {
  it("gives every tier a radius big enough to see once scaled", () => {
    // Drawn in layout units these were 0.4-1.9px at the default 0.2x view.
    // The floor is a visibility floor, not the current size: these are
    // screen pixels now, and a 2px radius is a 4px dot at every zoom.
    for (const tier of BGC_SIZE_TIERS) {
      expect(tier.radius).toBeGreaterThanOrEqual(2);
    }
  });


  it("keeps the tiers strictly ordered, so size still encodes count", () => {
    for (let i = 1; i < BGC_SIZE_TIERS.length; i++) {
      expect(BGC_SIZE_TIERS[i]!.radius).toBeGreaterThan(BGC_SIZE_TIERS[i - 1]!.radius);
    }
    expect(bgcSizeTier(0).radius).toBeLessThan(bgcSizeTier(100).radius);
    expect(bgcSizeTier(3).radius).toBeLessThan(bgcSizeTier(30).radius);
  });
});
