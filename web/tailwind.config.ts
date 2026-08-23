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
