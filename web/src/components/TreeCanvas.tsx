"use client";

import * as d3 from "d3";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DisplayNode, TaxonDisplayNode } from "@/lib/api-types";
import { BGC_CLASS_COLORS, BGC_CLASS_LABELS, COLORS, classColor } from "@/lib/colors";
import {
  bgcInFamily,
  bgcSizeTier,
  branchWidth,
  cladeSummary,
  dominantBgcClass,
  glyphWidth,
  computeTreeLayout,
  genomeMatchesActiveClasses,
  hiddenChildrenCount,
  effectiveCollapsed,
  matchesQuery,
  nodeHasFamily,
  nodeMatchesOrContains,
  nodeKey,
  nodeVisibleClasses,
  computeRadialTreeLayout,
  hasRoomForLabel,
  isAnchorRank,
  isLeftHalf,
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
}

const TREE_WIDTH = 760;
const H_MARGIN_LEFT = 210;
const H_MARGIN_RIGHT = 300;
const PRESENCE_GUTTER = 150;

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
}: TreeCanvasProps) {
  // Searching forces open the path to every match — a hit inside a
  // collapsed clade would otherwise never render, which made search look
  // broken rather than filtered.
  const openCollapsed = useMemo(
    () => effectiveCollapsed(root, collapsed, searchQuery),
    [root, collapsed, searchQuery],
  );
  const horizontal = useMemo(
    () => computeTreeLayout(root, openCollapsed, TREE_WIDTH),
    [root, openCollapsed],
  );
  const radial = useMemo(() => computeRadialTreeLayout(root, openCollapsed), [root, openCollapsed]);
  const isRadial = orientation === "radial";
  const nodes = isRadial ? radial.nodes : horizontal.nodes;
  const links = isRadial ? radial.links : horizontal.links;

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
                  d={(isRadial ? radialLinkGenerator(link) : linkGenerator(link)) ?? undefined}
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
                  transform={
                    isRadial
                      ? `rotate(${(n.x * 180) / Math.PI - 90}) translate(${n.y},0)`
                      : `translate(${n.y},${n.x})`
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
  onToggleCollapse,
}: {
  node: Extract<DisplayNode, { _kind: "taxon" }>;
  maxGenomeCount: number;
  flip: boolean;
  onToggleCollapse: () => void;
}) {
  const summary = cladeSummary(node);
  const width = glyphWidth(summary.genomeCount, maxGenomeCount);
  const height = 13;
  const x = flip ? -width - 6 : 6;

  let offset = 0;
  return (
    <g className="cursor-pointer" onClick={onToggleCollapse}>
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
  isEnclosing,
  dimmedBySelection,
  selectedFamilyId,
  onSelectGenome,
  onSelectBgc,
}: {
  node: Extract<DisplayNode, { _kind: "genome" }>;
  isRadial: boolean;
  angle: number;
  showLabel: boolean;
  matched: boolean;
  isEnclosing: boolean;
  dimmedBySelection: boolean;
  selectedFamilyId: string | null;
  onSelectGenome: () => void;
  onSelectBgc: (id: string) => void;
}) {
  const flip = isRadial && isLeftHalf(angle);
  const tier = bgcSizeTier(node.bgcs.length);
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
      </g>
      {node.bgcs.map((b, i) => {
        const colors = classColor(b.bgc_class, b.subtype);
        const x = (showLabel ? BARCODE_START_X : 12) + i * BARCODE_TICK_WIDTH;
        const primary = colors[0] ?? COLORS.inkFaint;
        const inFamily = bgcInFamily(b, selectedFamilyId);
        return (
          <g
            key={b.id}
            onClick={(e) => {
              e.stopPropagation();
              onSelectBgc(b.id);
            }}
          >
            {inFamily && (
              <rect
                x={x - 2}
                y={-7.5}
                width={11}
                height={15}
                fill="none"
                stroke={COLORS.signal}
                strokeWidth={1.5}
                rx={2}
              />
            )}
            {colors.length === 1 ? (
              <rect x={x} y={-5} width={7} height={10} fill={primary} rx={1} />
            ) : (
              <>
                <rect x={x} y={-5} width={3.5} height={10} fill={primary} />
                <rect x={x + 3.5} y={-5} width={3.5} height={10} fill={colors[1] ?? COLORS.inkFaint} />
              </>
            )}
          </g>
        );
      })}
      {node.is_mag && showLabel && (
        <text
          x={(showLabel ? BARCODE_START_X : 12) + node.bgcs.length * BARCODE_TICK_WIDTH + 6}
          dy="0.32em"
          fontSize={9.5}
          fill={COLORS.inkFaint}
          transform={flip ? "rotate(180)" : undefined}
          textAnchor={flip ? "end" : "start"}
        >
          MAG
        </text>
      )}
    </g>
  );
}
