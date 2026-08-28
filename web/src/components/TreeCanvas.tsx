"use client";

import * as d3 from "d3";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DisplayNode, TaxonDisplayNode } from "@/lib/api-types";
import { BGC_CLASS_COLORS, BGC_CLASS_LABELS, CLADE_REGION_OPACITY, COLORS, cladeHue, classColor } from "@/lib/colors";
import {
  bgcInFamily,
  bgcMatchesQuery,
  bgcSizeTier,
  branchWidth,
  cladeSummary,
  computeRadialTreeLayout,
  computeTreeLayout,
  dominantBgcClass,
  effectiveCollapsed,
  genomeMatchesActiveClasses,
  glyphWidth,
  hasRoomForLabel,
  hiddenChildrenCount,
  isAnchorRank,
  isLeftHalf,
  matchesQuery,
  nodeHasFamily,
  nodeKey,
  nodeMatchesOrContains,
  nodeVisibleClasses,
  rankAbbreviation,
  subtreeBgcCount,
  type FamilyMembershipSets,
  type TreeOrientation,
} from "@/lib/tree-logic";

interface TreeCanvasProps {
  root: TaxonDisplayNode;
  collapsed: Set<string>;
  onToggleCollapse: (key: string) => void;
  activeClasses: Set<string>;
  searchQuery: string;
  selectedId: string | null;
  selectedFamilyId: string | null;
  comparisonTaxonIds: string[];
  onToggleComparisonTaxon: (taxonId: string) => void;
  onSelectGenome: (id: string) => void;
  onSelectBgc: (id: string) => void;
  onFocusNode: (key: string) => void;
  svgRef?: React.Ref<SVGSVGElement>;
  orientation: TreeOrientation;
  /** Precomputed family membership over the FULL tree (see tree-logic's
   * familyMembershipSets). When present it replaces the per-node
   * nodeHasFamily() recursion and drives the distribution highlight. */
  familyMembership?: FamilyMembershipSets | null;
  /** nodeKey() of the tightest clade(s) wrapping the selected family — get
   * a ring so "the smallest clade that contains this" reads at a glance. */
  familyEnclosingKeys?: ReadonlySet<string>;
  familyLabel?: string | null;
  /** Bump to ask the canvas to recentre (family select, frame toggle …). */
  fitSignal?: number;
  /** Purely visual per-node nudges from dragging, keyed by nodeKey(). Never
   * consulted by anything that computes a statistic — see onNodeDrag. */
  nodeOffsets?: ReadonlyMap<string, { dx: number; dy: number }>;
  onNodeDrag?: (key: string, dx: number, dy: number) => void;
  /** Draw the subtle taxonomic-nesting regions behind the tree. */
  showRegions?: boolean;
  /** Put cluster glyphs on one aligned track instead of hanging them off
   * each node. Off restores the original spaced barcode. */
  alignedGlyphs?: boolean;
}

/** A node's drawn position, after any manual drag.
 *
 * Returned in the layout's own coordinates so links and glyphs agree: for
 * the horizontal tree that is (x = cross axis, y = depth axis); for the
 * radial tree it is (x = angle in radians, y = radius). A drag arrives in
 * screen-space pixels, so the radial case converts to cartesian, applies the
 * nudge, and converts back — otherwise a dragged node's glyph and its
 * incoming branch would come apart.
 *
 * Topology is untouched: this only moves where a node is drawn. */
function drawnPos(
  n: d3.HierarchyPointNode<DisplayNode>,
  isRadial: boolean,
  offsets: ReadonlyMap<string, { dx: number; dy: number }> | undefined,
): { x: number; y: number } {
  const off = offsets?.get(nodeKey(n.data));
  if (!off) return { x: n.x, y: n.y };
  if (!isRadial) return { x: n.x + off.dy, y: n.y + off.dx };

  const a = n.x - Math.PI / 2;
  const cx = n.y * Math.cos(a) + off.dx;
  const cy = n.y * Math.sin(a) + off.dy;
  const radius = Math.hypot(cx, cy);
  return { x: Math.atan2(cy, cx) + Math.PI / 2, y: radius };
}

const TREE_WIDTH = 760;
/** Breathing room around a hierarchy region so it reads as enclosing the
 * clade rather than clipping it. */
const REGION_PAD = 10;
const REGION_ANGLE_PAD = 0.006;
/** Floor on the zoom fade, so regions never vanish entirely. */
const REGION_MIN_FADE = 0.18;
/** Search-hit highlight. Deliberately the brightest thing on the canvas —
 * it marks the one cluster the reader asked for, and has to win against
 * the BGC-class palette underneath it. */
const SEARCH_HIT_FILL = "#FFE94A";
const SEARCH_HIT_STROKE = "#B8930B";
/** Room left around the framed matches, and the ceiling on how far a search
 * may zoom in — a lone hit should still be shown in context. */
const SEARCH_FIT_PADDING = 180;
const SEARCH_ZOOM_MAX = 1.6;
const H_MARGIN_LEFT = 210;
const H_MARGIN_RIGHT = 300;
const PRESENCE_GUTTER = 150;
/** Gap between the deepest tip and the aligned glyph track. Enough that a
 * long taxon label clears the branch tips before the track begins. */
const GLYPH_TRACK_GUTTER = 26;
/** Per-cluster segment width in the aligned bar, and the cap beyond which
 * segments compress rather than the bar growing without bound (one genome in
 * the bundled corpus carries 53 clusters; unbounded, that is a 583px run
 * that sweeps through its neighbours). */
const GLYPH_SEGMENT_WIDTH = 7;
const GLYPH_MAX_WIDTH = 120;

/** Log-scale step below which a zoom change cannot alter label visibility.
 * ~1.5% — far finer than the spacing at which `hasRoomForLabel` flips, so
 * semantic zoom is unchanged while a continuous wheel gesture renders a
 * handful of times instead of once per event. */
const SCALE_RENDER_QUANTUM = 0.015;

