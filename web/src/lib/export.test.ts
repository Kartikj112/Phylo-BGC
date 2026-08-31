/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";
import { CONFIG_VERSION, buildViewConfig, figureFilename, serializeSvgForExport } from "./export";
import type { DatasetProvenanceResponse } from "./api-types";

const PROVENANCE: DatasetProvenanceResponse = {
  sources: [
    {
      id: "11111111-1111-1111-1111-111111111111",
      name: "GTDB",
      source_type: "reference_database",
      version: "R11-RS232",
      url: null,
      license: "CC-BY-SA-4.0",
      citation: null,
      retrieved_at: null,
      created_at: "2026-08-24T00:00:00Z",
      updated_at: "2026-08-24T00:00:00Z",
    },
  ],
  genome_count: 5,
  bgc_count: 12,
  taxon_count: 9,
  // The export path asks for the whole database on purpose — a figure's
  // recorded provenance describes the dataset, not the tab that was open —
  // so the scoped and corpus counts coincide here.
  scope: "all",
  corpus_genome_count: 5,
  corpus_bgc_count: 12,
  corpus_taxon_count: 9,
  family_count: 2,
  engine_version: "0.1.0",
};

const ALL_CLASSES = ["nrps", "pks", "ripp", "terpene", "siderophore", "saccharide", "alkaloid", "other"];

function config(overrides: Partial<Parameters<typeof buildViewConfig>[0]> = {}) {
  return buildViewConfig({
    provenance: PROVENANCE,
    collapsed: new Set(),
    activeClasses: new Set(ALL_CLASSES),
    allClasses: ALL_CLASSES,
    selectedFamilyId: null,
    comparisonTaxonIds: [],
    searchQuery: "",
    ...overrides,
  });
}

describe("buildViewConfig", () => {
  it("records the real dataset provenance, not just the tool version", () => {
    const c = config();
    expect(c.dataset.genome_count).toBe(5);
    expect(c.dataset.sources[0]!.name).toBe("GTDB");
    expect(c.dataset.sources[0]!.version).toBe("R11-RS232");
    expect(c.dataset.sources[0]!.license).toBe("CC-BY-SA-4.0");
  });

  it("records 'all classes selected' as an empty filter, not all eight names", () => {
    // The UI's default is everything selected; recording all eight would
    // make every default export look deliberately filtered.
    expect(config().tree_state.active_bgc_classes).toEqual([]);
  });

  it("records a real filter when one is actually applied", () => {
    const c = config({ activeClasses: new Set(["nrps", "terpene"]) });
    expect(c.tree_state.active_bgc_classes).toEqual(["nrps", "terpene"]);
  });

  it("sorts collapsed ids so the same view yields a byte-identical config", () => {
    const a = config({ collapsed: new Set(["z", "a", "m"]) });
    const b = config({ collapsed: new Set(["m", "z", "a"]) });
    expect(a.tree_state.collapsed_node_ids).toEqual(["a", "m", "z"]);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("switches view_type when two or more clades are being compared", () => {
    expect(config().view_type).toBe("taxonomy_tree");
    expect(config({ comparisonTaxonIds: ["a"] }).view_type).toBe("taxonomy_tree");
    expect(config({ comparisonTaxonIds: ["a", "b"] }).view_type).toBe("clade_comparison");
  });

  it("carries the config version the engine will validate against", () => {
    expect(config().config_version).toBe(CONFIG_VERSION);
  });

  it("preserves family highlight and search state", () => {
    const c = config({ selectedFamilyId: "fam-1", searchQuery: "Strepto" });
    expect(c.tree_state.selected_family_id).toBe("fam-1");
    expect(c.tree_state.search_query).toBe("Strepto");
  });
});

function makeSvg(): SVGSVGElement {
  document.body.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" width="100%" height="400" viewBox="0 0 900 400">
      <g class="cursor-pointer" transform="translate(30,20)">
        <text x="-9" font-size="12" fill="#1C1E1B">Streptomyces</text>
        <text x="10" class="font-mono" font-size="11.5" fill="#5B5F58">GCF_000203835.1</text>
        <rect x="132" y="-5" width="7" height="10" fill="#8B5A3C"></rect>
      </g>
    </svg>`;
  return document.querySelector("svg")!;
}

describe("serializeSvgForExport", () => {
  it("replaces the responsive width with real viewBox dimensions", () => {
    // width="100%" is meaningless once the SVG leaves the page.
    const out = serializeSvgForExport(makeSvg());
    expect(out).toContain('width="900"');
    expect(out).toContain('height="400"');
    expect(out).not.toContain('width="100%"');
  });

  it("inlines font families, which otherwise live only in the page stylesheet", () => {
    const out = serializeSvgForExport(makeSvg());
    expect(out).toContain("IBM Plex Sans");
    expect(out).toContain("IBM Plex Mono");
  });

  it("gives monospace treatment only to the elements that had font-mono", () => {
    const doc = new DOMParser().parseFromString(serializeSvgForExport(makeSvg()), "image/svg+xml");
    const texts = [...doc.querySelectorAll("text")];
    const accession = texts.find((t) => t.textContent?.includes("GCF_"))!;
    const taxon = texts.find((t) => t.textContent?.includes("Streptomyces"))!;
    expect(accession.getAttribute("font-family")).toContain("Mono");
    expect(taxon.getAttribute("font-family")).not.toContain("Mono");
  });

  it("strips Tailwind classes, which mean nothing outside the page", () => {
    const out = serializeSvgForExport(makeSvg());
    expect(out).not.toContain("cursor-pointer");
    expect(out).not.toContain("font-mono");
  });

  it("preserves the drawing itself", () => {
    const doc = new DOMParser().parseFromString(serializeSvgForExport(makeSvg()), "image/svg+xml");
    expect(doc.querySelector("rect")?.getAttribute("fill")).toBe("#8B5A3C");
    expect(doc.querySelector("g")?.getAttribute("transform")).toBe("translate(30,20)");
  });

  it("does not mutate the live SVG in the page", () => {
    const svg = makeSvg();
    serializeSvgForExport(svg);
    expect(svg.getAttribute("width")).toBe("100%");
    expect(svg.querySelector("g")?.getAttribute("class")).toBe("cursor-pointer");
  });
});

describe("figureFilename", () => {
  it("slugifies a title", () => {
    expect(figureFilename("Figure 3: NRPS distribution", "pdf")).toBe("figure-3-nrps-distribution.pdf");
  });

  it("falls back when there is no usable title", () => {
    expect(figureFilename(null, "svg")).toBe("bgc-scape-figure.svg");
    expect(figureFilename("!!!", "pdf")).toBe("bgc-scape-figure.pdf");
  });
});
