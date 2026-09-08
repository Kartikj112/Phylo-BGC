import type { Metadata } from "next";
import Link from "next/link";
import { Fact, LegalPage } from "@/components/LegalPage";
import { PROJECT, softwareCitation } from "@/lib/project-info";

export const metadata: Metadata = {
  title: "Cite & data sources",
  description:
    "How to cite Phylo-BGC and the reference databases behind it, the licence attached to each, and the availability statement for the archived release.",
  alternates: { canonical: "/data-sources" },
};

export default function DataSources() {
  return (
    <LegalPage
      title="Cite &amp; data sources"
      updated="2026-09-08"
      summary={
        <>
          Phylo-BGC computes no biosynthetic predictions of its own; everything it shows derives from
          the public resources below. If you publish work using it, <strong>cite this tool and the
          databases it drew on</strong> &mdash; several of them require it, and{" "}
          <strong>GTDB is CC BY-SA 4.0</strong>, which places conditions on redistributing
          taxonomy-derived output.
        </>
      }
    >
      <h2>1. How to cite Phylo-BGC</h2>
      <p>Until a paper exists, cite the software release:</p>
      <blockquote className="cite-block">
        {softwareCitation()}
      </blockquote>
      <p>
        The archived, citable release is{" "}
        <Fact value={PROJECT.doi} />. A repository URL is not a persistent identifier &mdash; a repo
        can be force-pushed, renamed or deleted &mdash; so the DOI is what lets a reader fetch the
        exact version a figure came from. The machine-readable form of this citation lives in{" "}
        <code>CITATION.cff</code> at the repository root.
      </p>
      <p>
        Once a paper or preprint exists, cite that instead: <Fact value={PROJECT.citation} />
      </p>

      <h2>2. Availability statement</h2>
      <p>
        For the &ldquo;Data and code availability&rdquo; section most journals require, adapted to the
        journal&rsquo;s wording:
      </p>
      <blockquote className="cite-block">
        {PROJECT.name} is free and open-source software, released under the {PROJECT.codeLicense}{" "}
        Licence, available at {PROJECT.repositoryUrl} and archived at{" "}
        <Fact value={PROJECT.doi} />. A public instance requires no registration. It is built entirely
        from public reference data (MIBiG, GTDB, NCBI Taxonomy) and the published output of
        established tools (antiSMASH, BiG-SCAPE); no new sequence data was generated. Every exported
        figure embeds a machine-readable record of the source versions and corpus counts it was drawn
        from, and the same record is served live at <code>/api/v1/provenance</code>.
      </blockquote>
      <p>
        That last point is the reproducibility claim, and it is checkable rather than asserted: the
        database enforces at schema level that every stored fact names its source and its evidence
        level, so a figure cannot be produced from rows whose provenance is unrecorded.
      </p>

      <h2>3. Reference databases in the corpus</h2>
      <p>
        These are the sources recorded in the database&rsquo;s own <code>source</code> table. Cite the
        ones your result actually depends on.
      </p>

      <h3>GTDB &mdash; Genome Taxonomy Database (R11-RS232)</h3>
      <ul>
        <li><strong>Used for:</strong> the prokaryote taxonomy backbone and genome metadata.</li>
        <li>
          <strong>Licence: CC BY-SA 4.0.</strong> A ShareAlike licence. Attribution is required, and
          any dataset or view you derive from the taxonomy shown here must itself be redistributable
          under CC BY-SA 4.0 or a compatible licence. This is a real constraint on reuse of this
          site&rsquo;s output, not a footnote &mdash; worth checking against your journal&rsquo;s
          figure-licensing terms before submission.
        </li>
        <li>
          <strong>Source:</strong>{" "}
          <a href="https://gtdb.ecogenomic.org/" rel="noopener noreferrer external">gtdb.ecogenomic.org</a>
        </li>
      </ul>

      <h3>MIBiG 4.0</h3>
      <ul>
        <li>
          <strong>Used for:</strong> the curated reference clusters and their compound links &mdash;
          all 2,437 active clusters in the corpus.
        </li>
        <li>
          <strong>Licence:</strong> MIBiG does not pin its dataset to a single named licence badge, but
          the resource states there is no access restriction on academic or commercial use of the
          repository and its data. The MIBiG 4.0 paper describing the resource is CC BY 4.0.
        </li>
        <li>
          <strong>Source:</strong>{" "}
          <a href="https://mibig.secondarymetabolites.org/" rel="noopener noreferrer external">mibig.secondarymetabolites.org</a>
        </li>
      </ul>

      <h3>NCBI Taxonomy (downloaded 2026-08-28)</h3>
      <ul>
        <li>
          <strong>Used for:</strong> eukaryote lineages. GTDB is prokaryote-only, so the fungi and
          plants among the curated clusters are placed from here instead. The two taxonomies are served
          as separate views and are never merged &mdash; their rank semantics are incompatible.
        </li>
        <li>
          <strong>Licence:</strong> public domain, as a US Government work. NCBI requests citation but
          imposes no restriction on use or redistribution.
        </li>
        <li>
          <strong>Source:</strong>{" "}
          <a href="https://www.ncbi.nlm.nih.gov/taxonomy" rel="noopener noreferrer external">ncbi.nlm.nih.gov/taxonomy</a>
        </li>
      </ul>

      <h3>BiG-SCAPE 2.0.3</h3>
      <ul>
        <li>
          <strong>Used for:</strong> the sequence-similarity families, from a run over MIBiG 4.0 at
          clustering cutoff 0.3. Phylo-BGC stores this tool&rsquo;s output; it does not vendor or
          re-implement the tool.
        </li>
        <li>
          <strong>Source:</strong>{" "}
          <a href="https://github.com/medema-group/BiG-SCAPE" rel="noopener noreferrer external">github.com/medema-group/BiG-SCAPE</a>
        </li>
      </ul>

      <h3>antiSMASH</h3>
      <ul>
        <li>
          <strong>Used for:</strong> parsing user-uploaded result JSON. No antiSMASH-derived clusters
          are in the shipped corpus at present.
        </li>
        <li>
          <strong>Code licence: AGPL-3.0.</strong> Phylo-BGC vendors none of it. The ingest module is an
          independently written parser for antiSMASH&rsquo;s documented output format, not a derivative
          of the program, so the AGPL&rsquo;s network-use terms are not triggered.
        </li>
        <li>
          <strong>Source:</strong>{" "}
          <a href="https://antismash.secondarymetabolites.org/" rel="noopener noreferrer external">antismash.secondarymetabolites.org</a>
        </li>
      </ul>

      <h2>4. Software, fonts and icons</h2>
      <ul>
        <li>
          <strong>Phylo-BGC source code</strong> &mdash; {PROJECT.codeLicense} Licence. Governs this
          project&rsquo;s own code only, not the ingested datasets above.
        </li>
        <li>
          <strong>IBM Plex Sans and IBM Plex Mono</strong> &mdash; SIL Open Font License 1.1,
          self-hosted from this domain.
        </li>
        <li><strong>Lucide icons</strong> &mdash; ISC Licence.</li>
        <li><strong>D3</strong> &mdash; ISC. <strong>Next.js and React</strong> &mdash; MIT.</li>
      </ul>

      <h2>5. The Phylo-BGC wordmark</h2>
      <p>
        The animated and still wordmark on the loading screen and in the header is original to this
        project. <Fact value={PROJECT.wordmark} /> It is covered by the same{" "}
        {PROJECT.codeLicense} Licence as the rest of the repository, and is not derived from any
        third-party mark.
      </p>

      <h2>6. Reporting a problem</h2>
      <p>
        If you believe content here infringes your rights or misattributes a source, contact{" "}
        <Fact value={PROJECT.contactEmail} /> with enough detail to identify it. See also the{" "}
        <Link href="/terms">Terms of Use</Link>.
      </p>
    </LegalPage>
  );
}