export function TreeCanvas({
  root,
  collapsed,
  onToggleCollapse,
  activeClasses,
  searchQuery,
  selectedId,
  selectedFamilyId,
  comparisonTaxonIds,
  onToggleComparisonTaxon,
  onSelectGenome,
  onSelectBgc,
  onFocusNode,
  svgRef,
  orientation,
  familyMembership,
  familyEnclosingKeys,
  familyLabel,
  fitSignal,
  nodeOffsets,
  onNodeDrag,
  showRegions = true,
  alignedGlyphs = true,
}: TreeCanvasProps) {
  // Searching forces open the path to every match — a hit inside a
  // collapsed clade would otherwise never render, which made search look
  // broken rather than filtered.
  const openCollapsed = useMemo(
    () => effectiveCollapsed(root, collapsed, searchQuery),
    [root, collapsed, searchQuery],
  );
  const containerRef = useRef<HTMLDivElement | null>(null);
  const zoomLayerRef = useRef<SVGGElement | null>(null);
  const localSvgRef = useRef<SVGSVGElement | null>(null);
  const zoomBehaviorRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  // The live pan/zoom transform is written straight to the DOM (see the
  // zoom handler below), NOT held in React state. Keeping x/y in state meant
  // every mouse-move during a pan re-rendered the whole canvas — 3,528 nodes
  // reconciled to change one attribute on one <g>. The ref holds the current
  // transform for anything that needs to read it imperatively.
  const transformRef = useRef({ k: 1, x: 0, y: 0 });

  // Scale DOES need to be reactive: label visibility is semantic-zoom
  // dependent (hasRoomForLabel). It is quantised so that panning — which
  // never changes k — triggers no render at all, and a continuous wheel
  // zoom triggers one render per perceptible step rather than one per event.
  const [scale, setScale] = useState(1);
  const [vb, setVb] = useState({ w: 1000, h: 700 });

  // Width comes from the viewport, not a constant, so the hierarchy spreads
  // across the screen it is actually given. TREE_WIDTH is the floor for a
  // narrow window rather than the target.
  const horizontal = useMemo(
    () =>
      computeTreeLayout(
        root,
        openCollapsed,
        Math.max(TREE_WIDTH, vb.w - H_MARGIN_LEFT - H_MARGIN_RIGHT),
        vb.h,
      ),
    [root, openCollapsed, vb.w, vb.h],
  );
  const radial = useMemo(() => computeRadialTreeLayout(root, openCollapsed), [root, openCollapsed]);
  const isRadial = orientation === "radial";
  const nodes = isRadial ? radial.nodes : horizontal.nodes;
  const links = isRadial ? radial.links : horizontal.links;


  // Keep the viewBox locked to the container's pixel size so 1 viewBox unit
  // == 1 CSS pixel — the tree is the stage, it fills the space it is given
  // and is navigated by zoom/pan rather than a scrollbar.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth || 1000;
      const h = el.clientHeight || 700;
      setVb((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Current layout, read by fitView so it always frames what's on screen
  // without re-running on every collapse toggle.
  const layoutRef = useRef<{ hNodes: typeof horizontal.nodes; rSize: number }>({
    hNodes: [],
    rSize: 0,
  });
  layoutRef.current = { hNodes: horizontal.nodes, rSize: radial.size };
  const vbRef = useRef(vb);
  vbRef.current = vb;

  const fitView = useCallback(() => {
    const svgEl = localSvgRef.current;
    const behavior = zoomBehaviorRef.current;
    const el = containerRef.current;
    if (!svgEl || !behavior || !el) return;
    const cw = el.clientWidth || vbRef.current.w;
    const ch = el.clientHeight || vbRef.current.h;

    let bx: number;
    let by: number;
    let bw: number;
    let bh: number;
    if (isRadial) {
      bx = 0;
      by = 0;
      bw = layoutRef.current.rSize || 600;
      bh = layoutRef.current.rSize || 600;
    } else {
      const ns = layoutRef.current.hNodes;
      if (ns.length === 0) return;
      const xs = ns.map((n) => n.x);
      const ys = ns.map((n) => n.y);
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);
      bx = minY - H_MARGIN_LEFT;
      by = minX - 30;
      bw = maxY - minY + H_MARGIN_LEFT + H_MARGIN_RIGHT;
      bh = maxX - minX + 60;
    }
    const k = Math.max(0.12, Math.min(cw / bw, ch / bh, 1.3));
    const tx = (cw - bw * k) / 2 - bx * k;
    const ty = (ch - bh * k) / 2 - by * k;
    d3.select(svgEl).call(behavior.transform, d3.zoomIdentity.translate(tx, ty).scale(k));
  }, [isRadial]);

  /** Frame an explicit box, in zoom-layer coordinates. */
  const fitToBox = useCallback(
    (bx: number, by: number, bw: number, bh: number, maxZoom: number) => {
      const svgEl = localSvgRef.current;
      const behavior = zoomBehaviorRef.current;
      const el = containerRef.current;
      if (!svgEl || !behavior || !el || bw <= 0 || bh <= 0) return;
      const cw = el.clientWidth || vbRef.current.w;
      const ch = el.clientHeight || vbRef.current.h;
      const k = Math.max(0.12, Math.min(cw / bw, ch / bh, maxZoom));
      const tx = (cw - bw * k) / 2 - bx * k;
      const ty = (ch - bh * k) / 2 - by * k;
      d3.select(svgEl).call(behavior.transform, d3.zoomIdentity.translate(tx, ty).scale(k));
    },
    [],
  );

  /**
   * Zoom to whatever the search found.
   *
   * A hit deep in a large tree is expanded and highlighted but can easily be
   * off-screen, which reads as "no result". Framing the matches turns the
   * search into navigation. Capped at SEARCH_ZOOM_MAX so a single hit does
   * not slam the view to maximum magnification and lose all surrounding
   * context — the point is to show WHERE in the tree it sits.
   */
  const fitToMatches = useCallback(() => {
    if (!searchQuery.trim()) return false;
    const hits = nodes.filter((n) => matchesQuery(n.data, searchQuery));
    if (hits.length === 0) return false;

    const pts = hits.map((n) => {
      const p = drawnPos(n, isRadial, nodeOffsets);
      if (!isRadial) return { x: p.y, y: p.x };
      const a = p.x - Math.PI / 2;
      // Zoom-layer coords: the figure root is translated by size/2 in radial.
      return { x: p.y * Math.cos(a) + radial.size / 2, y: p.y * Math.sin(a) + radial.size / 2 };
    });
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const pad = SEARCH_FIT_PADDING;
    const bx = Math.min(...xs) - pad;
    const by = Math.min(...ys) - pad;
    fitToBox(bx, by, Math.max(...xs) - Math.min(...xs) + pad * 2,
             Math.max(...ys) - Math.min(...ys) + pad * 2, SEARCH_ZOOM_MAX);
    return true;
  }, [searchQuery, nodes, isRadial, nodeOffsets, radial.size, fitToBox]);

  // Re-frame when the query changes. Depends on `nodes` too, because a hit
  // inside a collapsed clade only gets a position once the search has forced
  // that clade open — framing before that would target a node that is not
  // laid out yet.
  useEffect(() => {
    if (!searchQuery.trim()) return;
    const id = requestAnimationFrame(() => {
      fitToMatches();
    });
    return () => cancelAnimationFrame(id);
  }, [searchQuery, fitToMatches]);

  useEffect(() => {
    const svgEl = localSvgRef.current;
    if (!svgEl) return;
    const behavior = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 8])
      .filter((event: any) => {
        if (event.type === "wheel") return true;
        if (event.button === 1) return true; // middle-drag pan
        // Left-drag pans only when it starts on empty canvas, never on a
        // node or label (those are select / compare / focus).
        if (event.type === "mousedown" && event.button === 0) {
          const t = event.target as Element | null;
          return !!t && (t === svgEl || t.getAttribute?.("data-canvas-bg") === "true");
        }
        return false;
      })
      .on("zoom", (event) => {
        const t = event.transform;
        transformRef.current = { k: t.k, x: t.x, y: t.y };
        // Imperative: one attribute write, no reconciliation.
        zoomLayerRef.current?.setAttribute(
          "transform",
          `translate(${t.x},${t.y}) scale(${t.k})`,
        );
        // Re-render only when the scale moves enough to change which labels
        // fit. QUANTUM is well below the threshold at which a label appears
        // or disappears, so semantic zoom behaves as before.
        setScale((prev) =>
          Math.abs(Math.log(t.k / prev)) > SCALE_RENDER_QUANTUM ? t.k : prev,
        );
      });
    zoomBehaviorRef.current = behavior;
    const selection = d3.select(svgEl);
    selection.call(behavior);
    const suppressAutoscroll = (e: MouseEvent) => {
      if (e.button === 1) e.preventDefault();
    };
    svgEl.addEventListener("mousedown", suppressAutoscroll);
    return () => {
      selection.on(".zoom", null);
      svgEl.removeEventListener("mousedown", suppressAutoscroll);
    };
  }, []);

  // Recentre on the changes that reshape what's drawn — orientation, focus
  // (root identity), viewport size, family selection / framing — but NOT on
  // an individual collapse toggle, which would make the view jump.
  useEffect(() => {
    const id = requestAnimationFrame(fitView);
    return () => cancelAnimationFrame(id);
  }, [fitView, root, vb.w, vb.h, selectedFamilyId, fitSignal]);

  // Re-assert the live transform after every render.
  //
  // The zoom layer's `transform` is written imperatively, so React's JSX
  // value for it is a constant. React would therefore not normally clobber
  // it — but relying on that is relying on a diffing detail. Re-applying it
  // in a layout effect makes the invariant explicit and costs one attribute
  // write per render, so a filter change or a family selection can never
  // silently throw away the user's pan and zoom.
  useLayoutEffect(() => {
    const { k, x, y } = transformRef.current;
    zoomLayerRef.current?.setAttribute("transform", `translate(${x},${y}) scale(${k})`);
  });

  const setSvgRef = (el: SVGSVGElement | null) => {
    localSvgRef.current = el;
    if (typeof svgRef === "function") svgRef(el);
    else if (svgRef && typeof svgRef === "object") {
      (svgRef as React.MutableRefObject<SVGSVGElement | null>).current = el;
    }
  };

  /** A link whose endpoints carry any manual drag, so a branch stays glued
   * to the node it belongs to. Shallow copies only — the hierarchy objects
   * themselves are never mutated. */
  const withDrawnEnds = useCallback(
    (link: d3.HierarchyPointLink<DisplayNode>) => {
      if (!nodeOffsets || nodeOffsets.size === 0) return link;
      const s = drawnPos(link.source, isRadial, nodeOffsets);
      const t = drawnPos(link.target, isRadial, nodeOffsets);
      return {
        source: { ...link.source, x: s.x, y: s.y },
        target: { ...link.target, x: t.x, y: t.y },
      } as d3.HierarchyPointLink<DisplayNode>;
    },
    [nodeOffsets, isRadial],
  );

  // Node dragging.
  //
  // Visual only: the handler reports a pixel delta and the parent stores it
  // in a side map keyed by nodeKey(). Nothing here touches `root`, so the
  // hierarchy, every count derived from it, and the exported figure's data
  // are unaffected — a drag can rearrange the picture but cannot restate the
  // biology. `Auto arrange` clears the map.
  //
  // Bound imperatively because the glyphs are React-rendered: d3.drag needs
  // real DOM nodes, and re-binding after each render keeps it attached as
  // the visible set changes. `clickDistance` keeps a click a click, so
  // select / focus / collapse still work.
  useEffect(() => {
    if (!onNodeDrag || !zoomLayerRef.current) return;
    const scaleAt = () => transformRef.current.k || 1;
    const behavior = d3
      .drag<SVGGElement, unknown>()
      .clickDistance(4)
      .on("start", (event) => event.sourceEvent?.stopPropagation())
      .on("drag", function (event) {
        const key = (this as SVGGElement).getAttribute("data-node-key");
        if (!key) return;
        // dx/dy arrive in screen pixels; divide by the zoom scale so a drag
        // moves the node the same distance under the cursor at any zoom.
        onNodeDrag(key, event.dx / scaleAt(), event.dy / scaleAt());
      });
    const selection = d3
      .select(zoomLayerRef.current)
      .selectAll<SVGGElement, unknown>("g[data-node-key]");
    selection.call(behavior);
    selection.style("cursor", "grab");
    return () => {
      selection.on(".drag", null);
    };
  });

  const linkGenerator = useMemo(
    () =>
      d3
        .linkHorizontal<d3.HierarchyPointLink<DisplayNode>, d3.HierarchyPointNode<DisplayNode>>()
        .x((d) => d.y)
        .y((d) => d.x),
    [],
  );

  const radialLinkGenerator = useMemo(
    () =>
      d3
        .linkRadial<d3.HierarchyPointLink<DisplayNode>, d3.HierarchyPointNode<DisplayNode>>()
        .angle((d) => d.x)
        .radius((d) => d.y),
    [],
  );

  const dimAll = activeClasses.size < Object.keys(BGC_CLASS_COLORS).length;
  const familyActive = selectedFamilyId !== null;

  const isFamilyMember = useCallback(
    (node: DisplayNode): boolean => {
      if (!familyActive) return false;
      if (familyMembership) return familyMembership.nodeKeys.has(nodeKey(node));
      return nodeHasFamily(node, selectedFamilyId);
    },
    [familyActive, familyMembership, selectedFamilyId],
  );

  const maxSubtreeCount = useMemo(
    () => Math.max(1, ...nodes.map((n) => subtreeBgcCount(n.data))),
    [nodes],
  );
  const maxGenomeCount = useMemo(
    () => Math.max(1, ...nodes.map((n) => (n.data._kind === "taxon" ? n.data.genome_count : 1))),
    [nodes],
  );

  const hiddenLabelCount = isRadial
    ? nodes.filter(
        (n) =>
          !hasRoomForLabel(
            n.y,
            radial.angularStep,
            scale,
            n.data._kind === "taxon" && isAnchorRank(n.data.rank),
          ),
      ).length
    : 0;

  // Presence track (horizontal only): a fixed column aligned to the tips,
  // so "which genomes carry this family" is one vertical scan rather than a
  // hunt for teal rings.
  const genomeLeaves = useMemo(
    () => (isRadial ? [] : horizontal.nodes.filter((n) => n.data._kind === "genome")),
    [isRadial, horizontal.nodes],
  );

  /**
   * Where the aligned annotation track sits — one shared baseline for every
   * rendered tip, in the layout's depth units (x in horizontal, radius in
   * radial).
   *
   * Glyphs used to hang a fixed 132px off each node, and nodes sit at
   * different depths, so no two rows shared a baseline: comparing what two
   * clades carry meant comparing bars that started in different places. The
   * standard phylogenetics idiom (iTOL, GraPhlAn, anvi'o) puts leaf
   * annotations in an aligned track joined by leader lines, and this project
   * already had the pattern — `trackX` does exactly this for the
   * family-presence column, just in one orientation for one column. This
   * generalises it.
   *
   * Measured over rendered TIPS (a collapsed clade is visually a leaf), not
   * genomes, so the ring stays flush when clades are collapsed.
   */
  const glyphTrackAt = useMemo(() => {
    const tips = nodes.filter((n) => !n.children || n.children.length === 0);
    if (tips.length === 0) return 0;
    return Math.max(...tips.map((n) => n.y)) + GLYPH_TRACK_GUTTER;
  }, [nodes]);
  /**
   * Subtle background regions showing the taxonomic nesting.
   *
   * One region per internal clade, spanning its descendants: an annular
   * wedge in the radial view, a rounded band in the horizontal one. Opacity
   * rises with rank depth (see CLADE_REGION_OPACITY) so a reader can see
   * "these orders sit inside this class" without tracing every branch.
   *
   * Two constraints shaped this. It must never compete with the data — the
   * fills top out around 0.11 alpha and are drawn before links and nodes, so
   * they sit strictly behind every branch, glyph and label. And colour must
   * not imply magnitude: hue is a stable per-clade identity, never a scale,
   * because a background that looked like a heatmap would suggest a quantity
   * that does not exist.
   *
   * Regions narrower than a few pixels are dropped — below that they read as
   * speckle rather than structure.
   */
  const regions = useMemo(() => {
    const out: {
      key: string;
      fill: string;
      opacity: number;
      a0: number; a1: number; r0: number; r1: number;
      x0: number; x1: number; y0: number; y1: number;
    }[] = [];
    for (const n of nodes) {
      if (n.data._kind === "genome" || n.depth === 0) continue;
      const rank = n.data.rank;
      const opacity = rank ? CLADE_REGION_OPACITY[rank] : undefined;
      if (!opacity) continue;
      const leaves = n.leaves();
      if (leaves.length < 2) continue; // a lone leaf is not a region

      const xs = leaves.map((l) => drawnPos(l, isRadial, nodeOffsets).x);
      const ys = leaves.map((l) => drawnPos(l, isRadial, nodeOffsets).y);
      const self = drawnPos(n, isRadial, nodeOffsets);
      const a0 = Math.min(...xs);
      const a1 = Math.max(...xs);
      const rOuter = Math.max(...ys);

      if (isRadial) {
        if ((a1 - a0) * rOuter < 6) continue;
      } else if (Math.max(...xs) - Math.min(...xs) < 6) continue;

      out.push({
        key: nodeKey(n.data),
        fill: cladeHue(n.data.name),
        opacity,
        a0: a0 - REGION_ANGLE_PAD,
        a1: a1 + REGION_ANGLE_PAD,
        r0: Math.max(0, self.y - REGION_PAD),
        r1: rOuter + REGION_PAD,
        x0: a0 - REGION_PAD,
        x1: a1 + REGION_PAD,
        y0: self.y - REGION_PAD,
        y1: rOuter + REGION_PAD,
      });
    }
    // Broad clades first so finer ones layer on top, which is what makes the
    // nesting visible as accumulating density.
    return out.sort((p, q) => p.opacity - q.opacity);
  }, [nodes, isRadial, nodeOffsets]);

  /**
   * Regions recede as you zoom in.
   *
   * Their opacity was tuned at the default framing, but they scale with
   * everything else — zoomed into a single clade a region becomes a slab
   * covering the viewport and washes the tree out. Their job is to show
   * nesting when you can see the whole shape; once you are inside one clade
   * the nesting is no longer the question, so they step back rather than
   * dominate.
   */
  const regionFade = useMemo(
    () => Math.max(REGION_MIN_FADE, Math.min(1, Math.pow(1 / Math.max(scale, 0.001), 0.85))),
    [scale],
  );

  const regionArc = useMemo(
    () => d3.arc<{ a0: number; a1: number; r0: number; r1: number }>()
      .startAngle((d) => d.a0)
      .endAngle((d) => d.a1)
      .innerRadius((d) => d.r0)
      .outerRadius((d) => d.r1)
      .cornerRadius(3),
    [],
  );

  const trackX = useMemo(
    () => (genomeLeaves.length ? Math.max(...genomeLeaves.map((n) => n.y)) + PRESENCE_GUTTER : 0),
    [genomeLeaves],
  );

  return (
    <div ref={containerRef} className="relative h-full w-full">
      <svg
        ref={setSvgRef}
        width="100%"
        height="100%"
        viewBox={`0 0 ${vb.w} ${vb.h}`}
        style={{ display: "block", cursor: "grab" }}
      >
        <rect
          data-canvas-bg="true"
          x={0}
          y={0}
          width={vb.w}
          height={vb.h}
          fill="transparent"
          pointerEvents="all"
        />
        {/* transform is set imperatively by the d3 zoom handler; this only
            seeds the initial value before the first zoom event. */}
        <g ref={zoomLayerRef} transform={`translate(0,0) scale(1)`}>
          <g
            data-figure-root="true"
            transform={isRadial ? `translate(${radial.size / 2},${radial.size / 2})` : "translate(0,0)"}
          >
            {/* Taxonomic hierarchy regions — drawn first so every branch,
                glyph and label sits on top of them. */}
            {showRegions && regions.length > 0 && (
              <g data-hierarchy-regions="true" pointerEvents="none">
                {regions.map((r) =>
                  isRadial ? (
                    <path
                      key={r.key}
                      d={regionArc({ a0: r.a0, a1: r.a1, r0: r.r0, r1: r.r1 }) ?? undefined}
                      fill={r.fill}
                      fillOpacity={r.opacity * regionFade}
                    />
                  ) : (
                    <rect
                      key={r.key}
                      x={r.y0}
                      y={r.x0}
                      width={Math.max(0, r.y1 - r.y0)}
                      height={Math.max(0, r.x1 - r.x0)}
                      rx={6}
                      fill={r.fill}
                      fillOpacity={r.opacity * regionFade}
                    />
                  ),
                )}
              </g>
            )}

            {/* Presence track */}
            {!isRadial && familyActive && familyMembership && genomeLeaves.length > 0 && (
              <g>
                <text
                  x={trackX + 6}
                  y={Math.min(...genomeLeaves.map((n) => n.x)) - 16}
                  fontSize={9}
                  fill={COLORS.inkFaint}
                  className="font-mono"
                >
                  {familyLabel ?? "GCF"} present
                </text>
                {genomeLeaves.map((n) => {
                  const present = familyMembership.genomeKeys.has(nodeKey(n.data));
                  return (
                    <g key={`pt-${nodeKey(n.data)}`} transform={`translate(0,${n.x})`}>
                      <line
                        x1={n.y + 10}
                        y1={0}
                        x2={trackX}
                        y2={0}
                        stroke={present ? COLORS.presentSoft : COLORS.line}
                        strokeWidth={0.75}
                        strokeDasharray="2 3"
                        opacity={present ? 0.7 : 0.3}
                      />
                      {present ? (
                        <rect x={trackX} y={-5} width={10} height={10} rx={2} fill={COLORS.present} />
                      ) : (
                        <rect
                          x={trackX}
                          y={-5}
                          width={10}
                          height={10}
                          rx={2}
                          fill="none"
                          stroke={COLORS.absent}
                          strokeWidth={1.25}
                        />
                      )}
                    </g>
                  );
                })}
              </g>
            )}

            {links.map((link, i) => {
              const target = link.target.data;
              const width = branchWidth(target, maxSubtreeCount);
              const dominant = dominantBgcClass(target);
              const onFamilyPath = familyActive && isFamilyMember(target);
              const stroke = onFamilyPath
                ? COLORS.present
                : dominant
                  ? (BGC_CLASS_COLORS[dominant] ?? COLORS.lineStrong)
                  : COLORS.lineStrong;
              return (
                <path
                  key={i}
                  d={
                    (isRadial
                      ? radialLinkGenerator(withDrawnEnds(link))
                      : linkGenerator(withDrawnEnds(link))) ?? undefined
                  }
                  fill="none"
                  stroke={stroke}
                  strokeWidth={onFamilyPath ? Math.max(width, 2.5) : width}
                  strokeOpacity={onFamilyPath ? 0.85 : dominant ? 0.45 : 0.6}
                  strokeLinecap="round"
                />
              );
            })}

            {nodes.map((n) => {
              const node = n.data;
              const key = nodeKey(node);
              const pos = drawnPos(n, isRadial, nodeOffsets);
              const isGenome = node._kind === "genome";
              const isMatch = matchesQuery(node, searchQuery);
              const hidden = hiddenChildrenCount(node, openCollapsed);

              const dimmed =
                dimAll && !isGenome && ![...nodeVisibleClasses(node)].some((c) => activeClasses.has(c));
              const genomeDimmed = dimAll && isGenome && !genomeMatchesActiveClasses(node, activeClasses);

              const memberHere = isFamilyMember(node);
              const familyDimmed = familyActive && !memberHere;
              const inSelectedFamily = memberHere;
              const isEnclosing = memberHere && !!familyEnclosingKeys?.has(key);

              const searchDimmed =
                searchQuery.trim() !== "" && !nodeMatchesOrContains(node, searchQuery);

              const hardDimmed = dimmed || genomeDimmed || searchDimmed;
              const opacity = hardDimmed ? 0.15 : familyDimmed ? COLORS.recedeOpacity : 1;

              return (
                <g
                  key={key}
                  data-node-key={key}
                  transform={
                    isRadial
                      ? `rotate(${(pos.x * 180) / Math.PI - 90}) translate(${pos.y},0)`
                      : `translate(${pos.y},${pos.x})`
                  }
                  opacity={opacity}
                >
                  {!isGenome && (
                    <TaxonNode
                      node={node}
                      isRadial={isRadial}
                      angle={n.x}
                      showLabel={
                        !isRadial ||
                        hasRoomForLabel(n.y, radial.angularStep, scale, isAnchorRank(node.rank))
                      }
                      hiddenCount={hidden}
                      matched={isMatch}
                      inSelectedFamily={inSelectedFamily}
                      isEnclosing={isEnclosing}
                      inComparison={node.id !== null && comparisonTaxonIds.includes(node.id)}
                      maxGenomeCount={maxGenomeCount}
                      trackOffset={alignedGlyphs ? Math.max(0, glyphTrackAt - pos.y) : 0}
                      onToggleCollapse={() => onToggleCollapse(key)}
                      onFocus={() => onFocusNode(key)}
                      onToggleComparison={() =>
                        node.id !== null && onToggleComparisonTaxon(node.id)
                      }
                    />
                  )}
                  {isGenome && (
                    <GenomeNode
                      node={node}
                      isRadial={isRadial}
                      angle={n.x}
                      showLabel={!isRadial || hasRoomForLabel(n.y, radial.angularStep, scale)}
                      matched={isMatch}
                      searchQuery={searchQuery}
                      aligned={alignedGlyphs}
                      trackOffset={Math.max(0, glyphTrackAt - pos.y)}
                      isEnclosing={isEnclosing}
                      dimmedBySelection={selectedId !== null && selectedId !== node.id}
                      selectedFamilyId={selectedFamilyId}
                      onSelectGenome={() => onSelectGenome(node.id)}
                      onSelectBgc={onSelectBgc}
                    />
                  )}
                </g>
              );
            })}
          </g>
        </g>

        {hiddenLabelCount > 0 && (
          <text x={12} y={20} fontSize={11} fill={COLORS.inkFaint}>
            {hiddenLabelCount} label{hiddenLabelCount === 1 ? "" : "s"} hidden for space · scroll to
            zoom in, drag to pan
          </text>
        )}
      </svg>

      <div className="pointer-events-none absolute right-3 top-3 flex gap-1.5">
        <button
          onClick={fitView}
          className="pointer-events-auto rounded border border-line bg-card px-2 py-1 text-xs text-ink-muted shadow-sm hover:border-line-strong hover:text-ink"
          title="Fit the tree to the screen"
        >
          Recenter
        </button>
      </div>
    </div>
  );
}

