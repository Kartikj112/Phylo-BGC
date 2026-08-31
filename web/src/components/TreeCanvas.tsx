"use client";

import * as d3 from "d3";
import { Minus, Plus } from "lucide-react";
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
  estimateLabelWidth,
  nodeKey,
  nodeMatchesOrContains,
  nodeLabel,
  nodeVisibleClasses,
  computeLabelSeparations,
  selectLabels,
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
/** Screen-space breathing room to the left of the root in the horizontal
 * view. Taxon labels hang leftward off their nodes, and the root's own
 * label needs somewhere to go. */
const LABEL_GUTTER_LEFT_PX = 120;
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

  // Is the primary pointer a fingertip? Drives the interaction model, not
  // the layout: a phone has no hover to reveal a title, no shift key to
  // compare with, and `dblclick` on an SVG <text> is unreliable across
  // mobile browsers — so on a coarse pointer a tap on a taxon label opens
  // an explicit action menu instead. Same actions, same handlers; only the
  // gesture that reaches them differs.
  const [coarsePointer, setCoarsePointer] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(pointer: coarse)");
    const sync = () => setCoarsePointer(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  const [nodeMenu, setNodeMenu] = useState<{
    x: number;
    y: number;
    key: string;
    name: string;
    taxonId: string | null;
    isCollapsed: boolean;
    hasChildren: boolean;
    inComparison: boolean;
  } | null>(null);

  /** True while a two-finger canvas gesture is in flight. A pinch that
   * starts with a finger already resting on a node would otherwise zoom the
   * canvas and drag that node at the same time. */
  const pinchingRef = useRef(false);

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

  /* Labels hold a constant SIZE on screen and vary in DENSITY.
   *
   * The zoom transform is one scale(k) over the whole figure layer, so
   * anything drawn in layout units shrinks with the tree — which at
   * fit-to-view (k ~ 0.2 for a default tree) rendered 12px names at about
   * 2.4px. Dividing type size and label offsets by k holds them at their
   * intended screen size instead, so a name is as readable zoomed out as
   * zoomed in.
   *
   * The cost lands on density: at 0.2x the rows are only a few screen
   * pixels apart, so most names cannot be drawn at all. `rectLabels` is
   * what decides which ones are, and it is the only thing preventing a pile
   * of overlapping text. Search hits and the selected family's clades are
   * boosted so the names a reader is actively looking for are the last to
   * be dropped, never the first. */
  /** Layout units per screen pixel. Anything whose job is to be COMPARED
   * rather than measured against the tree's own geometry multiplies by this
   * to hold a constant on-screen size. */
  const screenScale = 1 / Math.max(scale, 0.001);
  const labelScale = screenScale;
  //
  // Split in two on purpose: the separations do not depend on the zoom, so
  // they survive panning and zooming untouched and only the cheap threshold
  // comparison reruns per frame.
  const labelSeparations = useMemo(() => {
    if (isRadial) return null;
    return computeLabelSeparations(horizontal.nodes, {
      boost: (n) => {
        const node = n.data;
        let extra = 0;
        if (searchQuery && nodeMatchesOrContains(node, searchQuery)) extra += 2000;
        if (familyMembership?.nodeKeys.has(nodeKey(node))) extra += 1500;
        return extra;
      },
    });
  }, [isRadial, horizontal.nodes, searchQuery, familyMembership]);

  const rectLabels = useMemo(
    () => (labelSeparations ? selectLabels(labelSeparations, scale) : null),
    [labelSeparations, scale],
  );


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
  /* The widest label on screen, in SCREEN pixels.
   *
   * Screen pixels because labels hold a constant screen size, so the room
   * they need is the same however far the tree is zoomed. `fitView` reserves
   * it out of the viewport before fitting the tree into what is left — the
   * old layout-unit margins could not do that job, since 300 layout units
   * is 300px at 1x and 60px at 0.2x while the name it has to clear is ~104px
   * at both. */
  const widestLabelPx = useMemo(() => {
    const tips = nodes.filter((n) => !n.children || n.children.length === 0);
    if (tips.length === 0) return 0;
    return Math.max(...tips.map((n) => estimateLabelWidth(nodeLabel(n.data))));
  }, [nodes]);

  const layoutRef = useRef<{
    hNodes: typeof horizontal.nodes;
    rSize: number;
    labelPadPx: number;
  }>({ hNodes: [], rSize: 0, labelPadPx: 0 });
  layoutRef.current = {
    hNodes: horizontal.nodes,
    rSize: radial.size,
    labelPadPx: widestLabelPx + GLYPH_TRACK_GUTTER,
  };
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
      bx = minY;
      by = minX - 30;
      bw = maxY - minY;
      bh = maxX - minX + 60;
    }
    // Room for the labels and the aligned track, taken off the viewport
    // rather than added to the tree's extent — see `widestLabelPx`. The
    // tree's own span then fits whatever is left, which is what keeps the
    // glyph bars on screen instead of clipped off the right edge.
    const pad = layoutRef.current.labelPadPx;
    const padL = isRadial ? pad : LABEL_GUTTER_LEFT_PX;
    const padR = pad;
    const availW = Math.max(cw - padL - padR, 60);
    const availH = Math.max(isRadial ? ch - pad * 2 : ch, 60);
    const k = Math.max(0.12, Math.min(availW / bw, availH / bh, 1.3));
    const tx = padL + (availW - bw * k) / 2 - bx * k;
    const ty = (ch - bh * k) / 2 - by * k;
    d3.select(svgEl).call(behavior.transform, d3.zoomIdentity.translate(tx, ty).scale(k));
  }, [isRadial]);

  /** Step the zoom about the centre of the viewport.
   *
   * Buttons rather than gesture-only: pinch works (see the zoom filter), but
   * it is a two-handed gesture on a phone held in one, it is unavailable to
   * anyone using a device with assistive touch, and on a trackpad-less
   * desktop there is no wheel either. Same zoom behaviour, so the transform,
   * the scale extent and the semantic-zoom label thresholds are identical
   * however the user got there. */
  const zoomByStep = useCallback((factor: number) => {
    const svgEl = localSvgRef.current;
    const behavior = zoomBehaviorRef.current;
    const el = containerRef.current;
    if (!svgEl || !behavior || !el) return;
    d3.select(svgEl)
      .transition()
      .duration(180)
      .call(behavior.scaleBy, factor, [
        (el.clientWidth || vbRef.current.w) / 2,
        (el.clientHeight || vbRef.current.h) / 2,
      ]);
  }, []);

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
        // Touch. Two or more fingers always pinch-zoom / pan the canvas,
        // wherever they land — that is the gesture people reach for first,
        // and demanding they find empty space to start it would make zoom
        // feel broken on a dense tree. One finger pans only from empty
        // canvas, so a single-finger tap still selects and a single-finger
        // drag on a node still moves that node.
        if (event.type === "touchstart") {
          if ((event.touches?.length ?? 0) >= 2) return true;
          const t = event.target as Element | null;
          return !!t && (t === svgEl || t.getAttribute?.("data-canvas-bg") === "true");
        }
        if (event.button === 1) return true; // middle-drag pan
        // Left-drag pans only when it starts on empty canvas, never on a
        // node or label (those are select / compare / focus).
        if (event.type === "mousedown" && event.button === 0) {
          const t = event.target as Element | null;
          return !!t && (t === svgEl || t.getAttribute?.("data-canvas-bg") === "true");
        }
        return false;
      })
      .on("start", (event) => {
        pinchingRef.current = (event.sourceEvent?.touches?.length ?? 0) >= 2;
        // A menu anchored to a screen position is wrong the moment the
        // canvas moves under it.
        setNodeMenu(null);
      })
      .on("end", () => {
        pinchingRef.current = false;
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
      // `clickDistance(4)` keeps a click a click on a mouse; a fingertip
      // wobbles further than a cursor does, so touch gets a wider slop
      // before a tap is reclassified as a drag.
      .clickDistance(10)
      .on("start", (event) => event.sourceEvent?.stopPropagation())
      .on("drag", function (event) {
        // A two-finger canvas gesture owns the interaction; without this a
        // pinch begun with a finger resting on a node would zoom the canvas
        // and drag that node at the same time.
        if (pinchingRef.current) return;
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

  /** Anchor the touch action menu near the tap, clamped inside the canvas so
   * a label at the right-hand edge — where half the radial tree's labels
   * live — does not open a menu that runs off-screen. */
  const openNodeMenu = useCallback(
    (
      clientX: number,
      clientY: number,
      info: {
        key: string;
        name: string;
        taxonId: string | null;
        isCollapsed: boolean;
        hasChildren: boolean;
        inComparison: boolean;
      },
    ) => {
      const el = containerRef.current;
      if (!el) return;
      const box = el.getBoundingClientRect();
      const MENU_W = 208;
      const MENU_H = 200;
      const x = Math.min(Math.max(8, clientX - box.left - MENU_W / 2), Math.max(8, box.width - MENU_W - 8));
      const y = Math.min(Math.max(8, clientY - box.top + 12), Math.max(8, box.height - MENU_H - 8));
      setNodeMenu({ x, y, ...info });
    },
    [],
  );

  // A menu pinned to a node that is no longer drawn (the tree was refiltered,
  // reoriented or refocused underneath it) would act on a stale key.
  useEffect(() => {
    setNodeMenu(null);
  }, [root, orientation, selectedFamilyId]);

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
    // Past the deepest tip AND past the longest label hanging off one.
    // The gutter alone left the bars drawn straight through the accessions:
    // 26 units of clearance against a name ~104 units wide at 1x, and wider
    // still as the reader zooms out, because labels hold a constant screen
    // size and therefore cover more layout space the further out they go.
    const clearance = Math.max(
      ...tips.map((n) => estimateLabelWidth(nodeLabel(n.data), labelScale)),
      0,
    );
    return Math.max(...tips.map((n) => n.y)) + clearance + GLYPH_TRACK_GUTTER;
  }, [nodes, labelScale]);
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

  /* The family-presence column, which has the same clearance problem as
   * the glyph track and needs the same answer — it is placed past the
   * widest accession, not a constant, or the presence ticks land on top of
   * the names they are meant to annotate. */
  const trackX = useMemo(
    () =>
      genomeLeaves.length
        ? Math.max(...genomeLeaves.map((n) => n.y)) +
          Math.max(...genomeLeaves.map((n) => estimateLabelWidth(nodeLabel(n.data), labelScale)), 0) +
          PRESENCE_GUTTER
        : 0,
    [genomeLeaves, labelScale],
  );

  return (
    <div ref={containerRef} className="relative h-full w-full">
      <svg
        ref={setSvgRef}
        width="100%"
        height="100%"
        viewBox={`0 0 ${vb.w} ${vb.h}`}
        // `touchAction: none` hands every touch on the canvas to d3-zoom and
        // d3-drag. Without it the browser claims the gesture first: a pan
        // scrolls the page, a pinch zooms the document, and the tree's own
        // navigation never sees either event.
        style={{ display: "block", cursor: "grab", touchAction: "none" }}
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
                  // Branch weight already encodes subtree cluster count
                  // (sqrt-scaled, 1-11). It was drawn in LAYOUT units, so at
                  // the default fit-to-view zoom of ~0.2 the whole range
                  // collapsed to 0.2-2.2px — the encoding was there and
                  // invisible, a taper nobody could see.
                  //
                  // Stroke width is the right thing to hold constant, and
                  // the glyph bars beside it are the right thing to leave
                  // scaling. A bar's LENGTH is read against the tree's own
                  // geometry, so it has to move with it; a stroke's WIDTH is
                  // only ever read against other strokes, and that
                  // comparison is preserved exactly by scaling them all
                  // together.
                  strokeWidth={(onFamilyPath ? Math.max(width, 2.5) : width) * screenScale}
                  strokeOpacity={onFamilyPath ? 0.85 : dominant ? 0.45 : 0.6}
                  strokeLinecap="round"
                  strokeLinejoin="round"
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
                        isRadial
                          ? hasRoomForLabel(
                              n.y,
                              radial.angularStep,
                              scale,
                              isAnchorRank(node.rank),
                            )
                          : (rectLabels?.visible.has(key) ?? true)
                      }
                      hiddenCount={hidden}
                      matched={isMatch}
                      inSelectedFamily={inSelectedFamily}
                      isEnclosing={isEnclosing}
                      inComparison={node.id !== null && comparisonTaxonIds.includes(node.id)}
                      maxGenomeCount={maxGenomeCount}
                      trackOffset={alignedGlyphs ? Math.max(0, glyphTrackAt - pos.y) : 0}
                      labelScale={labelScale}
                      touchMode={coarsePointer}
                      onToggleCollapse={() => onToggleCollapse(key)}
                      onFocus={() => onFocusNode(key)}
                      onToggleComparison={() =>
                        node.id !== null && onToggleComparisonTaxon(node.id)
                      }
                      onOpenMenu={(cx, cy) =>
                        openNodeMenu(cx, cy, {
                          key,
                          name: node.name,
                          taxonId: node.id,
                          isCollapsed: openCollapsed.has(key),
                          hasChildren: node.children.length > 0,
                          inComparison: node.id !== null && comparisonTaxonIds.includes(node.id),
                        })
                      }
                    />
                  )}
                  {isGenome && (
                    <GenomeNode
                      node={node}
                      isRadial={isRadial}
                      angle={n.x}
                      showLabel={
                        isRadial
                          ? hasRoomForLabel(n.y, radial.angularStep, scale)
                          : (rectLabels?.visible.has(key) ?? true)
                      }
                      matched={isMatch}
                      searchQuery={searchQuery}
                      aligned={alignedGlyphs}
                      labelScale={labelScale}
                      touchMode={coarsePointer}
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
            {hiddenLabelCount} label{hiddenLabelCount === 1 ? "" : "s"} hidden for space ·{" "}
            {coarsePointer ? "pinch to zoom in, drag to pan" : "scroll to zoom in, drag to pan"}
          </text>
        )}
      </svg>

      <div className="pointer-events-none absolute right-2 top-2 flex flex-col items-end gap-1.5 sm:right-3 sm:top-3">
        <button
          onClick={fitView}
          className="pointer-events-auto rounded border border-line bg-card px-2.5 py-1.5 text-xs text-ink-muted shadow-sm hover:border-line-strong hover:text-ink"
          title="Fit the tree to the screen"
        >
          Recenter
        </button>
        <div className="pointer-events-auto flex flex-col overflow-hidden rounded border border-line bg-card shadow-sm">
          <button
            onClick={() => zoomByStep(1.5)}
            aria-label="Zoom in"
            title="Zoom in"
            className="flex h-9 w-9 items-center justify-center border-b border-line text-ink-muted hover:bg-paper hover:text-ink"
          >
            <Plus size={16} />
          </button>
          <button
            onClick={() => zoomByStep(1 / 1.5)}
            aria-label="Zoom out"
            title="Zoom out"
            className="flex h-9 w-9 items-center justify-center text-ink-muted hover:bg-paper hover:text-ink"
          >
            <Minus size={16} />
          </button>
        </div>
      </div>

      {/* Touch action menu.
          On a coarse pointer there is no shift-click and no dependable
          double-click on an SVG <text>, so focus and compare — the two
          navigation moves the tree is built around — would simply be
          unreachable. A tap on a taxon label opens this instead; it calls
          exactly the same handlers the keyboard modifiers do. */}
      {nodeMenu && (
        <>
          <div
            aria-hidden
            className="absolute inset-0 z-20"
            onClick={() => setNodeMenu(null)}
            onTouchStart={() => setNodeMenu(null)}
          />
          <div
            role="menu"
            className="absolute z-30 w-52 overflow-hidden rounded-md border border-line bg-card shadow-lg"
            style={{ left: nodeMenu.x, top: nodeMenu.y }}
          >
            <div className="truncate border-b border-line px-3 py-2 text-xs font-medium text-ink">
              {nodeMenu.name}
            </div>
            <MenuItem
              onClick={() => {
                onFocusNode(nodeMenu.key);
                setNodeMenu(null);
              }}
            >
              Focus on this clade
            </MenuItem>
            {nodeMenu.hasChildren && (
              <MenuItem
                onClick={() => {
                  onToggleCollapse(nodeMenu.key);
                  setNodeMenu(null);
                }}
              >
                {nodeMenu.isCollapsed ? "Expand" : "Collapse"}
              </MenuItem>
            )}
            {nodeMenu.taxonId !== null && (
              <MenuItem
                onClick={() => {
                  onToggleComparisonTaxon(nodeMenu.taxonId!);
                  setNodeMenu(null);
                }}
              >
                {nodeMenu.inComparison ? "Remove from comparison" : "Add to comparison"}
              </MenuItem>
            )}
            <MenuItem muted onClick={() => setNodeMenu(null)}>
              Cancel
            </MenuItem>
          </div>
        </>
      )}
    </div>
  );
}

