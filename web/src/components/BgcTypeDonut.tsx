"use client";

import * as d3 from "d3";
import { useEffect, useMemo, useState } from "react";
import { fetchBgcTypeCounts } from "@/lib/api-client";
import type { BGCTypeCount } from "@/lib/api-types";
import { BGC_CLASS_COLORS, BGC_CLASS_LABELS, COLORS } from "@/lib/colors";

const SIZE = 118;
const THICKNESS = 17;

/** Corpus-wide BGC class distribution. Values come from the API, which
 * attributes hybrids to each component class exactly as the filter rail
 * and heatmap do — a donut disagreeing with the sidebar next to it would
 * be worse than no donut. */
export function BgcTypeDonut() {
  const [data, setData] = useState<BGCTypeCount[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchBgcTypeCounts()
      .then((d) => !cancelled && setData(d))
      .catch(() => !cancelled && setData([]));
    return () => {
      cancelled = true;
    };
  }, []);

  const arcs = useMemo(() => {
    if (!data || data.length === 0) return [];
    const pie = d3.pie<BGCTypeCount>().value((d) => d.count).sort(null);
    const arc = d3
      .arc<d3.PieArcDatum<BGCTypeCount>>()
      .innerRadius(SIZE / 2 - THICKNESS)
      .outerRadius(SIZE / 2);
    return pie(data).map((slice) => ({ d: arc(slice) ?? "", datum: slice.data }));
  }, [data]);

  if (!data) return null;

  const total = data.reduce((sum, d) => sum + d.count, 0);
  if (total === 0) return null;

  // Long tails are collapsed into "other" for the legend only; the ring
  // still shows every slice, so nothing is silently dropped from the
  // proportions.
  const legend = data.slice(0, 5);
  const remainder = data.slice(5).reduce((sum, d) => sum + d.count, 0);

  return (
    <div className="pointer-events-auto rounded border border-line bg-card p-3 shadow-sm">
      <div className="mb-2 text-xs uppercase tracking-wider text-ink-muted">BGCs by type</div>
      <div className="flex items-center gap-3">
        <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} className="flex-shrink-0">
          <g transform={`translate(${SIZE / 2},${SIZE / 2})`}>
            {arcs.map(({ d, datum }) => (
              <path key={datum.bgc_class} d={d} fill={BGC_CLASS_COLORS[datum.bgc_class] ?? COLORS.inkFaint}>
                <title>
                  {BGC_CLASS_LABELS[datum.bgc_class] ?? datum.bgc_class}: {datum.count} (
                  {((datum.count / total) * 100).toFixed(0)}%)
                </title>
              </path>
            ))}
            <text textAnchor="middle" dy="-0.1em" fontSize={17} fontWeight={600} fill={COLORS.ink}>
              {total.toLocaleString()}
            </text>
            <text textAnchor="middle" dy="1.3em" fontSize={8.5} fill={COLORS.inkFaint}>
              clusters
            </text>
          </g>
        </svg>

        <div className="flex flex-col gap-0.5">
          {legend.map((d) => (
            <div key={d.bgc_class} className="flex items-center gap-1.5 text-xs">
              <span
                className="inline-block h-2 w-2 flex-shrink-0 rounded-full"
                style={{ backgroundColor: BGC_CLASS_COLORS[d.bgc_class] ?? COLORS.inkFaint }}
              />
              <span className="text-ink">{BGC_CLASS_LABELS[d.bgc_class] ?? d.bgc_class}</span>
              <span className="ml-auto pl-2 font-mono tabular-nums text-ink-faint">{d.count}</span>
            </div>
          ))}
          {remainder > 0 && (
            <div className="flex items-center gap-1.5 text-xs text-ink-faint">
              <span className="inline-block h-2 w-2 rounded-full bg-[#8A8D86]" />
              <span>+{data.length - 5} more</span>
              <span className="ml-auto pl-2 font-mono tabular-nums">{remainder}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