function TaxonNode({
  node,
  isRadial,
  angle,
  showLabel,
  hiddenCount,
  matched,
  inSelectedFamily,
  isEnclosing,
  inComparison,
  maxGenomeCount,
  trackOffset,
  onToggleCollapse,
  onToggleComparison,
  onFocus,
}: {
  node: Extract<DisplayNode, { _kind: "taxon" }>;
  isRadial: boolean;
  angle: number;
  showLabel: boolean;
  hiddenCount: number;
  matched: boolean;
  inSelectedFamily: boolean;
  isEnclosing: boolean;
  inComparison: boolean;
  maxGenomeCount: number;
  onToggleCollapse: () => void;
  onToggleComparison: () => void;
  onFocus: () => void;
  trackOffset: number;
}) {
  const isHighRank = node.rank === "domain" || node.rank === "phylum";
  const badge = rankAbbreviation(node.rank);
  const flip = isRadial && isLeftHalf(angle);
  const labelAnchor = isRadial ? (flip ? "end" : "start") : "end";
  const labelX = isRadial ? (flip ? -14 : 14) : -9;
  const labelTransform = flip ? "rotate(180)" : undefined;
  const badgeX = isRadial ? (flip ? 8 : -20) : -node.name.length * 6.6 - 22;
  return (
    <>
      {/* The tightest clade wrapping the selected family gets a ring, so
          "the smallest group that contains this" is visible without reading
          the summary. */}
      {isEnclosing && <circle r={9} fill="none" stroke={COLORS.present} strokeWidth={1.75} />}

      {hiddenCount > 0 ? (
        <CladeGlyph
          node={node}
          maxGenomeCount={maxGenomeCount}
          flip={isRadial && isLeftHalf(angle)}
          trackOffset={trackOffset}
          onToggleCollapse={onToggleCollapse}
        />
      ) : (
        <circle
          r={4.5}
          fill={COLORS.paper}
          stroke={inSelectedFamily ? COLORS.present : COLORS.ink}
          strokeWidth={inSelectedFamily ? 1.75 : 1.25}
          className="cursor-pointer"
          onClick={onToggleCollapse}
        />
      )}

      {matched && !isRadial && (
        <rect
          x={-9 - node.name.length * 6.6 - 4}
          y={-8}
          width={node.name.length * 6.6 + 8}
          height={16}
          fill="#FDF3C7"
          stroke="#E8C84A"
          strokeWidth={0.75}
          rx={2}
        />
      )}

      {badge && showLabel && (
        <g transform={labelTransform}>
          <rect
            x={badgeX}
            y={-6.5}
            width={13}
            height={13}
            rx={2.5}
            fill={COLORS.paper}
            stroke={COLORS.lineStrong}
            strokeWidth={0.75}
          />
          <text
            x={badgeX + 6.5}
            textAnchor="middle"
            dy="0.32em"
            fontSize={8.5}
            fontWeight={600}
            fill={COLORS.inkMuted}
          >
            {badge}
          </text>
        </g>
      )}

      {showLabel && (
        <text
          x={labelX}
          textAnchor={labelAnchor}
          transform={labelTransform}
          dy="0.32em"
          fontStyle={node.rank === "species" ? "italic" : "normal"}
          fontSize={isHighRank ? 13 : 12}
          fontWeight={matched || isHighRank || inSelectedFamily || inComparison ? 600 : 400}
          fill={
            matched
              ? "#8A6D0B"
              : inSelectedFamily || inComparison
                ? COLORS.signal
                : COLORS.ink
          }
          className="cursor-pointer"
          onClick={(e) => {
            if (e.shiftKey) {
              e.stopPropagation();
              onToggleComparison();
            }
          }}
          onDoubleClick={(e) => {
            e.stopPropagation();
            onFocus();
          }}
        >
          {inComparison ? "◆ " : ""}
          {node.name}
          {hiddenCount > 0 ? ` (+${hiddenCount})` : ""}
        </text>
      )}
    </>
  );
}

