"use client";

import * as d3 from "d3";
import { useMemo } from "react";
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
  subtreeBgcCount,
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
}: TreeCanvasProps) {
  // Searching forces open the path to every match — a hit inside a
  // collapsed clade would otherwise never render, which made search look
  // broken rather than filtered.
  const openCollapsed = useMemo(
    () => effectiveCollapsed(root, collapsed, searchQuery),
    [root, collapsed, searchQuery],
  );
  const { nodes, links, height } = useMemo(
    () => computeTreeLayout(root, openCollapsed, TREE_WIDTH),
    [root, openCollapsed],
  );

  const linkGenerator = useMemo(
    () =>
      d3
        .linkHorizontal<d3.HierarchyPointLink<DisplayNode>, d3.HierarchyPointNode<DisplayNode>>()
        .x((d) => d.y)
        .y((d) => d.x),
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
    <svg ref={svgRef} width="100%" height={height} viewBox={`0 0 ${SVG_VIEWBOX_WIDTH} ${height}`}>
      <g transform="translate(30,20)">
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
              d={linkGenerator(link) ?? undefined}
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
            <g key={key} transform={`translate(${n.y},${n.x})`} opacity={opacity}>
              {!isGenome && (
                <TaxonNode
                  node={node}
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
  hiddenCount,
  matched,
  inSelectedFamily,
  inComparison,
  onToggleCollapse,
  onToggleComparison,
}: {
  node: Extract<DisplayNode, { _kind: "taxon" }>;
  hiddenCount: number;
  matched: boolean;
  inSelectedFamily: boolean;
  inComparison: boolean;
  onToggleCollapse: () => void;
  onToggleComparison: () => void;
}) {
  const isHighRank = node.rank === "domain" || node.rank === "phylum";
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
      {matched && (
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
      <text
        x={-9}
        textAnchor="end"
        dy="0.32em"
        fontStyle={node.rank === "species" ? "italic" : "normal"}
        fontSize={isHighRank ? 13 : 12}
        fontWeight={matched || isHighRank || inSelectedFamily || inComparison ? 600 : 400}
        fill={inSelectedFamily || inComparison ? COLORS.signal : COLORS.ink}
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
  matched,
  dimmedBySelection,
  selectedFamilyId,
  onSelectGenome,
  onSelectBgc,
}: {
  node: Extract<DisplayNode, { _kind: "genome" }>;
  matched: boolean;
  dimmedBySelection: boolean;
  selectedFamilyId: string | null;
  onSelectGenome: () => void;
  onSelectBgc: (id: string) => void;
}) {
  return (
    <g className="cursor-pointer" onClick={onSelectGenome} opacity={dimmedBySelection ? 0.55 : 1}>
      {matched && (
        <rect
          x={6}
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
        x={10}
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
