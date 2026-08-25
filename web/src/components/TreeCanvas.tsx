"use client";

import * as d3 from "d3";
import { useCallback, useMemo, useRef, useState } from "react";
import type { DisplayNode, TaxonDisplayNode } from "@/lib/api-types";
import { BGC_CLASS_COLORS, COLORS, classColor } from "@/lib/colors";
import {
  bgcInFamily,
  branchWidth,
  dominantBgcClass,
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

  // Middle-button pan. Left-drag is deliberately left alone: it's how
  // text selection and click-to-select work, and hijacking it would break
  // both. Middle-drag is the convention in map and graph tools.
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragStart = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const onMouseDown = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      if (e.button !== 1) return;
      e.preventDefault(); // suppress the browser's autoscroll cursor
      dragStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
      setDragging(true);
    },
    [pan],
  );

  const onMouseMove = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    const start = dragStart.current;
    if (!start) return;
    setPan({ x: start.panX + (e.clientX - start.x), y: start.panY + (e.clientY - start.y) });
  }, []);

  const endDrag = useCallback(() => {
    dragStart.current = null;
    setDragging(false);
  }, []);

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

  return (
    <svg
      ref={svgRef}
      width="100%"
      height={height}
      viewBox={`0 0 ${isRadial ? radial.size : SVG_VIEWBOX_WIDTH} ${height}`}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={endDrag}
      onMouseLeave={endDrag}
      style={{ cursor: dragging ? "grabbing" : undefined }}
    >
      <g
        transform={
          isRadial
            ? `translate(${radial.size / 2 + pan.x},${radial.size / 2 + pan.y})`
            : `translate(${30 + pan.x},${20 + pan.y})`
        }
      >
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
                  hiddenCount={hidden}
                  matched={isMatch}
                  inSelectedFamily={inSelectedFamily}
                  inComparison={node.id !== null && comparisonTaxonIds.includes(node.id)}
                  onToggleCollapse={() => onToggleCollapse(key)}
                  onToggleComparison={() => node.id !== null && onToggleComparisonTaxon(node.id)}
                />
              )}
              {isGenome && (
                <GenomeNode
                  node={node}
                  isRadial={isRadial}
                  angle={n.x}
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
    </svg>
  );
}

function TaxonNode({
  node,
  isRadial,
  angle,
  hiddenCount,
  matched,
  inSelectedFamily,
  inComparison,
  onToggleCollapse,
  onToggleComparison,
}: {
  node: Extract<DisplayNode, { _kind: "taxon" }>;
  isRadial: boolean;
  angle: number;
  hiddenCount: number;
  matched: boolean;
  inSelectedFamily: boolean;
  inComparison: boolean;
  onToggleCollapse: () => void;
  onToggleComparison: () => void;
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
      <circle
        r={4.5}
        fill={hiddenCount > 0 ? COLORS.signal : COLORS.paper}
        stroke={COLORS.ink}
        strokeWidth={1.25}
        className="cursor-pointer"
        onClick={onToggleCollapse}
      />
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
      {badge && (
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
      >
        {inComparison ? "\u25C6 " : ""}
        {node.name}
        {hiddenCount > 0 ? ` (+${hiddenCount})` : ""}
      </text>
    </>
  );
}

const BARCODE_START_X = 132;
const BARCODE_TICK_WIDTH = 11;

function GenomeNode({
  node,
  isRadial,
  angle,
  matched,
  dimmedBySelection,
  selectedFamilyId,
  onSelectGenome,
  onSelectBgc,
}: {
  node: Extract<DisplayNode, { _kind: "genome" }>;
  isRadial: boolean;
  angle: number;
  matched: boolean;
  dimmedBySelection: boolean;
  selectedFamilyId: string | null;
  onSelectGenome: () => void;
  onSelectBgc: (id: string) => void;
}) {
  const flip = isRadial && isLeftHalf(angle);
  return (
    <g
      className="cursor-pointer"
      onClick={onSelectGenome}
      opacity={dimmedBySelection ? 0.55 : 1}
      transform={flip ? "rotate(180)" : undefined}
    >
      {matched && (
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
      <text
        x={flip ? -10 : 10}
        textAnchor={flip ? "end" : "start"}
        dy="0.32em"
        fontSize={11.5}
        fontWeight={matched ? 600 : 400}
        fill={matched ? COLORS.ink : COLORS.inkMuted}
        className="font-mono"
      >
        {node.accession}
      </text>
      {node.bgcs.map((b, i) => {
        const colors = classColor(b.bgc_class, b.subtype);
        const x = BARCODE_START_X + i * BARCODE_TICK_WIDTH;
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
      {node.is_mag && (
        <text x={BARCODE_START_X + node.bgcs.length * BARCODE_TICK_WIDTH + 6} dy="0.32em" fontSize={9.5} fill={COLORS.inkFaint}>
          MAG
        </text>
      )}
    </g>
  );
}
