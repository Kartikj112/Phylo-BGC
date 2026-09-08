import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import type { ReactNode } from "react";
import { SITE_URL } from "@/lib/site";
import "./globals.css";

// Self-hosted (not next/font/google): this sandbox's build environment
// can't reach fonts.googleapis.com at build time (network allow-list
// covers package registries + GitHub, not arbitrary domains — the same
// class of constraint as MIBiG/GTDB in earlier chunks). IBM Plex is
// genuinely open-source (github.com/IBM/plex, SIL Open Font License —
// see src/fonts/IBM-Plex-LICENSE.txt), so the real font files were
// fetched from there instead and are self-hosted here, which is what
// next/font/google would have produced anyway (it downloads once at
// build time and self-hosts) — same end result, verified to actually
// build in this environment rather than assumed.
const plexSans = localFont({
  src: [
    { path: "../fonts/IBMPlexSans-Regular.woff2", weight: "400", style: "normal" },
    { path: "../fonts/IBMPlexSans-Medium.woff2", weight: "500", style: "normal" },
    { path: "../fonts/IBMPlexSans-SemiBold.woff2", weight: "600", style: "normal" },
  ],
  variable: "--font-plex-sans",
  display: "swap",
});

const plexMono = localFont({
  src: [
    { path: "../fonts/IBMPlexMono-Regular.woff2", weight: "400", style: "normal" },
    { path: "../fonts/IBMPlexMono-Medium.woff2", weight: "500", style: "normal" },
  ],
  variable: "--font-plex-mono",
  display: "swap",
});

/**
 * `metadataBase` is what turns the co-located `opengraph-image.png` into an
 * absolute URL. Without it Next emits a relative `og:image`, which most
 * crawlers and chat clients drop silently — the share preview then falls back
 * to a bare link with no card. See src/lib/site.ts for how the origin resolves.
 */
export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  // `template` gives the policy routes "Privacy Policy · Phylo-BGC" from the
  // one word each of them sets, so no page has to repeat the product name.
  title: {
    default: "Phylo-BGC — biosynthetic gene clusters across the tree of life",
    template: "%s · Phylo-BGC",
  },
  description:
    "Explore biosynthetic gene clusters mapped onto the prokaryote and eukaryote trees of life. Built over MIBiG, GTDB, NCBI Taxonomy, antiSMASH and BiG-SCAPE, with every claim carrying its evidence level.",
  applicationName: "Phylo-BGC",
  keywords: [
    "biosynthetic gene cluster",
    "BGC",
    "natural products",
    "secondary metabolites",
    "MIBiG",
    "GTDB",
    "antiSMASH",
    "BiG-SCAPE",
    "phylogeny",
    "comparative genomics",
  ],
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    siteName: "Phylo-BGC",
    title: "Phylo-BGC — biosynthetic gene clusters across the tree of life",
    description:
      "An exploration layer over MIBiG, GTDB, antiSMASH and BiG-SCAPE: which clades make what, and where nobody has looked yet.",
    url: "/",
    locale: "en",
  },
  twitter: {
    card: "summary_large_image",
    title: "Phylo-BGC — biosynthetic gene clusters across the tree of life",
    description:
      "An exploration layer over MIBiG, GTDB, antiSMASH and BiG-SCAPE: which clades make what, and where nobody has looked yet.",
  },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, "max-image-preview": "large" },
  },
  // Truthful category for a research instrument; keeps app stores and
  // readers-mode heuristics from guessing.
  category: "science",
};

/**
 * Declared explicitly rather than left to the framework default.
 *
 * `viewportFit: "cover"` puts the layout under the notch/home-indicator so
 * the chrome can reach the screen edges; the safe-area insets in page.tsx
 * keep the controls out from under them.
 *
 * `userScalable` is left ON. The tree has its own pinch-zoom, but locking
 * browser zoom would also lock the panels, the tables and every label out
 * of a reader's reach — an accessibility regression for a gain the canvas
 * already provides on its own (the canvas swallows its own gestures via
 * `touch-action: none`, so the two do not fight).
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#191416",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${plexSans.variable} ${plexMono.variable}`}>
      <body className="font-sans bg-paper text-ink antialiased">
        {/* First thing in the tab order on every route. The explorer puts a
            search box and two rails of controls ahead of the canvas, so
            without this a keyboard reader tabs through the entire toolbar
            before reaching the figure. Visually hidden until focused. */}
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[100] focus:rounded focus:bg-chrome focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-chrome-ink focus:outline-none focus:ring-2 focus:ring-chrome-accent"
        >
          Skip to main content
        </a>
        {children}
      </body>
    </html>
  );
}
