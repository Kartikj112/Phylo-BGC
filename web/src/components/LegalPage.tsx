import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Shared chrome for the policy documents.
 *
 * These pages are ordinary prose routes hung off the same design tokens as
 * the instrument itself — dark chrome bar, paper stage, IBM Plex — rather
 * than a separate template. The app owns the whole viewport and navigates by
 * pan/zoom, so the policies could not simply be appended to it as a footer;
 * they are real routes, which is also what makes them linkable, crawlable
 * and printable.
 */
export function LegalPage({
  title,
  updated,
  summary,
  children,
}: {
  title: string;
  /** ISO date the document text last changed. Rendered as-is: a policy with
   * no date gives a reader no way to tell whether it covers the version of
   * the service they are looking at. */
  updated: string;
  summary?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="min-h-full bg-paper text-ink">
      <header className="border-b border-chrome-line bg-chrome">
        <div className="mx-auto flex max-w-3xl items-center gap-4 px-5 py-3 sm:px-8">
          <Link
            href="/"
            className="flex flex-shrink-0 items-center rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-chrome-accent focus-visible:ring-offset-2 focus-visible:ring-offset-chrome hover:opacity-80"
          >
            {/* Same fixed asset and intrinsic size as the app header. */}
            <img src="/logo.png" alt="Phylo-BGC — return to the explorer" width={710} height={218} className="h-[22px] w-auto" />
          </Link>
          <nav aria-label="Policies" className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
            <Link className="text-chrome-ink-muted underline-offset-2 hover:text-chrome-ink hover:underline" href="/privacy">
              Privacy
            </Link>
            <Link className="text-chrome-ink-muted underline-offset-2 hover:text-chrome-ink hover:underline" href="/terms">
              Terms
            </Link>
            <Link className="text-chrome-ink-muted underline-offset-2 hover:text-chrome-ink hover:underline" href="/cookies">
              Cookies
            </Link>
            <Link className="text-chrome-ink-muted underline-offset-2 hover:text-chrome-ink hover:underline" href="/data-sources">
              Data sources
            </Link>
          </nav>
        </div>
      </header>

      <main id="main" className="mx-auto max-w-3xl px-5 py-10 sm:px-8 sm:py-14">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
        <p className="mt-2 font-mono text-xs text-ink-muted">Last updated: {updated}</p>
        {summary && <div className="mt-6 rounded border border-line bg-card p-4 text-sm leading-relaxed">{summary}</div>}
        <div className="legal-prose mt-8">{children}</div>

        <hr className="mt-12 border-line" />
        <p className="mt-6 text-xs leading-relaxed text-ink-muted">
          Phylo-BGC is a research tool. This document describes how the software in this
          repository actually behaves; it is not legal advice, and it has not been reviewed by a
          qualified lawyer.{" "}
          <Link className="text-signal underline underline-offset-2" href="/">
            Return to the explorer
          </Link>
          .
        </p>
      </main>
    </div>
  );
}

/**
 * A fact this repository cannot supply, marked so it is impossible to ship by
 * accident.
 *
 * Business identity, a contact address and a governing jurisdiction are the
 * three things a policy page cannot be written without and that no amount of
 * reading the code will reveal. Inventing them would produce a document that
 * looks compliant and names the wrong legal person — worse than an obvious
 * gap, because nobody would go looking for it. This renders in the accent
 * colour with a `TODO` marker for the same reason.
 */
export function Placeholder({ children }: { children: ReactNode }) {
  return (
    <mark
      className="rounded bg-signal-wash px-1.5 py-0.5 font-mono text-[0.85em] font-semibold text-signal"
      data-placeholder
    >
      [TODO: {children}]
    </mark>
  );
}