function MenuItem({
  children,
  onClick,
  muted,
}: {
  children: React.ReactNode;
  onClick: () => void;
  muted?: boolean;
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className={`block w-full border-t border-line px-3 py-2.5 text-left text-sm first:border-t-0 hover:bg-signal-wash ${
        muted ? "text-ink-faint" : "text-ink"
      }`}
    >
      {children}
    </button>
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
  labelScale,
  touchMode,
  onToggleCollapse,
  onToggleComparison,
  onFocus,
  onOpenMenu,
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
  /** 1/zoom. Every label dimension is multiplied by this so type holds a
   * constant SCREEN size while the figure scales — see `labelScale` in
   * TreeCanvas. Data marks (node radii, branch widths, glyph bars) are
   * deliberately NOT scaled this way: they encode magnitude and must keep
   * their proportion to the tree. */
  labelScale: number;
  onToggleCollapse: () => void;
  onToggleComparison: () => void;
  onFocus: () => void;
  /** Coarse pointer: a tap on the label opens the action menu instead of
   * relying on shift-click and double-click, neither of which a touchscreen
   * can produce. */
  touchMode: boolean;
  onOpenMenu: (clientX: number, clientY: number) => void;
  trackOffset: number;
}) {
  const isHighRank = node.rank === "domain" || node.rank === "phylum";
  const badge = rankAbbreviation(node.rank);
  const flip = isRadial && isLeftHalf(angle);
  const labelAnchor = isRadial ? (flip ? "end" : "start") : "end";
  const ls = labelScale;
  const labelSize = (isHighRank ? 13 : 12) * ls;
  const labelX = (isRadial ? (flip ? -14 : 14) : -9) * ls;
  const labelTransform = flip ? "rotate(180)" : undefined;
  // 6.6px per character at the base 12px size, so the estimate scales with
  // the type rather than drifting away from it as the reader zooms.
  const charWidth = 6.6 * ls;
  const badgeX = isRadial ? (flip ? 8 : -20) * ls : -node.name.length * charWidth - 22 * ls;
  // Same per-character estimate the badge offset uses — good enough for a
  // hit box, and it avoids a getBBox() measure per node.
  const labelBoxWidth = (node.name.length + (hiddenCount > 0 ? 5 : 0)) * charWidth + 8 * ls;
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
          touchMode={touchMode}
          onToggleCollapse={onToggleCollapse}
        />
      ) : (
        <g className="cursor-pointer" onClick={onToggleCollapse}>
          {/* Invisible halo: a 4.5px dot is a fine mouse target and an
              impossible finger one. */}
          {touchMode && <circle r={14} fill="transparent" />}
          <circle
            r={4.5}
            fill={COLORS.paper}
            stroke={inSelectedFamily ? COLORS.present : COLORS.ink}
            strokeWidth={inSelectedFamily ? 1.75 : 1.25}
          />
        </g>
      )}

      {matched && !isRadial && (
        <rect
          x={labelX - node.name.length * charWidth - 4 * ls}
          y={-8 * ls}
          width={node.name.length * charWidth + 8 * ls}
          height={16 * ls}
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
            x={badgeX + 6.5 * ls}
            textAnchor="middle"
            dy="0.32em"
            fontSize={8.5 * ls}
            fontWeight={600}
            fill={COLORS.inkMuted}
          >
            {badge}
          </text>
        </g>
      )}

      {showLabel && (
        <g transform={labelTransform}>
          {/* Touch hit target. Glyph outlines are the only thing a bare
              <text> catches a tap on, which is a few pixels of stroke — well
              under the ~44px a fingertip needs. This transparent rect covers
              the label's box so the tap lands where the reader aimed. It is
              only drawn on coarse pointers, so the mouse hit area, and the
              exported figure, are unchanged. */}
          {touchMode && (
            <rect
              x={labelAnchor === "end" ? labelX - labelBoxWidth : labelX - 2 * ls}
              y={-11 * ls}
              width={labelBoxWidth + 4 * ls}
              height={22 * ls}
              fill="transparent"
              className="cursor-pointer"
              onClick={(e) => {
                e.stopPropagation();
                onOpenMenu(e.clientX, e.clientY);
              }}
            />
          )}
          <text
            x={labelX}
            textAnchor={labelAnchor}
            dy="0.32em"
            fontStyle={node.rank === "species" ? "italic" : "normal"}
            fontSize={labelSize}
            fontWeight={matched || isHighRank || inSelectedFamily || inComparison ? 600 : 400}
            {...LABEL_HALO}
            fill={
              matched
                ? COLORS.labelMatch
                : inSelectedFamily || inComparison
                  // `present`, not `signal`: this is family/comparison
                  // STATE on the figure, the same thing the node ring and
                  // the presence track already mark. It used to read
                  // `signal`, which was invisible only because the two were
                  // the same green — now that the interface accent is
                  // oxblood, sharing it here would put two different
                  // colours on one state.
                  ? COLORS.present
                  : COLORS.label
            }
            className="cursor-pointer"
            onClick={(e) => {
              if (touchMode) {
                e.stopPropagation();
                onOpenMenu(e.clientX, e.clientY);
                return;
              }
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
        </g>
      )}
    </>
  );
}

