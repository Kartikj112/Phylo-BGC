/**
 * Accession display rules, shared by the components that render one.
 *
 * **This is not the join.** Cross-source accession joining lives in the
 * engine (`engine/src/bgcscape/ingest/accession.py`) and stays there, per
 * ARCHITECTURE.md's separation of concerns: anything with scientific
 * meaning is the engine's, and deciding that `GCA_000006945` and
 * `GCF_000006945` are the same assembly is a scientific claim resting on
 * NCBI's pairing rule. The frontend never makes that call — it receives
 * resolved genomes from the API.
 *
 * What the frontend *does* need is the same two cosmetic rules in more
 * than one place: strip GTDB's `RS_`/`GB_` prefix for display and for
 * outbound links, and tell an assembly accession from a nucleotide record
 * so a link points at the right NCBI resource. Those were duplicated
 * inline, which is how the two drift apart.
 */

const GTDB_PREFIX = /^(RS_|GB_)/;
const ASSEMBLY = /^GC[AF]_\d+(\.\d+)?$/;

/**
 * Strip GTDB's provenance prefix: `RS_GCF_000203835.1` →
 * `GCF_000203835.1`. The version is deliberately kept — it is part of the
 * accession a user looks up at NCBI, and dropping it would produce a
 * link that resolves to a different assembly version or to nothing.
 */
export function bareAccession(accession: string): string {
  return accession.replace(GTDB_PREFIX, "");
}

/**
 * Whether this names a genome assembly (`GCF_*`/`GCA_*`) rather than a
 * nucleotide record (`AB072893.1`, `AACD01000015.1`). 551 of the 1,542
 * genome rows in the shipped corpus are records, not assemblies, because
 * MIBiG entries are loci — so this is the common case, not an edge one.
 */
export function isAssemblyAccession(accession: string): boolean {
  return ASSEMBLY.test(bareAccession(accession));
}
