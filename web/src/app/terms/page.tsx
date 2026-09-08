import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage, Placeholder } from "@/components/LegalPage";

export const metadata: Metadata = {
  title: "Terms & Conditions",
  description:
    "The terms on which Phylo-BGC is provided: a free, no-account research tool with public uploads, no warranty, and scientific output that is not a novelty claim.",
  alternates: { canonical: "/terms" },
};

export default function Terms() {
  return (
    <LegalPage
      title="Terms &amp; Conditions"
      updated="2026-09-08"
      summary={
        <>
          <strong>In short:</strong> Phylo-BGC is a free research tool provided as-is, with no
          account and no payment. Anything you upload becomes public and may be deleted at any
          time. The tool ranks clusters for follow-up; it never certifies that anything is novel.
          Do not rely on it for regulatory, clinical, safety or commercial decisions.
        </>
      }
    >
      <h2>1. Who provides this service</h2>
      <p>
        Phylo-BGC is provided by <Placeholder>legal entity name</Placeholder>, of{" "}
        <Placeholder>registered business address</Placeholder>, contactable at{" "}
        <Placeholder>contact email address</Placeholder>
        <Placeholder>
          add company/charity/institution registration number and, if registered for it, VAT or GST
          number
        </Placeholder>
        . By using the service you agree to these terms. If you do not agree, do not use it.
      </p>

      <h2>2. What the service is</h2>
      <p>
        Phylo-BGC is an exploration and interpretation layer over established public reference
        databases and analysis tools. It does not predict biosynthetic gene clusters itself and it
        does not perform sequence clustering itself; it displays, cross-references and ranks results
        that came from MIBiG, GTDB, NCBI Taxonomy, antiSMASH and BiG-SCAPE. See{" "}
        <Link href="/data-sources">Data sources</Link> for what is included and under which licence.
      </p>

      <h2>3. No account, no charge</h2>
      <p>
        The service has no registration, no login and no paid tier. Nothing is sold through this
        site, no payment is taken and no subscription is offered, so there is no billing, refund or
        cancellation arrangement. If that ever changes, these terms will change first.
      </p>

      <h2>4. Uploads</h2>
      <p>By uploading a file you confirm that:</p>
      <ul>
        <li>you have the right to upload it and to have it published;</li>
        <li>
          you understand it will be added to a <strong>shared, publicly visible corpus</strong> and
          served to other visitors and through the public API;
        </li>
        <li>
          it is not confidential, embargoed, unpublished-and-restricted, or subject to an agreement
          that forbids publication;
        </li>
        <li>
          it contains no personal data, and no malicious, unlawful or infringing content.
        </li>
      </ul>
      <p>
        You keep whatever rights you already hold in the data you upload. You grant the operator a
        non-exclusive, worldwide, royalty-free licence to store, process, display and serve it for
        the purpose of running this service. That licence ends when the data is deleted.
      </p>
      <p>
        Uploaded data is stored on an ephemeral filesystem and is routinely lost on restart,
        redeploy or idle shutdown. <strong>The service is not a data store and offers no backup,
        retention or recovery of any kind.</strong> Keep your own copy.
      </p>
      <p>
        We may remove any uploaded content at any time, for any reason, without notice &mdash;
        including content that is unlawful, infringing, abusive, or simply that we cannot verify.
      </p>

      <h2>5. Acceptable use</h2>
      <p>You must not:</p>
      <ul>
        <li>
          attempt to gain unauthorised access to the service, its API, its database or its hosting;
        </li>
        <li>
          send automated traffic at a volume that degrades the service for others, or attempt to
          circumvent rate limits or upload limits;
        </li>
        <li>upload malware, or content designed to exploit a parser or a viewer;</li>
        <li>use the service to store or distribute unlawful material;</li>
        <li>
          misrepresent the output of the service &mdash; in particular, present a prioritisation
          score as a determination of novelty (see section 6).
        </li>
      </ul>

      <h2>6. Scientific output: what it does and does not assert</h2>
      <p>
        This section is a description of how the software is built, and it is deliberately specific.
      </p>
      <ul>
        <li>
          The prioritisation score is an <strong>ordinal ranking aid</strong> computed over the data
          currently in this database. It is <strong>not a novelty claim</strong>, not a measure of
          biological activity, and not a prediction that any cluster produces anything.
        </li>
        <li>
          The scoring weights are <strong>uncalibrated by design</strong> and uniform. They encode
          no judgement about which signals matter more.
        </li>
        <li>
          Every result is <strong>relative to the ingested corpus</strong>. &ldquo;Rare&rdquo; means
          rare in this database, not rare in nature.
        </li>
        <li>
          An absent cluster is only evidence of absence where a detection run has been recorded over
          that genome. The interface states the examined/unexamined split; read it before drawing a
          conclusion from an empty branch.
        </li>
        <li>
          Taxonomic placements carry an explicit confidence and a caveat. Some are based on a
          free-text organism-name match and are graded weak for that reason.
        </li>
      </ul>
      <p>
        <strong>
          The service is provided for research and educational use. It is not a medical device, not
          a diagnostic tool, and not validated for clinical, regulatory, forensic, biosafety or
          commercial decision-making. Do not use it as the basis for any such decision.
        </strong>
      </p>

      <h2>7. Third-party data and licences</h2>
      <p>
        The corpus is derived from third-party databases with their own licences and attribution
        requirements &mdash; notably GTDB, which is CC BY-SA 4.0 and therefore imposes conditions on
        redistribution of taxonomy-derived output. Those terms bind you as well as us when you
        reuse anything you take from this site. The per-source detail is on the{" "}
        <Link href="/data-sources">Data sources</Link> page, and every figure you export carries its
        own provenance record.
      </p>

      <h2>8. Availability</h2>
      <p>
        The service is offered on a best-effort basis with no uptime commitment. It runs on
        free-tier hosting that idles out when unused, so a first request after a quiet period may
        take up to a minute. We may change, suspend or discontinue it at any time.
      </p>

      <h2>9. Disclaimer of warranties</h2>
      <p>
        To the fullest extent permitted by law, the service and all data served through it are
        provided <strong>&ldquo;as is&rdquo; and &ldquo;as available&rdquo;</strong>, without
        warranty of any kind, express or implied, including any implied warranty of
        merchantability, fitness for a particular purpose, accuracy, or non-infringement. We do not
        warrant that the data is correct, current or complete.
      </p>

      <h2>10. Limitation of liability</h2>
      <p>
        To the fullest extent permitted by law, the operator is not liable for any indirect,
        incidental, special or consequential loss, nor for loss of data, loss of profit, or loss
        arising from research decisions taken in reliance on the service.
      </p>
      <p>
        Nothing in these terms excludes or limits liability that cannot lawfully be excluded or
        limited &mdash; which in many jurisdictions includes liability for death or personal injury
        caused by negligence, and for fraud.{" "}
        <Placeholder>
          this clause and section 9 must be reviewed by a qualified lawyer; enforceable limits
          differ substantially by jurisdiction and consumer-law regime
        </Placeholder>
      </p>

      <h2>11. Software licence</h2>
      <p>
        The Phylo-BGC source code is published under the MIT Licence, which governs the code only
        and says nothing about the licence terms of the ingested datasets. Those are tracked
        per-source on the <Link href="/data-sources">Data sources</Link> page.
      </p>

      <h2>12. Governing law</h2>
      <p>
        These terms are governed by the laws of{" "}
        <Placeholder>governing jurisdiction</Placeholder>, and the courts of{" "}
        <Placeholder>jurisdiction for disputes</Placeholder> have exclusive jurisdiction over any
        dispute.{" "}
        <Placeholder>
          confirm with a qualified lawyer &mdash; a choice-of-law clause does not always displace
          the mandatory consumer or data-protection rules of a visitor&rsquo;s own country
        </Placeholder>
      </p>

      <h2>13. Changes</h2>
      <p>
        We may update these terms. The &ldquo;last updated&rdquo; date at the top changes when we
        do, and continuing to use the service after that date means you accept the revised terms.
      </p>
    </LegalPage>
  );
}
