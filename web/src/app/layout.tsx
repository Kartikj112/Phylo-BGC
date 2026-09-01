import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import type { ReactNode } from "react";
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

export const metadata: Metadata = {
  title: "Phylo-BGC",
  description: "Interactive exploration of biosynthetic diversity across the tree of life.",
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
      <body className="font-sans bg-paper text-ink antialiased">{children}</body>
    </html>
  );
}