function CladeGlyph({
  node,
  maxGenomeCount,
  flip,
  trackOffset,
  onToggleCollapse,
}: {
  node: Extract<DisplayNode, { _kind: "taxon" }>;
  maxGenomeCount: number;
  flip: boolean;
  /** Distance out to the shared aligned track. A collapsed clade is visually
   * a tip, so it shares the genomes' baseline — otherwise expanding one
   * clade would shift the whole comparison. 0 keeps the old hang-off-node
   * position. */
  trackOffset: number;
  onToggleCollapse: () => void;
}) {
  const summary = cladeSummary(node);
  const width = glyphWidth(summary.genomeCount, maxGenomeCount);
  const height = 13;
  const start = trackOffset > 0 ? trackOffset : 6;
  const x = flip ? -width - start : start;

  let offset = 0;
  return (
    // The rotate(180) is what makes the negated `x` above come out RADIALLY
    // OUTWARD on the left hemisphere.
    //
    // Without it the negation was uncompensated, so every glyph on the left
    // half grew back towards the centre — measured 31 of 31 inward on the
    // left against 28 of 28 outward on the right. The labels already flip
    // this way (see TaxonNode's labelTransform); the glyph negated its x but
    // never got the matching rotation, which is exactly the pair that has to
    // travel together. Flipping the whole glyph as a unit also keeps its
    // position relative to the badge and label identical on both halves, so
    // no new overlap is introduced.
    <g
      className="cursor-pointer"
      transform={flip ? "rotate(180)" : undefined}
      onClick={onToggleCollapse}
    >
      <title>
        {node.name}: {summary.genomeCount} genome{summary.genomeCount === 1 ? "" : "s"},{" "}
        {summary.bgcCount} BGC{summary.bgcCount === 1 ? "" : "s"}
        {summary.composition.length > 0 &&
          ` — ${summary.composition
            .slice(0, 4)
            .map((c) => `${BGC_CLASS_LABELS[c.bgcClass] ?? c.bgcClass} ${c.count}`)
            .join(", ")}`}
      </title>

      {summary.bgcCount === 0 ? (
        <rect
          x={x}
          y={-height / 2}
          width={width}
          height={height}
          fill="none"
          stroke={COLORS.lineStrong}
          strokeWidth={1}
          rx={2}
        />
      ) : (
        summary.composition.map((segment) => {
          const segWidth = Math.max(1, segment.fraction * width);
          const segX = x + offset;
          offset += segWidth;
          return (
            <rect
              key={segment.bgcClass}
              x={segX}
              y={-height / 2}
              width={segWidth}
              height={height}
              fill={BGC_CLASS_COLORS[segment.bgcClass] ?? COLORS.inkFaint}
            />
          );
        })
      )}

      <rect
        x={x}
        y={-height / 2}
        width={width}
        height={height}
        fill="none"
        stroke={COLORS.ink}
        strokeWidth={0.75}
        rx={2}
      />
      <text
        x={flip ? x - 4 : x + width + 4}
        dy="0.32em"
        textAnchor={flip ? "end" : "start"}
        fontSize={9}
        fill={COLORS.inkMuted}
        className="font-mono"
        transform={flip ? "rotate(180)" : undefined}
      >
        {summary.genomeCount}g · {summary.bgcCount}b
      </text>
    </g>
  );
}

