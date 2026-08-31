import type { Config } from "tailwindcss";

// Design tokens from this project's design plan (PROGRESS.md Chunk 3 /
// ARCHITECTURE.md "Phase 2" section): calm, precise scientific instrument,
// following the original brief's explicit "Nature/Cell data graphics, not
// a flashy SaaS dashboard" instruction. Ported from the verified design
// prototype (web/design-prototype/tree-explorer-demo.jsx) rather than
// redesigned from scratch.
const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        paper: "#F7F7F4",
        card: "#FFFFFF",
        ink: "#1C1E1B",
        "ink-muted": "#5B5F58",
        "ink-faint": "#9A9D95",
        line: "#DEDFDA",
        "line-strong": "#C4C6BF",
        // Oxblood. The interface accent on the light stage — 9.48:1 on
        // `paper`, comfortably past the 6.83:1 the previous green carried.
        //
        // Deliberately NOT reused for the tree's family-presence highlight:
        // that is `present` below, which stays green because it encodes
        // data and has to stay clear of `alkaloid` (#8B4560) in the
        // BGC-class palette. Oxblood beside alkaloid would make "carries
        // the selected family" and "is an alkaloid cluster" the same mark.
        signal: "#7B1E2B",
        "signal-wash": "#F4E7E9",
        // ---- Chrome (top bar + left filter rail) -------------------------
        // The chrome is deliberately near-black so the instrument's
        // controls sit clearly BEHIND the data instead of competing with
        // it, and every colour the tree uses (the BGC-class palette, the
        // search yellow, the clade washes) still lands on the untouched
        // `paper` stage exactly as designed.
        //
        // A dark grey carrying a faint red bias, so it reads as one family
        // with the oxblood rather than as a neutral with red bolted on.
        chrome: "#191416",
        "chrome-soft": "#241D20",
        "chrome-line": "#3A2F33",
        "chrome-line-strong": "#574A4E",
        "chrome-ink": "#F2EDEE",
        "chrome-ink-muted": "#B4A8AB",
        "chrome-ink-faint": "#93858A",
        // Oxblood itself is far too dark to read on `chrome` — 1.79:1, well
        // below anything legible. This is the same hue lifted until it
        // carries 8.21:1 against the ground, matching what the previous
        // mint did for the green it replaced.
        "chrome-accent": "#EE95A3",
        // The oxblood proper, used as the ground BEHIND an active control
        // rather than as its text. The lifted accent reads 6.63:1 on it.
        "chrome-accent-wash": "#4A1620",
      },
      fontFamily: {
        sans: ["var(--font-plex-sans)", "system-ui", "sans-serif"],
        mono: ["var(--font-plex-mono)", "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
