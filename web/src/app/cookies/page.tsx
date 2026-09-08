import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage, Placeholder } from "@/components/LegalPage";

export const metadata: Metadata = {
  title: "Cookie Policy",
  description:
    "Phylo-BGC sets no cookies and uses no browser storage, analytics or third-party scripts. This page explains what that means and why there is no consent banner.",
  alternates: { canonical: "/cookies" },
};

export default function CookiePolicy() {
  return (
    <LegalPage
      title="Cookie Policy"
      updated="2026-09-08"
      summary={
        <>
          <strong>This site sets no cookies.</strong> It stores nothing in your browser, runs no
          analytics, and loads no third-party scripts, fonts or embeds. That is why you were not
          shown a consent banner: there is nothing to consent to.
        </>
      }
    >
      <h2>1. What we use</h2>
      <p>
        Nothing. As implemented today, the Phylo-BGC application:
      </p>
      <ul>
        <li>sets <strong>no cookies</strong>, first-party or third-party;</li>
        <li>
          writes <strong>nothing</strong> to <code>localStorage</code>, <code>sessionStorage</code>,
          IndexedDB or any other browser storage;
        </li>
        <li>
          contains <strong>no</strong> analytics, product analytics, session recording, heatmap,
          A/B testing or error-reporting script;
        </li>
        <li>
          contains <strong>no</strong> advertising or conversion pixel, tag manager, social sharing
          widget, comment system, chat widget, map, or video embed;
        </li>
        <li>
          loads <strong>no</strong> third-party fonts. The IBM Plex web fonts are served from this
          site&rsquo;s own domain, so rendering a page does not disclose your IP address to a font
          provider.
        </li>
      </ul>
      <p>
        Your view of the tree &mdash; which clades are collapsed, which filters are on, which
        taxonomy you are looking at &mdash; is held in the page&rsquo;s memory for as long as the tab
        is open, and is gone when you close it. It is never written to disk and never sent anywhere.
      </p>

      <h2>2. Why there is no cookie banner</h2>
      <p>
        Consent requirements such as the EU/UK ePrivacy rules apply to storing information on, or
        reading information from, a visitor&rsquo;s device. This application does neither, so there
        is no storage or access for which consent could be required, and no legitimate purpose would
        be served by interrupting you to ask.
      </p>
      <p>
        A banner would also be actively misleading here: presenting a &ldquo;we use cookies&rdquo;
        notice on a site that uses none trains visitors to dismiss notices that do matter elsewhere.
      </p>
      <p>
        <strong>This statement describes the application&rsquo;s own code, which has been checked.</strong>{" "}
        It is not a blanket assertion about the hosting platform. Some hosting and CDN providers can
        set their own cookies &mdash; for load balancing, bot protection, preview toolbars or
        platform analytics &mdash; independently of the application, and some are enabled by a
        setting in a dashboard rather than by anything in the source code.
      </p>
      <p>
        Before launch, confirm on the live domain that no platform cookie is being set, and record
        the result here:{" "}
        <Placeholder>
          confirm hosting/CDN cookie behaviour on the production domain (check DevTools &rarr;
          Application &rarr; Cookies on a fresh profile) and disable any platform analytics or
          preview toolbar that sets one
        </Placeholder>
        .
      </p>

      <h2>3. If that changes</h2>
      <p>
        If cookies or equivalent storage are ever introduced &mdash; including any analytics
        product, or a hosting feature that sets one &mdash; then before that goes live this page
        must be updated to list each cookie, its purpose, its duration and whether it is
        first- or third-party, and a consent mechanism must be added that:
      </p>
      <ul>
        <li>blocks non-essential storage until consent is given, rather than after;</li>
        <li>makes refusing as easy as accepting, in one click, at the same level;</li>
        <li>records the consent and lets it be withdrawn as easily as it was given.</li>
      </ul>
      <p>
        Adding an analytics snippet without doing that would turn a compliant site into a
        non-compliant one in a single commit, which is the specific risk this section exists to
        flag.
      </p>

      <h2>4. Related</h2>
      <p>
        The <Link href="/privacy">Privacy Policy</Link> covers what happens to files you upload and
        to hosting-provider request logs, which are the only places any data about a visit exists.
      </p>
    </LegalPage>
  );
}
