import type { Metadata } from "next";
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
  title: "BGC-scape",
  description: "Interactive exploration of biosynthetic diversity across the tree of life.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${plexSans.variable} ${plexMono.variable}`}>
      <body className="font-sans bg-paper text-ink">{children}</body>
    </html>
  );
}
