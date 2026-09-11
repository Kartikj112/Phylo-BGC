/**
 * Examined vs. unexamined, in the tree logic.
 *
 * The distinction the interface could not previously draw: a clade
 * antiSMASH surveyed and found nothing in, and a clade nobody has ever
 * looked at, both had zero clusters and drew the same outlined rectangle.
 * Only the first is a biological finding.
 */
import { describe, expect, it } from "vitest";
import {
  EMPTY_COVERAGE_ROLLUP,
  EMPTY_FILTERS,
  cladeSummary,
  coverageAt,
  coverageRollupIndex,
  emptyCladeReading,
  filtersAreActive,
  genomePassesFilters,
  matchesQuery,
  pruneToBgcBearing,
  surveyBasis,
  toRootDisplayNode,
  unsurveyedCount,
  type CoverageRollup,
  type FamilyDistribution,
} from "./tree-logic";
import type { CoverageState, GenomeSummary, TaxonTreeNode } from "./api-types";

function genome(id: string, coverage: CoverageState, bgcCount = 0): GenomeSummary {
  return {
    id,
    accession: `GCF_${id}.1`,
    assembly_level: "complete_genome",
    is_mag: false,
    coverage,
    bgcs: Array.from({ length: bgcCount }, (_, i) => ({
      id: `${id}-b${i}`,
      bgc_class: "nrps" as const,
      subtype: null,
      mibig_accession: null,
      evidence_level: "predicted" as const,
      family_ids: [],
      compounds: [],
    })),
  };
}

function clade(genomes: GenomeSummary[], bgcCounts: Record<string, number> = {}): TaxonTreeNode {
  return {
    id: "c1",
    name: "Testgenus",
    rank: "genus",
    genome_count: genomes.length,
    examined_genome_count: genomes.filter((g) => g.coverage === "examined").length,
    bgc_class_counts: bgcCounts,
    direct_genomes: genomes,
    children: [],
  };
}

describe("clade coverage", () => {
  it("distinguishes an examined-empty clade from an unexamined one", () => {
    const surveyed = cladeSummary(
      toRootDisplayNode(clade([genome("a", "examined"), genome("b", "examined")])),
    );
    const untouched = cladeSummary(
      toRootDisplayNode(clade([genome("c", "unexamined"), genome("d", "unexamined")])),
    );

    // Identical on every number the glyph used to have.
    expect(surveyed.bgcCount).toBe(0);
    expect(untouched.bgcCount).toBe(0);
    expect(surveyed.genomeCount).toBe(untouched.genomeCount);

    // And now distinguishable.
    expect(emptyCladeReading(surveyed)).toBe("examined-empty");
    expect(emptyCladeReading(untouched)).toBe("unexamined");
  });

  it("reports a partly-examined clade as neither", () => {
    const mixed = cladeSummary(
      toRootDisplayNode(clade([genome("a", "examined"), genome("b", "unexamined")])),
    );
    expect(mixed.examinedGenomeCount).toBe(1);
    expect(mixed.genomeCount).toBe(2);
    expect(emptyCladeReading(mixed)).toBe("partly-examined");
  });

  it("treats a curated-only genome as unexamined, because it is", () => {
    /* A MIBiG entry reports that one cluster exists in an organism; it is
     * not a survey of that organism's genome. Counting it as coverage would
     * turn "somebody once published three clusters" into "we looked and
     * found three". */
    const curated = cladeSummary(
      toRootDisplayNode(clade([genome("a", "curated_only", 3)], { nrps: 3 })),
    );
    expect(curated.bgcCount).toBe(3);
    expect(curated.examinedGenomeCount).toBe(0);
  });

  it("counts a single examined genome as its own denominator", () => {
    const one = cladeSummary({ ...genome("solo", "examined"), _kind: "genome" });
    expect(one.genomeCount).toBe(1);
    expect(one.examinedGenomeCount).toBe(1);
    expect(emptyCladeReading(one)).toBe("examined-empty");
  });

  it("counts a single unexamined genome as unexamined", () => {
    const one = cladeSummary({ ...genome("solo", "unexamined"), _kind: "genome" });
    expect(one.examinedGenomeCount).toBe(0);
    expect(emptyCladeReading(one)).toBe("unexamined");
  });

  it("rolls examined counts up through children", () => {
    const parent: TaxonTreeNode = {
      id: "p",
      name: "Parentfamily",
      rank: "family",
      genome_count: 4,
      examined_genome_count: 3,
      bgc_class_counts: { pks: 2 },
      direct_genomes: [genome("a", "examined")],
      children: [
        {
          ...clade([genome("b", "examined"), genome("c", "examined"), genome("d", "unexamined")]),
          id: "child",
        },
      ],
    };
    const summary = cladeSummary(toRootDisplayNode(parent));
    expect(summary.genomeCount).toBe(4);
    expect(summary.examinedGenomeCount).toBe(3);
  });
});

