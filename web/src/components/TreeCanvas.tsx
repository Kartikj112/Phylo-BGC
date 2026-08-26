"use client";

import * as d3 from "d3";
import { useEffect, useMemo, useRef, useState } from "react";
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
}

const TREE_WIDTH = 760;
const SVG_VIEWBOX_WIDTH = 900;

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
  const height = isRadial ? radial.size : horizontal.height;

  // Zoom and pan via d3.zoom: wheel to zoom about the cursor, middle-drag
  // to pan. Left-drag is deliberately excluded from the filter — it is
  // click-to-select and shift-click-to-compare, and d3.zoom would swallow
  // both. The transform is applied to a wrapper <g> rather than the <svg>
  // so exported SVG geometry stays in figure coordinates.
  const zoomLayerRef = useRef<SVGGElement | null>(null);
  const localSvgRef = useRef<SVGSVGElement | null>(null);
  const [zoom, setZoom] = useState({ k: 1, x: 0, y: 0 });

  useEffect(() => {
    const svgEl = localSvgRef.current;
    if (!svgEl) return;
    const behavior = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.25, 8])
      .filter((event: any) => event.type === "wheel" || event.button === 1)
      .on("zoom", (event) => {
        const t = event.transform;
        setZoom({ k: t.k, x: t.x, y: t.y });
      });
    const selection = d3.select(svgEl);
    selection.call(behavior);
    // Middle-drag otherwise triggers the browser's autoscroll cursor.
    const suppressAutoscroll = (e: MouseEvent) => {
      if (e.button === 1) e.preventDefault();
    };
    svgEl.addEventListener("mousedown", suppressAutoscroll);
    return () => {
      selection.on(".zoom", null);
      svgEl.removeEventListener("mousedown", suppressAutoscroll);
    };
  }, []);

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

  // Scale branch weight against the largest subtree actually on screen,
  // so collapsing a clade rescales the rest rather than flattening it.
  const maxSubtreeCount = useMemo(
    () => Math.max(1, ...nodes.map((n) => subtreeBgcCount(n.data))),
    [nodes],
  );

  // Glyphs scale against the largest clade currently drawn, so collapsing
  // or focusing rescales the rest rather than leaving everything tiny.
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
            zoom.k,
            n.data._kind === "taxon" && isAnchorRank(n.data.rank),
          ),
      ).length
    : 0;

  return (
    <svg
      ref={setSvgRef}
      width="100%"
      height={height}
      viewBox={`0 0 ${isRadial ? radial.size : SVG_VIEWBOX_WIDTH} ${height}`}
    >
      <g ref={zoomLayerRef} transform={`translate(${zoom.x},${zoom.y}) scale(${zoom.k})`}>
      <g transform={isRadial ? `translate(${radial.size / 2},${radial.size / 2})` : "translate(30,20)"}>
        {links.map((link, i) => {
          const target = link.target.data;
          const width = branchWidth(target, maxSubtreeCount);
          const dominant = dominantBgcClass(target);
          // Tint toward the dominant class, but keep it muted: the branch
          // is context, and saturated colour here would compete with the
          // BGC tick marks that carry the precise signal.
          const stroke = dominant ? (BGC_CLASS_COLORS[dominant] ?? COLORS.lineStrong) : COLORS.lineStrong;
          return (
            <path
              key={i}
              d={(isRadial ? radialLinkGenerator(link) : linkGenerator(link)) ?? undefined}
              fill="none"
              stroke={stroke}
              strokeWidth={width}
              strokeOpacity={dominant ? 0.45 : 0.6}
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

          // Family selection dims everything the family doesn't reach, so
          // its distribution across the tree reads at a glance. Stacked
          // with (not replacing) class filtering — both can be active.
          const familyDimmed = selectedFamilyId !== null && !nodeHasFamily(node, selectedFamilyId);
          const inSelectedFamily = selectedFamilyId !== null && nodeHasFamily(node, selectedFamilyId);

          // Dim everything off a matching branch, rather than only
          // recolouring hits: at ~150 nodes the eye needs the surrounding
          // noise removed to find them at all.
          const searchDimmed = searchQuery.trim() !== "" && !nodeMatchesOrContains(node, searchQuery);

          const opacity = dimmed || genomeDimmed || familyDimmed || searchDimmed ? 0.15 : 1;

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
                    hasRoomForLabel(n.y, radial.angularStep, zoom.k, isAnchorRank(node.rank))
                  }
                  hiddenCount={hidden}
                  matched={isMatch}
                  inSelectedFamily={inSelectedFamily}
                  inComparison={node.id !== null && comparisonTaxonIds.includes(node.id)}
                  maxGenomeCount={maxGenomeCount}
                  onToggleCollapse={() => onToggleCollapse(key)}
                  onFocus={() => onFocusNode(key)}
                  onToggleComparison={() => node.id !== null && onToggleComparisonTaxon(node.id)}
                />
              )}
              {isGenome && (
                <GenomeNode
                  node={node}
                  isRadial={isRadial}
                  angle={n.x}
                  showLabel={!isRadial || hasRoomForLabel(n.y, radial.angularStep, zoom.k)}
                  matched={isMatch}
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

      {/* Outside the zoom layer, so it stays legible at any scale. Tells
          the user labels were withheld for space rather than missing — the
          same confusion the search fix addressed. */}
      {hiddenLabelCount > 0 && (
        <text x={12} y={20} fontSize={11} fill={COLORS.inkFaint}>
          {hiddenLabelCount} label{hiddenLabelCount === 1 ? "" : "s"} hidden for space · scroll to zoom in,
          middle-drag to pan
        </text>
      )}
    </svg>
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
  inComparison: boolean;
  maxGenomeCount: number;
  onToggleCollapse: () => void;
  onToggleComparison: () => void;
  onFocus: () => void;
}) {
  const isHighRank = node.rank === "domain" || node.rank === "phylum";
  const badge = rankAbbreviation(node.rank);
  // In radial mode a label on the left half would render upside down, so
  // it's rotated 180 degrees and anchored from the other side.
  const flip = isRadial && isLeftHalf(angle);
  const labelAnchor = isRadial ? (flip ? "end" : "start") : "end";
  const labelX = isRadial ? (flip ? -14 : 14) : -9;
  const labelTransform = flip ? "rotate(180)" : undefined;
  const badgeX = isRadial ? (flip ? 8 : -20) : -node.name.length * 6.6 - 22;
  return (
    <>
      {/* A collapsed clade renders as a summary rather than a dot:
          width encodes genome count, the stacked bar its BGC class
          composition. Collapsing therefore SUMMARISES rather than hides,
          which is what makes a zoomed-out view more interpretable instead
          of less. */}
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
          stroke={COLORS.ink}
          strokeWidth={1.25}
          className="cursor-pointer"
          onClick={onToggleCollapse}
        />
      )}
      {/* Shift-click adds/removes this clade from the comparison, leaving
          plain click as collapse/expand — the far more frequent action,
          which shouldn't get harder to reach because a second mode exists. */}
      {/* A highlighter wash behind the label. Recolouring alone wasn't
          enough: signal teal against body ink is nearly indistinguishable
          at 12px, so a working search read as a dead one. */}
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

      {/* Rank badge (D/P/C/O/F/G/S — GTDB has no kingdom rank, so no K).
          Rendered as its own glyph rather than prefixed into the label so
          it stays visually subordinate to the organism name. */}
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
        fill={matched ? "#8A6D0B" : inSelectedFamily || inComparison ? COLORS.signal : COLORS.ink}
        className="cursor-pointer"
        onClick={(e) => {
          if (e.shiftKey) {
            e.stopPropagation();
            onToggleComparison();
          }
        }}
        onDoubleClick={(e) => {
          // Double-click focuses. Single click is left free for
          // collapse/compare, both of which are more frequent.
          e.stopPropagation();
          onFocus();
        }}
      >
        {inComparison ? "\u25C6 " : ""}
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
        // No clusters anywhere below: an outline, so an empty clade is
        // visibly different from an unrendered one.
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
      {/* The label is the ONLY thing that gets flipped on the left half.
          Wrapping the whole group in rotate(180) — as this did — also sent
          the BGC tick marks inward toward the hub, because in the parent
          frame +x is always radially outward regardless of hemisphere.
          Ticks therefore stay in the unflipped frame below. */}
      <g transform={flip ? "rotate(180)" : undefined}>
      {/* Node size encodes BGC count, so a genome with fifty clusters
          doesn't compete for attention with one that has none. Empty
          genomes stay visible but subdued -- they are evolutionary
          context, not noise, and removing them would misrepresent the
          phylogeny. */}
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
            {/* A ring rather than a color change: the tick's fill already
                encodes BGC class, which must stay readable while a family
                is selected. */}
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