function CladeGlyph({
  node,
  maxGenomeCount,
  flip,
  trackOffset,
  touchMode,
  onToggleCollapse,
}: {
  node: Extract<DisplayNode, { _kind: "taxon" }>;
  maxGenomeCount: number;
  flip: boolean;
  touchMode: boolean;
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
      {/* The bar is 13px tall — half a fingertip. Widen the target without
          widening the mark. */}
      {touchMode && (
        <rect x={x - 6} y={-16} width={width + 12} height={32} fill="transparent" />
      )}

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

/** Painted UNDER the glyph, so a label stays readable where it crosses a
 * branch, a clade wash or the glyph track.
 *
 * Set as SVG presentation attributes rather than a CSS class on purpose:
 * `lib/export.ts` inlines only font properties when it lifts the figure out
 * of the DOM, on the documented understanding that fill and stroke are
 * already attributes on the elements. A class-based halo would look right
 * on screen and silently vanish from every exported figure.
 *
 * `paintOrder: "stroke"` is what puts the stroke behind the fill; without
 * it this would outline the letterforms instead of backing them.
 */
const LABEL_HALO = {
  stroke: COLORS.labelHalo,
  strokeWidth: 3,
  strokeLinejoin: "round",
  paintOrder: "stroke",
} as const;

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
  labelScale,
  touchMode,
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
  /** 1/zoom — see TaxonNode's `labelScale`. */
  labelScale: number;
  /** Coarse pointer: widen the tip's hit area (see the halo below). */
  touchMode: boolean;
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
  const gls = labelScale;
  // The gap the label needs before the glyphs start is a function of the
  // LABEL, which is now constant on screen — so this offset has to be too,
  // or the barcode slides under the accession as the reader zooms out.
  const barcodeStart = (showLabel ? BARCODE_START_X : 12) * gls;
  const barEnd = aligned
    ? trackOffset + node.bgcs.length * segWidth
    : barcodeStart + node.bgcs.length * BARCODE_TICK_WIDTH;
  const dominant = dominantBgcClass(node);
  const dominantColor = dominant ? (BGC_CLASS_COLORS[dominant] ?? COLORS.inkMuted) : COLORS.inkMuted;
  return (
    <g className="cursor-pointer" onClick={onSelectGenome} opacity={dimmedBySelection ? 0.55 : 1}>
      <g transform={flip ? "rotate(180)" : undefined}>
        {/* Finger-sized hit area for the tip. A `tier.radius` of 2.5–6px is
            a comfortable mouse target and an unreachable touch one; the halo
            is transparent, so nothing about the drawn figure changes. */}
        {touchMode && <circle r={Math.max(tier.radius + 8, 12)} fill="transparent" />}
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
            x={flip ? -node.accession.length * 6.9 * gls - 14 * gls : 6 * gls}
            y={-8 * gls}
            width={node.accession.length * 6.9 * gls + 8 * gls}
            height={16 * gls}
            fill="#FDF3C7"
            stroke="#E8C84A"
            strokeWidth={0.75}
            rx={2}
          />
        )}
        {showLabel && (
          <text
            x={flip ? -(tier.radius + 6 * gls) : tier.radius + 6 * gls}
            textAnchor={flip ? "end" : "start"}
            dy="0.32em"
            fontSize={11.5 * gls}
            fontWeight={matched ? 600 : 400}
            {...LABEL_HALO}
            fill={matched ? COLORS.label : COLORS.labelMuted}
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
          : barcodeStart + i * BARCODE_TICK_WIDTH;
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
                stroke={COLORS.present}
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
          x={flip ? -(barEnd + 6 * gls) : barEnd + 6 * gls}
          dy="0.32em"
          fontSize={9.5 * gls}
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
