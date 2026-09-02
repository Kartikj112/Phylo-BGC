import { describe, expect, it } from "vitest";
import { formatProvenance } from "./LoadingQuestions";
import type { DatasetProvenanceResponse } from "@/lib/api-types";

function source(
  name: string,
  version: string | null,
  source_type: DatasetProvenanceResponse["sources"][number]["source_type"] = "reference_database",
): DatasetProvenanceResponse["sources"][number] {
  return {
    id: `00000000-0000-0000-0000-00000000000${name.length}`,
    name,
    source_type,
    version,
    url: null,
    license: null,
    citation: null,
    retrieved_at: null,
    created_at: "2026-08-24T00:00:00Z",
    updated_at: "2026-08-24T00:00:00Z",
  };
}

function provenance(over: Partial<DatasetProvenanceResponse> = {}): DatasetProvenanceResponse {
  return {
    sources: [source("MIBiG", "4.0"), source("GTDB", "R11-RS232")],
    genome_count: 1629,
    bgc_count: 2437,
    taxon_count: 900,
    family_count: 200,
    sequence_family_count: 0,
    compound_group_count: 0,
    engine_version: "0.1.0",
    scope: "all",
    corpus_genome_count: 1629,
    corpus_bgc_count: 2437,
    corpus_taxon_count: 900,
    examined_genome_count: 0,
    curated_only_genome_count: 0,
    unexamined_genome_count: 0,
    coverage_note: "",
    ...over,
  };
}

describe("formatProvenance", () => {
  it("renders counts and reference releases as one line", () => {
    expect(formatProvenance(provenance())).toBe(
      "2,437 clusters · 1,629 genomes · MIBiG 4.0 · GTDB R11-RS232",
    );
  });

  // The whole point of the line is that it is real. Before the call
  // resolves there is nothing true to say, so nothing is said — no
  // placeholder, no zeros.
  it("renders nothing before the call has resolved", () => {
    expect(formatProvenance(null)).toBeNull();
  });

  it("omits counts that are zero rather than printing them", () => {
    expect(formatProvenance(provenance({ bgc_count: 0 }))).toBe(
      "1,629 genomes · MIBiG 4.0 · GTDB R11-RS232",
    );
  });

  // A tool run or an uploaded file describes one session, not the corpus a
  // reader is about to browse.
  it("keeps non-reference sources out of the line", () => {
    const p = provenance({
      sources: [source("GTDB", "R11-RS232"), source("antiSMASH", "7.1", "tool_run")],
    });
    expect(formatProvenance(p)).toBe("2,437 clusters · 1,629 genomes · GTDB R11-RS232");
  });

  it("falls back to a bare name when a source carries no version", () => {
    const p = provenance({ sources: [source("MIBiG", null)] });
    expect(formatProvenance(p)).toBe("2,437 clusters · 1,629 genomes · MIBiG");
  });

  it("says nothing at all for an empty database", () => {
    const p = provenance({ sources: [], bgc_count: 0, genome_count: 0 });
    expect(formatProvenance(p)).toBeNull();
  });
});
