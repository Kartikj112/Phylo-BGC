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
        signal: "#2C5F52",
        "signal-wash": "#E7EEEC",
        // ---- Chrome (top bar + left filter rail) -------------------------
        // The chrome used to be `card` white on a `paper` off-white stage:
        // a 2% luminance step, so the controls and the figure read as one
        // undifferentiated field and the tree had no frame. These are the
        // same hue family as `signal` taken down to near-black, so the
        // instrument's controls sit clearly BEHIND the data instead of
        // competing with it, and every colour the tree uses (the BGC-class
        // palette, the search yellow, the clade washes) still lands on the
        // untouched `paper` stage exactly as designed.
        chrome: "#1E2A26",
        "chrome-soft": "#2A3833",
        "chrome-line": "#3B4A45",
        "chrome-line-strong": "#56655F",
        "chrome-ink": "#EDF0EE",
        "chrome-ink-muted": "#A6B1AC",
        "chrome-ink-faint": "#8B9691",
        // `signal` itself is far too dark to read on `chrome`; this is the
        // same green lifted to carry 8:1 against it.
        "chrome-accent": "#7CD3B6",
        "chrome-accent-wash": "#2F4F46",
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