/**
 * Genome QC filters, and the tri-state MAG flag.
 *
 * `is_mag` was a NOT NULL boolean that every ingest path wrote False into
 * without a source, so "unknown" and "no" were the same value. These pin
 * the distinction where the filter can see it.
 */
describe("genome filters", () => {
  const g = (over: Partial<GenomeSummary>): GenomeSummary & { _kind: "genome" } => ({
    ...genome("f", "examined"),
    ...over,
    _kind: "genome",
  });

  it("filters on contamination as a maximum, not a minimum", () => {
    const filters = { ...EMPTY_FILTERS, maxContaminationPct: 5 };
    expect(genomePassesFilters(g({ contamination_pct: 1.2 }), filters)).toBe(true);
    expect(genomePassesFilters(g({ contamination_pct: 12 }), filters)).toBe(false);
  });

  it("keeps genomes with no contamination measurement", () => {
    /* 551 of the 1,542 genomes in the shipped corpus are MIBiG loci with no
     * QC figures at all. Dropping them would make the filter look far more
     * selective than it is — the same rule the other filters follow. */
    const filters = { ...EMPTY_FILTERS, maxContaminationPct: 1 };
    expect(genomePassesFilters(g({ contamination_pct: null }), filters)).toBe(true);
  });

  it("counts contamination as an active filter", () => {
    expect(filtersAreActive({ ...EMPTY_FILTERS, maxContaminationPct: 5 })).toBe(true);
    expect(filtersAreActive(EMPTY_FILTERS)).toBe(false);
  });

  it("completeness and contamination compose", () => {
    const filters = { ...EMPTY_FILTERS, minCompletenessPct: 90, maxContaminationPct: 5 };
    // The case the pair exists for: high completeness is not enough on its own.
    expect(
      genomePassesFilters(g({ completeness_pct: 95, contamination_pct: 12 }), filters),
    ).toBe(false);
    expect(
      genomePassesFilters(g({ completeness_pct: 95, contamination_pct: 1 }), filters),
    ).toBe(true);
  });

  it("'MAGs only' excludes a genome whose MAG status was never established", () => {
    const filters = { ...EMPTY_FILTERS, magOnly: true };
    expect(genomePassesFilters(g({ is_mag: true }), filters)).toBe(true);
    expect(genomePassesFilters(g({ is_mag: false }), filters)).toBe(false);
    // Excluded for want of an answer, not because the answer was no — the
    // panel says so; what matters here is that it is not counted as a MAG.
    expect(genomePassesFilters(g({ is_mag: null }), filters)).toBe(false);
  });

  it("an unknown MAG status does not answer a 'mag' search", () => {
    expect(matchesQuery(g({ is_mag: true }), "mag")).toBe(true);
    expect(matchesQuery(g({ is_mag: null }), "mag")).toBe(false);
  });
});

/**
 * The three-state rollup, recomputed from the genome rows on screen.
 *
 * Two things the tree could not previously do: tell `curated_only` from
 * `unexamined` at clade level, and stay correct once a filter has changed
 * which genomes are in the tree. Both are pinned here.
 */
