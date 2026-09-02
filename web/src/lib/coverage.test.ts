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
  EMPTY_FILTERS,
  cladeSummary,
  emptyCladeReading,
  filtersAreActive,
  genomePassesFilters,
  matchesQuery,
  toRootDisplayNode,
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
