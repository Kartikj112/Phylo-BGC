import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Page not found",
  // A 404 that gets indexed is a 404 that competes with the real pages.
  robots: { index: false, follow: true },
};

/**
 * The custom 404.
 *
 * It offers routes rather than apologising: the explorer is one page and the
 * policies are four, so a complete list of everywhere a reader could have
 * meant to go fits on the screen. That is a better recovery than a search box
 * over five documents.
 *
 * One case is worth naming explicitly — a deep link into the tree carries its
 * target in the query string (`/?taxon=…`), so a bookmark that lost its query
 * lands on the explorer rather than here. Anyone reaching this page has a
 * genuinely unknown path.
 */
export default function NotFound() {
  return (
    <div className="flex min-h-full flex-col bg-paper text-ink">
      <header className="border-b border-chrome-line bg-chrome">
        <div className="mx-auto flex max-w-3xl items-center px-5 py-3 sm:px-8">
          <Link
            href="/"
            className="flex items-center rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-chrome-accent focus-visible:ring-offset-2 focus-visible:ring-offset-chrome hover:opacity-80"
          >
            <img
              src="/logo.png"
              alt="Phylo-BGC — return to the explorer"
              width={710}
              height={218}
              className="h-[22px] w-auto"
            />
          </Link>
        </div>
      </header>

      <main id="main" className="mx-auto w-full max-w-3xl flex-1 px-5 py-16 sm:px-8 sm:py-24">
        <p className="font-mono text-xs uppercase tracking-widest text-signal">Error 404</p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
          There is no page at this address
        </h1>
        <p className="mt-4 max-w-prose text-sm leading-relaxed text-ink-muted">
          The link may be mistyped or out of date. Everything on this site is one of the five pages
          below.
        </p>

        <nav aria-label="All pages" className="mt-10">
          <ul className="divide-y divide-line border-y border-line">
            {[
              {
                href: "/",
                title: "The explorer",
                blurb: "The taxonomy tree with its biosynthetic gene cluster overlay.",
              },
              {
                href: "/data-sources",
                title: "Data sources & attribution",
                blurb: "Which databases the corpus comes from, and under which licences.",
              },
              { href: "/privacy", title: "Privacy Policy", blurb: "What is collected, and what is not." },
              { href: "/terms", title: "Terms & Conditions", blurb: "The terms the service is provided on." },
              { href: "/cookies", title: "Cookie Policy", blurb: "There are none. This page says so precisely." },
            ].map((page) => (
              <li key={page.href}>
                <Link
                  href={page.href}
                  className="group flex flex-col gap-0.5 py-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-signal"
                >
                  <span className="text-sm font-semibold text-ink group-hover:text-signal group-hover:underline underline-offset-2">
                    {page.title}
                  </span>
                  <span className="text-xs text-ink-muted">{page.blurb}</span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </main>
    </div>
  );
}
