import Link from "next/link";

/**
 * Policy links, at the foot of the controls rail.
 *
 * The explorer owns the whole viewport and navigates by pan/zoom, so there is
 * no page bottom to hang a conventional footer on — and overlaying one on the
 * canvas would put chrome across the figure. The rail already scrolls, is
 * present on every viewport (as a drawer below `lg`), and is where a reader
 * looks for everything that is about the tool rather than about the data.
 *
 * Attribution is not decoration here: GTDB ships under CC BY-SA 4.0, which
 * requires it, so the data-sources link is a licence obligation and is listed
 * first for that reason.
 */
export function SiteFooter() {
  return (
    <footer className="mt-6 border-t border-chrome-line pt-3">
      <nav aria-label="Site information">
        <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
          {[
            { href: "/data-sources", label: "Data sources" },
            { href: "/privacy", label: "Privacy" },
            { href: "/terms", label: "Terms" },
            { href: "/cookies", label: "Cookies" },
          ].map(({ href, label }) => (
            <li key={href}>
              <Link
                href={href}
                className="text-chrome-ink-muted underline-offset-2 hover:text-chrome-ink hover:underline"
              >
                {label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <p className="mt-2 text-[10px] leading-relaxed text-chrome-ink-muted">
        Built on MIBiG, GTDB, NCBI Taxonomy and BiG-SCAPE. GTDB taxonomy is used under{" "}
        <a
          href="https://creativecommons.org/licenses/by-sa/4.0/"
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-2 hover:text-chrome-ink"
        >
          CC BY-SA 4.0
        </a>
        .
      </p>
    </footer>
  );
}