const BARCODE_START_X = 132;
const BARCODE_TICK_WIDTH = 11;

function GenomeNode({
  node,
  isRadial,
  angle,
  showLabel,
  matched,
  searchQuery,
  isEnclosing,
  dimmedBySelection,
  selectedFamilyId,
  aligned,
  trackOffset,
  onSelectGenome,
  onSelectBgc,
}: {
  node: Extract<DisplayNode, { _kind: "genome" }>;
  isRadial: boolean;
  angle: number;
  showLabel: boolean;
  matched: boolean;
  /** Needed per-cluster: a genome can match on one product while its other
   * clusters do not, and highlighting all of them would misreport the hit. */
  searchQuery: string;
  isEnclosing: boolean;
  dimmedBySelection: boolean;
  selectedFamilyId: string | null;
  /** Draw the clusters as one contiguous bar on the shared aligned track
   * rather than a spaced barcode hanging off this node. */
  aligned: boolean;
  /** Distance from this node out to the aligned track, in layout units. */
  trackOffset: number;
  onSelectGenome: () => void;
  onSelectBgc: (id: string) => void;
}) {
  const flip = isRadial && isLeftHalf(angle);
  const tier = bgcSizeTier(node.bgcs.length);
  // Length still encodes count, but stops growing past the cap: beyond it the
  // segments compress instead, so one very rich genome cannot sweep across
  // its neighbours. Count is redundantly encoded by the node's radius
  // (bgcSizeTier), so nothing is lost when the bar saturates.
  const segWidth = Math.min(
    GLYPH_SEGMENT_WIDTH,
    GLYPH_MAX_WIDTH / Math.max(node.bgcs.length, 1),
  );
  const barEnd = aligned
    ? trackOffset + node.bgcs.length * segWidth
    : (showLabel ? BARCODE_START_X : 12) + node.bgcs.length * BARCODE_TICK_WIDTH;
  const dominant = dominantBgcClass(node);
  const dominantColor = dominant ? (BGC_CLASS_COLORS[dominant] ?? COLORS.inkMuted) : COLORS.inkMuted;
  return (
    <g className="cursor-pointer" onClick={onSelectGenome} opacity={dimmedBySelection ? 0.55 : 1}>
      <g transform={flip ? "rotate(180)" : undefined}>
        {isEnclosing && <circle r={tier.radius + 4} fill="none" stroke={COLORS.present} strokeWidth={1.75} />}
        <circle
          r={tier.radius}
          fill={tier.muted ? COLORS.line : dominantColor}
          stroke={tier.muted ? COLORS.lineStrong : COLORS.ink}
          strokeWidth={tier.muted ? 0.75 : 1}
          opacity={tier.muted ? 0.65 : 1}
        />
        {matched && showLabel && (
          <rect
            x={flip ? -node.accession.length * 6.9 - 14 : 6}
            y={-8}
            width={node.accession.length * 6.9 + 8}
            height={16}
            fill="#FDF3C7"
            stroke="#E8C84A"
            strokeWidth={0.75}
            rx={2}
          />
        )}
        {showLabel && (
          <text
            x={flip ? -(tier.radius + 6) : tier.radius + 6}
            textAnchor={flip ? "end" : "start"}
            dy="0.32em"
            fontSize={11.5}
            fontWeight={matched ? 600 : 400}
            fill={matched ? COLORS.ink : COLORS.inkMuted}
            className="font-mono"
          >
            {node.accession}
          </text>
        )}
      {/* The barcode and MAG tag live INSIDE the flip group, so the whole
          genome node mirrors as one unit on the left hemisphere: everything
          radiates outward and reads the right way up. They used to sit
          outside it, which left the barcode unmirrored relative to its own
          label and put the MAG tag — which had a rotate(180) but a positive
          x, so nothing cancelled — inside the circle. */}
      {/* Leader line joining the tip to its row on the track, so a bar can
          be traced back to the genome it belongs to. */}
      {aligned && trackOffset > tier.radius + 2 && (
        <line
          x1={flip ? -(tier.radius + 2) : tier.radius + 2}
          y1={0}
          x2={flip ? -trackOffset : trackOffset}
          y2={0}
          stroke={COLORS.line}
          strokeWidth={0.75}
          strokeDasharray="2 3"
        />
      )}
      {node.bgcs.map((b, i) => {
        const colors = classColor(b.bgc_class, b.subtype);
        // Aligned mode: a contiguous bar on the shared track. Inline mode
        // keeps the original spaced barcode hanging off the node.
        //
        // Contiguous matters beyond tidiness: a run of SPACED ticks reads as
        // position along a contig, which is what a barcode means in a
        // genomics tool. Tick i is only the i-th row the database returned —
        // the order carries nothing. A solid bar says "this many, of these
        // classes" and implies no coordinate.
        const base = aligned
          ? trackOffset + i * segWidth
          : (showLabel ? BARCODE_START_X : 12) + i * BARCODE_TICK_WIDTH;
        // Mirror into the flipped frame: a rect at [v, v+w] must become
        // [-(v+w), -v] so rotate(180) lands it back outward.
        const bx = (offset: number, w: number) => (flip ? -(base + offset) - w : base + offset);
        const x = base;
        const primary = colors[0] ?? COLORS.inkFaint;
        const inFamily = bgcInFamily(b, selectedFamilyId);
        const isHit = bgcMatchesQuery(b, searchQuery);
        return (
          <g
            key={b.id}
            onClick={(e) => {
              e.stopPropagation();
              onSelectBgc(b.id);
            }}
          >
            {/* A search hit is marked on the CLUSTER itself, not just its
                genome's label: "where is kocurin made" is answered by the
                bar, and a highlight on the row alone would leave the reader
                counting bars to find which one. */}
            {isHit && (
              <rect
                x={bx(-3, segWidth + 6)}
                y={-9}
                width={segWidth + 6}
                height={18}
                fill={SEARCH_HIT_FILL}
                stroke={SEARCH_HIT_STROKE}
                strokeWidth={1.5}
                rx={2.5}
              />
            )}
            {inFamily && (
              <rect
                x={bx(-2, segWidth + 4)}
                y={-7.5}
                width={segWidth + 4}
                height={15}
                fill="none"
                stroke={COLORS.signal}
                strokeWidth={1.5}
                rx={2}
              />
            )}
            {colors.length === 1 ? (
              <rect
                x={bx(0, segWidth)}
                y={-5}
                width={segWidth}
                height={10}
                fill={primary}
                rx={aligned ? 0 : 1}
              />
            ) : (
              <>
                <rect x={bx(0, segWidth / 2)} y={-5} width={segWidth / 2} height={10} fill={primary} />
                <rect
                  x={bx(segWidth / 2, segWidth / 2)}
                  y={-5}
                  width={segWidth / 2}
                  height={10}
                  fill={colors[1] ?? COLORS.inkFaint}
                />
              </>
            )}
          </g>
        );
      })}
      {node.is_mag && showLabel && (
        <text
          x={
            flip ? -(barEnd + 6) : barEnd + 6
          }
          dy="0.32em"
          fontSize={9.5}
          fill={COLORS.inkFaint}
          textAnchor={flip ? "end" : "start"}
        >
          MAG
        </text>
      )}
      </g>
    </g>
  );
}