describe("coverageRollupIndex", () => {
  it("separates curated-only from unexamined, which the rolled-up count cannot", () => {
    const root = toRootDisplayNode(
      clade([
        genome("a", "curated_only", 2),
        genome("b", "curated_only", 1),
        genome("c", "unexamined"),
        genome("d", "examined"),
      ]),
    );
    const index = coverageRollupIndex(root);
    const here = coverageAt(index, root);

    expect(here).toEqual({ genomeCount: 4, examined: 1, curatedOnly: 2, unexamined: 1 });
    // The number the old field carried collapses two of those three.
    expect(root.examined_genome_count).toBe(1);
    expect(unsurveyedCount(here)).toBe(3);
  });

  it("rolls up through children and keys every genome too", () => {
    const child = { ...clade([genome("b", "examined"), genome("c", "unexamined")]), id: "child" };
    const parent: TaxonTreeNode = {
      id: "p",
      name: "Parentfamily",
      rank: "family",
      genome_count: 3,
      examined_genome_count: 2,
      bgc_class_counts: {},
      direct_genomes: [genome("a", "curated_only", 1)],
      children: [child],
    };
    const index = coverageRollupIndex(toRootDisplayNode(parent));

    expect(index.get("p")).toEqual({
      genomeCount: 3,
      examined: 1,
      curatedOnly: 1,
      unexamined: 1,
    });
    expect(index.get("child")).toEqual({
      genomeCount: 2,
      examined: 1,
      curatedOnly: 0,
      unexamined: 1,
    });
    // Genomes are in the index as rollups of one, so a caller never has to
    // branch on node kind.
    expect(index.get("a")).toEqual({
      genomeCount: 1,
      examined: 0,
      curatedOnly: 1,
      unexamined: 0,
    });
  });

  it("survives the prune that leaves examined_genome_count describing another tree", () => {
    /* The latent bug this function exists to remove. `pruneToBgcBearing`
     * recomputes genome_count and not examined_genome_count, so after a
     * prune the pair describes two different populations — and the glyph's
     * unexamined fraction could go negative. */
    const root = toRootDisplayNode(
      clade(
        [
          genome("keeps", "examined", 2),
          genome("dropped1", "examined"),
          genome("dropped2", "examined"),
        ],
        // The clade has to hold clusters or the prune declines to run at
        // all, which is its own (correct) fallback and not what this covers.
        { nrps: 2 },
      ),
    );
    const { root: pruned } = pruneToBgcBearing(root, true);

    expect(pruned.genome_count).toBe(1);
    // Stale by construction: three examined genomes claimed over one genome.
    expect(pruned.examined_genome_count).toBe(3);

    const here = coverageAt(coverageRollupIndex(pruned), pruned);
    expect(here.genomeCount).toBe(1);
    expect(here.examined).toBe(1);
    expect(here.genomeCount - here.examined).toBeGreaterThanOrEqual(0);
  });

  it("returns an empty rollup for a node it has never seen", () => {
    expect(coverageAt(new Map(), toRootDisplayNode(clade([])))).toEqual(EMPTY_COVERAGE_ROLLUP);
    expect(coverageAt(null, toRootDisplayNode(clade([])))).toEqual(EMPTY_COVERAGE_ROLLUP);
  });
});

/**
 * The second sentence — the one the reframe turns on.
 *
 * A footprint without its survey basis reads as a claim about biology when
 * it is a claim about a database.
 */
