"use client";

import { sankey, sankeyLinkHorizontal, type SankeyGraph } from "d3-sankey";
import { useEffect, useMemo, useState } from "react";
import { fetchTaxonomyClassFlow, type TreeScope } from "@/lib/api-client";
import type { TaxonomyClassFlow } from "@/lib/api-types";
import { BGC_CLASS_COLORS, BGC_CLASS_LABELS, COLORS } from "@/lib/colors";

interface SankeyNode {
  id: string;
  label: string;
  stage: string;
  index?: number;
  x0?: number;
  x1?: number;
  y0?: number;
  y1?: number;
}
interface SankeyLink {
  source: number | SankeyNode;
  target: number | SankeyNode;
  value: number;
  width?: number;
}

const WIDTH = 880;
const HEIGHT = 520;

export function SankeyView({ scope = "all" }: { scope?: TreeScope }) {
  const [data, setData] = useState<TaxonomyClassFlow | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchTaxonomyClassFlow(scope)
      .then((d) => !cancelled && setData(d))
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [scope]);

  const graph = useMemo(() => {
    if (!data || data.nodes.length === 0) return null;
    const index = new Map(data.nodes.map((n, i) => [n.id, i]));
    const layout = sankey<SankeyNode, SankeyLink>()
      .nodeWidth(14)
      .nodePadding(11)
      .extent([
        [1, 6],
        [WIDTH - 1, HEIGHT - 6],
      ]);
    try {
      return layout({
        nodes: data.nodes.map((n) => ({ ...n })),
        links: data.links.map((l) => ({
          source: index.get(l.source) ?? 0,
          target: index.get(l.target) ?? 0,
          value: l.value,
        })),
      } as SankeyGraph<SankeyNode, SankeyLink>);
    } catch {
      // A cyclic or malformed graph would throw; better an explicit null
      // than a half-drawn diagram implying flows that weren't computed.
      return null;
    }
  }, [data]);

  if (error) return <div className="p-6 text-sm text-red-700">{error}</div>;
  if (!data) return <div className="p-6 text-sm text-ink-muted">Loading flows…</div>;
  if (!graph) return <div className="p-6 text-sm text-ink-muted">Not enough classified data to draw flows.</div>;

  const nodeColor = (n: SankeyNode) =>
    n.stage === "bgc_class" ? (BGC_CLASS_COLORS[n.label] ?? COLORS.inkFaint) : COLORS.inkMuted;

  return (
    <div className="p-6">
      <div className="mb-1 text-sm text-ink">Biosynthetic potential by lineage</div>
      <div className="mb-4 max-w-3xl text-xs leading-relaxed text-ink-muted">
        Phylum → genus → BGC class. Ribbon width is the number of clusters.{" "}
        {data.hybrid_double_counted > 0 && (
          <>
            <span className="text-ink">
              {data.hybrid_double_counted} hybrid cluster
              {data.hybrid_double_counted === 1 ? "" : "s"} appear under each component class
            </span>
            , so the right-hand column totals {data.total_bgcs - data.unclassified_bgcs + data.hybrid_double_counted}{" "}
            rather than {data.total_bgcs - data.unclassified_bgcs}.{" "}
          </>
        )}
        {data.unclassified_bgcs > 0 && (
          <>{data.unclassified_bgcs} cluster(s) on unclassified genomes are excluded.</>
        )}
      </div>

      <svg width="100%" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} style={{ maxHeight: "70vh" }}>
        <g>
          {graph.links.map((link, i) => {
            const target = link.target as SankeyNode;
            return (
              <path
                key={i}
                d={sankeyLinkHorizontal()(link as never) ?? undefined}
                fill="none"
                stroke={nodeColor(target)}
                strokeOpacity={0.32}
                strokeWidth={Math.max(1, link.width ?? 1)}
              >
                <title>
                  {(link.source as SankeyNode).label} → {target.label}: {link.value}
                </title>
              </path>
            );
          })}
        </g>
        <g>
          {graph.nodes.map((n) => {
            const isClass = n.stage === "bgc_class";
            const label = isClass ? (BGC_CLASS_LABELS[n.label] ?? n.label) : n.label;
            const x = n.x0 ?? 0;
            const width = (n.x1 ?? 0) - x;
            const y = n.y0 ?? 0;
            const height = Math.max(1, (n.y1 ?? 0) - y);
            const labelLeft = x < WIDTH / 2;
            return (
              <g key={n.id}>
                <rect x={x} y={y} width={width} height={height} fill={nodeColor(n)} rx={2} />
                <text
                  x={labelLeft ? x + width + 5 : x - 5}
                  y={y + height / 2}
                  dy="0.32em"
                  textAnchor={labelLeft ? "start" : "end"}
                  fontSize={10.5}
                  fontStyle={n.stage === "genus" ? "italic" : "normal"}
                  fill={COLORS.ink}
                >
                  {label}
                </text>
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}
