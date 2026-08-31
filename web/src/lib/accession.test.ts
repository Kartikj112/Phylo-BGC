import { describe, expect, it } from "vitest";
import { bareAccession, isAssemblyAccession } from "./accession";

describe("bareAccession", () => {
  it("strips GTDB's provenance prefix", () => {
    expect(bareAccession("RS_GCF_000203835.1")).toBe("GCF_000203835.1");
    expect(bareAccession("GB_GCA_947493065.1")).toBe("GCA_947493065.1");
  });

  it("keeps the version, which the NCBI and GTDB links need", () => {
    expect(bareAccession("GCF_000006945.2")).toBe("GCF_000006945.2");
  });

  it("leaves an unprefixed accession alone", () => {
    expect(bareAccession("AACD01000015.1")).toBe("AACD01000015.1");
  });

  it("only strips a prefix at the start", () => {
    expect(bareAccession("CP_RS_001.1")).toBe("CP_RS_001.1");
  });
});

describe("isAssemblyAccession", () => {
  it("recognizes assemblies through a GTDB prefix", () => {
    expect(isAssemblyAccession("RS_GCF_000203835.1")).toBe(true);
    expect(isAssemblyAccession("GCA_947493065.1")).toBe(true);
  });

  it("rejects nucleotide records, which most MIBiG loci are", () => {
    // 551 of the 1,542 genome rows in the shipped corpus look like this,
    // so the NCBI link has to send them to nuccore rather than /genome/.
    for (const record of ["AACD01000015.1", "AB072893.1", "NC_003888.3", "LC016184.1"]) {
      expect(isAssemblyAccession(record)).toBe(false);
    }
  });

  it("rejects a GC-prefixed string that is not an accession", () => {
    expect(isAssemblyAccession("GCF_")).toBe(false);
    expect(isAssemblyAccession("GCX_000006945.1")).toBe(false);
  });
});
