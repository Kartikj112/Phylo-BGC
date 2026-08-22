# Design prototype — not production code

`tree-explorer-demo.jsx` is an interaction/visual-design prototype for the
taxonomy tree + BGC overlay explorer, built to get a real, immediately-
interactive preview in front of the person driving this project before
investing further engineering effort into the production Next.js build —
faster feedback loop than "unzip, npm install, npm run dev" for a design
that might still change.

**It is not part of the production build.** It runs as a single-file
React component (a Claude.ai artifact) with hardcoded sample data shaped
exactly like the real API's response
(`engine/src/bgcscape/api/schemas.py::TaxonTreeNode`), not a real fetch —
so the moment the design direction is confirmed, its D3 layout/rendering
logic can be ported into a real TypeScript component that fetches from
`GET /api/v1/taxonomy-tree` instead of reading `SAMPLE_TREE`.

## What was actually verified before this was presented

Not just written and eyeballed — this sandbox has Node.js, so:

- Transpiled with real Babel (`@babel/preset-react` + `@babel/preset-env`)
  to catch syntax errors.
- Server-side rendered with real `react-dom/server` (`renderToStaticMarkup`)
  against real `react`, `d3`, and `lucide-react@0.383.0` (pinned to match
  the actual artifact environment's available version) to catch runtime
  errors and check the output contains expected content.
- A **real bug was caught and fixed this way**: hybrid (e.g. NRPS+PKS)
  BGCs were counted correctly in the class-filter panel (decomposed into
  their component classes) but the tree's dimming/filtering logic checked
  the literal string `"hybrid"` against the active-filter set — which
  never matches, since `"hybrid"` isn't a real filter option (its
  components are). A genome whose *only* NRPS-related activity came from
  a hybrid BGC would have been incorrectly dimmed out when filtering to
  "NRPS only." Fixed with a shared `bgcComponentClasses()`/
  `bgcMatchesActiveClasses()` helper, used consistently by both the count
  panel and the dimming check. A targeted regression test
  (this chunk's `logic_test.cjs`, not included here since it's throwaway
  verification tooling rather than a deliverable) exercises this
  specifically — `git log` for this chunk has the detail if useful later.
- Sample data was originally missing species-level taxon nodes entirely
  (genomes were attached directly under genus), which meant the
  italic-species-name styling — a real scientific-nomenclature convention,
  not a style flourish — never actually rendered. Caught by the same
  render-test harness checking for the expected `font-style` output, not
  by inspection.

What was **not** verified: actual visual appearance (this environment has
no browser/screenshot capability), real click-driven interaction (the
render test checks static server-side output; it doesn't simulate clicks —
the pure filtering/collapsing logic was unit-tested instead, since that's
where the bug above actually lived).
