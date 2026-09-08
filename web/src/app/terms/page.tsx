import type { Metadata } from "next";
import Link from "next/link";
import { Fact, LegalPage } from "@/components/LegalPage";
import { PROJECT } from "@/lib/project-info";

export const metadata: Metadata = {
  title: "Terms of Use",
  description:
    "Phylo-BGC is a free academic research tool provided as-is. How to use it, how to cite it, and what its output does and does not claim.",
  alternates: { canonical: "/terms" },
};

export default function Terms() {
  return (
    <LegalPage
      title="Terms of Use"
      updated="2026-09-08"
      summary={
        <>
          <strong>In short:</strong> Phylo-BGC is a free, open-source academic tool with no accounts
          and no payments. Use it, build on it, cite it. Anything you upload becomes public and may be
          deleted at any time. The tool ranks clusters for follow-up &mdash; it never certifies that
          anything is novel, and it is not validated for clinical, regulatory or biosafety use.
        </>
      }
    >
      <h2>1. What this is</h2>
      <p>
        Phylo-BGC is an academic research tool: an exploration and interpretation layer over public
        reference databases and established analysis tools. It does not detect biosynthetic gene
        clusters itself and does not perform sequence clustering itself &mdash; it displays,
        cross-references and ranks results produced by MIBiG, GTDB, NCBI Taxonomy, antiSMASH and
        BiG-SCAPE. See <Link href="/data-sources">Data sources</Link> for what is included, under which
        licence, and how to cite it.
      </p>
      <p>
        It is maintained by {PROJECT.authors.join(", ")} at{" "}
        <Fact value={PROJECT.affiliation} />. Correspondence:{" "}
        <Fact value={PROJECT.contactEmail} />.
      </p>
      <p>
        There is no registration, no login, no paid tier and no advertising. Nothing is sold here and
        no payment is taken, so there is no billing, subscription, refund or cancellation
        arrangement.
      </p>

      <h2>2. Using it, and citing it</h2>
      <p>
        You may use Phylo-BGC freely for research, teaching and publication, including commercially.
        The source code is released under the {PROJECT.codeLicense} Licence.
      </p>
      <p>
        <strong>If you use it in published work, cite it.</strong> This is the only thing asked in
        return, and it is how an academic tool stays fundable and maintained. The citation, and the
        citations for the underlying databases you are also relying on, are on the{" "}
        <Link href="/data-sources">Data sources</Link> page. Every figure exported from the explorer
        embeds a machine-readable record of the exact source versions it was drawn from, so an exported
        SVG or PDF carries its own provenance.
      </p>
      <p>
        Note that the reference data carries its own licence terms, which bind you independently of
        this one &mdash; GTDB in particular is CC BY-SA 4.0, a ShareAlike licence that places
        conditions on redistributing taxonomy-derived output.
      </p>

      <h2>3. What the output claims, and what it does not</h2>
      <p>
        This section describes how the software is actually built, and it is deliberately specific
        because misreading it is the way this tool could contribute to a wrong result.
      </p>
      <ul>
        <li>
          The prioritisation score is an <strong>ordinal ranking aid</strong> computed over the data
          currently in this database. It is <strong>not a novelty claim</strong>, not a measure of
          biological activity, and not a prediction that any cluster produces anything.
        </li>
        <li>
          The scoring weights are <strong>uncalibrated by design</strong> and uniform. They encode no
          judgement about which signals matter more; that judgement is the researcher&rsquo;s.
        </li>
        <li>
          Every result is <strong>relative to the ingested corpus</strong>. &ldquo;Rare&rdquo; means
          rare in this database, not rare in nature.
        </li>
        <li>
          An absent cluster is evidence of absence <strong>only where a detection run has been
          recorded over that genome</strong>. The interface states the examined/unexamined split in the
          stats bar; read it before drawing any conclusion from an empty branch.
        </li>
        <li>
          Taxonomic placements carry an explicit confidence and a caveat. Some rest on a free-text
          organism-name match and are graded weak for exactly that reason.
        </li>
      </ul>
      <p>
        <strong>
          Provided for research and educational use. Not a medical device, not a diagnostic tool, and
          not validated for clinical, regulatory, forensic, biosafety or commercial decision-making.
        </strong>
      </p>

      <h2>4. Uploads</h2>
      <p>By uploading a file you confirm that:</p>
      <ul>
        <li>you have the right to upload it and to have it published;</li>
        <li>
          you understand it is added to a <strong>shared, publicly visible corpus</strong> and served
          to other visitors and through the public API;
        </li>
        <li>
          it is not confidential, embargoed, or subject to an agreement that forbids publication;
        </li>
        <li>it contains no personal data and no malicious content.</li>
      </ul>
      <p>
        You keep whatever rights you already hold in the data you upload. You grant a non-exclusive,
        worldwide, royalty-free licence to store, process and display it for the purpose of running
        this service; that licence ends when the data is deleted.
      </p>
      <p>
        Uploaded data is stored on an ephemeral filesystem and is routinely lost on restart, redeploy
        or idle shutdown. <strong>This is not a data store. There is no backup and no recovery.</strong>{" "}
        Keep your own copy. Any uploaded content may be removed at any time, without notice.
      </p>

      <h2>5. Acceptable use</h2>
      <p>Please do not:</p>
      <ul>
        <li>send automated traffic at a volume that degrades the service for other researchers, or attempt to circumvent the rate limits;</li>
        <li>attempt to gain unauthorised access to the service, its API or its hosting;</li>
        <li>upload malware, or content designed to exploit a parser;</li>
        <li>
          <strong>misrepresent the output</strong> &mdash; in particular, present a prioritisation
          score as a determination of novelty (see section 3).
        </li>
      </ul>

      <h2>6. No warranty</h2>
      <p>
        The service and all data served through it are provided{" "}
        <strong>&ldquo;as is&rdquo; and &ldquo;as available&rdquo;</strong>, without warranty of any
        kind, express or implied, including any implied warranty of merchantability, fitness for a
        particular purpose, accuracy or non-infringement. The reference data may be incomplete or out
        of date, and the placements carry stated uncertainty. To the fullest extent permitted by law,
        the maintainers are not liable for any loss arising from use of the service or from research
        decisions taken in reliance on it.
      </p>
      <p>
        This is the standard disclaimer that accompanies the {PROJECT.codeLicense} Licence the code is
        released under, applied to the hosted instance as well as to the source. Nothing here excludes
        liability that cannot lawfully be excluded.
      </p>

      <h2>7. Availability</h2>
      <p>
        Offered on a best-effort basis with no uptime commitment, as academic tools generally are. It
        runs on free-tier hosting that idles out when unused, so a first request after a quiet period
        may take up to a minute. It may change or be withdrawn at any time &mdash; which is precisely
        why the archived release named on the{" "}
        <Link href="/data-sources">Data sources</Link> page, not this URL, is what a paper should cite.
      </p>

      <h2>8. Changes</h2>
      <p>
        If these terms change, the &ldquo;last updated&rdquo; date at the top changes with them.
      </p>
    </LegalPage>
  );
}
