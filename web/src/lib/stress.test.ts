/**
 * Property-based stress over the figure's maths.
 *
 * No fast-check in this project, so the generator is a seeded xorshift —
 * which is what you want here anyway: a failure reproduces from its seed
 * instead of vanishing on the next run, and the figure layer is supposed to
 * be deterministic in the first place.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_BRANCH_WIDTH,
  MIN_BRANCH_WIDTH,
  MIN_LABEL_ROW_PX,
  branchWidth,
  estimateLabelWidth,
  computeLabelSeparations,
  selectLabels,
} from "./tree-logic";

/** What TreeCanvas actually does: separations once (they do not depend on
 *  zoom), threshold per frame. Composed here rather than imported, because
 *  the wrapper that used to do it shipped to nobody — testing it tested a
 *  code path the app never took. */
function placeLabels(
  nodes: Parameters<typeof computeLabelSeparations>[0],
  zoomScale: number,
  options: Parameters<typeof computeLabelSeparations>[1] & { minSeparationPx?: number } = {},
) {
  return selectLabels(
    computeLabelSeparations(nodes, options),
    zoomScale,
    options.minSeparationPx ?? MIN_LABEL_ROW_PX,
  );
}

/** Deterministic PRNG — a failing case is reproducible from its seed. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1_000_000) / 1_000_000;
  };
}

const RUNS = 400;

function taxonRow(name: string, x: number, depth: number, rank = "genus") {
  return {
    x,
    y: depth * 150,
    depth,
    data: {
      _kind: "taxon",
      id: name,
      name,
      rank,
      children: [],
      direct_genomes: [],
      bgcs: [],
      bgc_class_counts: {},
    },
  } as never;
}

function genomeLeaf(count: number) {
  return {
    _kind: "genome",
    id: `g${count}`,
    accession: "GCF_000000001.1",
    bgcs: Array.from({ length: count }, (_, i) => ({ id: `b${i}`, family_ids: [] })),
  } as never;
}

describe("stress: branch weight", () => {
  it("never leaves the declared range, for any count", () => {
    // The clamp exists because an unbounded width once drew a 27px slab
    // across the figure when a caller passed a stale maximum. Counts beyond
    // the maximum are exactly that case.
    const r = rng(20260901);
    for (let i = 0; i < RUNS; i++) {
      const count = Math.floor(r() * 5000);
      const max = Math.floor(r() * 2000);
      const w = branchWidth(genomeLeaf(count), max);
      expect(w).toBeGreaterThanOrEqual(MIN_BRANCH_WIDTH);
      expect(w).toBeLessThanOrEqual(MAX_BRANCH_WIDTH);
      expect(Number.isFinite(w)).toBe(true);
    }
  });

  it("is monotonic in cluster count — more clusters is never a thinner branch", () => {
    // The encoding's whole meaning. If it inverted anywhere, a reader
    // comparing two branches would draw the opposite conclusion.
    const r = rng(7);
    for (let i = 0; i < RUNS; i++) {
      const max = 1 + Math.floor(r() * 900);
      const a = Math.floor(r() * 900);
      const b = a + Math.floor(r() * 200);
      expect(branchWidth(genomeLeaf(b), max)).toBeGreaterThanOrEqual(
        branchWidth(genomeLeaf(a), max),
      );
    }
  });

  it("degenerate maxima do not produce NaN or a slab", () => {
    for (const max of [0, -1, NaN]) {
      for (const count of [0, 1, 10_000]) {
        const w = branchWidth(genomeLeaf(count), max);
        expect(Number.isFinite(w)).toBe(true);
        expect(w).toBeLessThanOrEqual(MAX_BRANCH_WIDTH);
      }
    }
  });
});

describe("stress: label placement", () => {
  it("never lets two surviving labels in one column overlap", () => {
    // The invariant the whole pass exists for, asserted over generated
    // trees rather than the handful of shapes anyone wrote down.
    const r = rng(99);
    for (let run = 0; run < RUNS; run++) {
      const n = 2 + Math.floor(r() * 60);
      const depth = 1 + Math.floor(r() * 4);
      const zoom = 0.05 + r() * 3;
      const nodes = Array.from({ length: n }, (_, i) =>
        taxonRow(`t${i}`, Math.round(r() * 2000), depth),
      );
      const { visible } = placeLabels(nodes, zoom);
      const kept = nodes
        .filter((nd) => visible.has((nd as never as { data: { id: string } }).data.id))
        .map((nd) => (nd as never as { x: number }).x)
        .sort((a, b) => a - b);
      const needed = MIN_LABEL_ROW_PX / zoom;
      for (let i = 1; i < kept.length; i++) {
        expect((kept[i] as number) - (kept[i - 1] as number)).toBeGreaterThanOrEqual(needed);
      }
    }
  });

  it("only ever returns labels it was given, and never duplicates", () => {
    const r = rng(1234);
    for (let run = 0; run < RUNS; run++) {
      const n = 1 + Math.floor(r() * 40);
      const nodes = Array.from({ length: n }, (_, i) =>
        taxonRow(`t${i}`, Math.round(r() * 500), 1 + Math.floor(r() * 3)),
      );
      const ids = new Set(nodes.map((nd) => (nd as never as { data: { id: string } }).data.id));
      const { visible, suppressed } = placeLabels(nodes, 0.2 + r() * 2);
      for (const v of visible) expect(ids.has(v)).toBe(true);
      expect(visible.size + suppressed).toBe(n);
    }
  });

  it("is deterministic — the same input always yields the same labels", () => {
    // Figures must be reproducible from their view state. A placement that
    // depended on iteration order would make an exported SVG unrepeatable.
    const r = rng(555);
    for (let run = 0; run < 60; run++) {
      const nodes = Array.from({ length: 30 }, (_, i) =>
        taxonRow(`t${i}`, Math.round(r() * 400), 2),
      );
      const a = [...placeLabels(nodes, 0.7).visible].sort();
      const b = [...placeLabels(nodes, 0.7).visible].sort();
      expect(a).toEqual(b);
    }
  });

  it("is monotonic in zoom — zooming in never hides a label that was shown", () => {
    // Labels hold a constant screen size, so zooming only ever adds room.
    // A label disappearing on zoom-in would read as a bug to any user.
    const r = rng(31337);
    for (let run = 0; run < 120; run++) {
      const nodes = Array.from({ length: 25 }, (_, i) =>
        taxonRow(`t${i}`, Math.round(r() * 600), 2),
      );
      const low = placeLabels(nodes, 0.3).visible;
      const high = placeLabels(nodes, 1.5).visible;
      for (const id of low) expect(high.has(id)).toBe(true);
    }
  });

  it("always labels something when given something", () => {
    const r = rng(8);
    for (let run = 0; run < RUNS; run++) {
      const n = 1 + Math.floor(r() * 30);
      const nodes = Array.from({ length: n }, (_, i) => taxonRow(`t${i}`, i * 0.01, 2));
      expect(placeLabels(nodes, 0.1 + r()).visible.size).toBeGreaterThan(0);
    }
  });
});

describe("stress: label clearance", () => {
  it("is monotonic in name length and in zoom-out", () => {
    const r = rng(4242);
    for (let i = 0; i < RUNS; i++) {
      const short = "A".repeat(1 + Math.floor(r() * 10));
      const long = short + "A".repeat(1 + Math.floor(r() * 20));
      const s = 0.1 + r() * 4;
      expect(estimateLabelWidth(long, s)).toBeGreaterThan(estimateLabelWidth(short, s));
      expect(estimateLabelWidth(short, s * 2)).toBeCloseTo(estimateLabelWidth(short, s) * 2);
    }
  });
});