describe("surveyBasis", () => {
  const corpus = (over: Partial<CoverageRollup> = {}): CoverageRollup => ({
    genomeCount: 0,
    examined: 0,
    curatedOnly: 0,
    unexamined: 0,
    ...over,
  });

  it("states the corpus basis even with no family selected", () => {
    const basis = surveyBasis(null, null, corpus({ genomeCount: 1113, curatedOnly: 1113 }));
    expect(basis.footprintSentence).toBeNull();
    expect(basis.corpusSentence).toContain("None of the 1,113 genomes");
    expect(basis.corpusSentence).toContain("gap, not a finding");
    expect(basis.noSurveyHere).toBe(true);
  });

  it("counts curated-only genomes as never surveyed, because nobody surveyed them", () => {
    const basis = surveyBasis(null, null, corpus({ genomeCount: 100, examined: 10, curatedOnly: 80, unexamined: 10 }));
    expect(basis.corpusSentence).toBe(
      "90 of the 100 genomes in this view have never been surveyed for clusters.",
    );
  });

  it("says so plainly when everything has been surveyed", () => {
    const basis = surveyBasis(null, null, corpus({ genomeCount: 40, examined: 40 }));
    expect(basis.corpusSentence).toContain("All 40 genomes");
    expect(basis.noSurveyHere).toBe(false);
  });

  it("refuses a 'N of M surveyed' denominator when nothing in the clade was surveyed", () => {
    const distribution = {
      memberGenomeCount: 3,
      commonAncestor: { key: "amyco", name: "Amycolatopsis", rank: "genus", memberGenomes: 3 },
    } as FamilyDistribution;
    const index = new Map([["amyco", corpus({ genomeCount: 11, curatedOnly: 11 })]]);

    const basis = surveyBasis(distribution, index, corpus({ genomeCount: 1113, curatedOnly: 1113 }));
    expect(basis.footprintSentence).toBe(
      "No genome in Amycolatopsis has been surveyed for clusters, so its 3 occurrences are curated records rather than a census of 11 genomes.",
    );
    // The thing that must never appear: a fraction of zero surveyed genomes.
    expect(basis.footprintSentence).not.toContain("of the 0");
    expect(basis.noSurveyHere).toBe(true);
  });

  it("gives the real fraction once the clade has been surveyed", () => {
    const distribution = {
      memberGenomeCount: 3,
      commonAncestor: { key: "amyco", name: "Amycolatopsis", rank: "genus", memberGenomes: 3 },
    } as FamilyDistribution;
    const index = new Map([["amyco", corpus({ genomeCount: 11, examined: 8, curatedOnly: 3 })]]);

    const basis = surveyBasis(distribution, index, corpus({ genomeCount: 50, examined: 20, curatedOnly: 30 }));
    expect(basis.footprintSentence).toBe(
      "3 of the 8 surveyed genomes in Amycolatopsis carry it; 3 more there have never been surveyed.",
    );
    expect(basis.noSurveyHere).toBe(false);
  });

  it("drops the trailing clause when the whole clade is surveyed", () => {
    const distribution = {
      memberGenomeCount: 2,
      commonAncestor: { key: "k", name: "Kitasatospora", rank: "genus", memberGenomes: 2 },
    } as FamilyDistribution;
    const index = new Map([["k", corpus({ genomeCount: 4, examined: 4 })]]);
    const basis = surveyBasis(distribution, index, corpus({ genomeCount: 4, examined: 4 }));
    expect(basis.footprintSentence).toBe("2 of the 4 surveyed genomes in Kitasatospora carry it.");
  });

  it("quantifies over no clade when the family spans disjoint lineages", () => {
    /* With no common ancestor there is no honest denominator: summing the
     * separate lineages would merge populations the tree draws apart. */
    const distribution = {
      memberGenomeCount: 5,
      commonAncestor: null,
    } as FamilyDistribution;
    const basis = surveyBasis(distribution, new Map(), corpus({ genomeCount: 50, curatedOnly: 50 }));
    expect(basis.footprintSentence).toBeNull();
    expect(basis.corpusSentence).toContain("None of the 50 genomes");
  });

  it("says nothing about a footprint that has none", () => {
    const distribution = { memberGenomeCount: 0, commonAncestor: null } as FamilyDistribution;
    expect(surveyBasis(distribution, new Map(), corpus({ genomeCount: 9, examined: 9 })).footprintSentence).toBeNull();
  });
});
