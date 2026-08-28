"use client";

import { useEffect, useMemo, useState } from "react";
import { fetchHeatmap, type TreeScope } from "@/lib/api-client";
import type { PresenceHeatmap } from "@/lib/api-types";
import { BGC_CLASS_COLORS, BGC_CLASS_LABELS, COLORS } from "@/lib/colors";

const RANKS = ["phylum", "class", "order", "family", "genus"] as const;

/** `#rrggbb` at a given alpha. */
function withAlpha(hex: string, alpha: number): string {
  const v = hex.replace("#", "");
  const r = parseInt(v.slice(0, 2), 16);
  const g = parseInt(v.slice(2, 4), 16);
  const b = parseInt(v.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${Math.min(1, Math.max(0, alpha)).toFixed(3)})`;
}

export function HeatmapView({ scope = "all" }: { scope?: TreeScope }) {
  const [rank, setRank] = useState<string>("genus");
  const [data, setData] = useState<PresenceHeatmap | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    fetchHeatmap(rank, scope)
      .then((d) => !cancelled && setData(d))
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [rank, scope]);

  const lookup = useMemo(() => {
    const map = new Map<string, { count: number; perGenome: number | null }>();
    data?.cells.forEach((c) =>
      map.set(`${c.row_id}|${c.column}`, { count: c.count, perGenome: c.per_genome ?? null }),
    );
    return map;
  }, [data]);

  // Scale saturation by per-genome rate, not raw count: a large clade
  // would otherwise look uniformly "rich" purely for containing more
  // genomes, which is sampling effort rather than biology.
  const maxRate = useMemo(
    () => Math.max(0.0001, ...(data?.cells ?? []).map((c) => c.per_genome ?? 0)),
    [data],
  );

  return (
    <div className="p-6">
      <div className="mb-1 flex items-center gap-3">
        <span className="text-sm text-ink">Biosynthetic classes by clade</span>
        <div className="flex overflow-hidden rounded border border-line">
          {RANKS.map((r) => (
            <button
              key={r}
              onClick={() => setRank(r)}
              className={`px-2 py-0.5 text-xs ${
                rank === r ? "bg-signal-wash text-signal" : "text-ink-muted hover:text-ink"
              }`}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="text-sm text-red-700">{error}</div>}
      {!data && !error && <div className="text-sm text-ink-muted">Loading…</div>}

      {data && (
        <>
          <div className="mb-4 max-w-3xl text-xs leading-relaxed text-ink-muted">{data.caveat}</div>
          <div className="overflow-auto">
            <table className="border-collapse text-xs">
              <thead>
                <tr>
                  <th className="sticky left-0 bg-paper px-2 py-1 text-left font-medium text-ink-muted">
                    {data.rank}
                  </th>
                  <th className="px-2 py-1 text-right font-medium text-ink-muted">genomes</th>
                  {data.columns.map((c) => (
                    <th key={c} className="px-1 py-1 text-center font-medium">
                      <span className="flex flex-col items-center gap-1">
                        <span
                          className="inline-block h-2 w-2 rounded-full"
                          style={{ backgroundColor: BGC_CLASS_COLORS[c] ?? "#8A8D86" }}
                        />
                        <span className="text-ink-muted">{BGC_CLASS_LABELS[c] ?? c}</span>
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => {
                  const rowId = String(row.id);
                  const genomes = Number(row.genome_count);
                  return (
                    <tr key={rowId}>
                      <td
                        className={`sticky left-0 whitespace-nowrap bg-paper px-2 py-1 text-ink ${
                          data.rank === "species" ? "italic" : ""
                        }`}
                      >
                        {String(row.label)}
                      </td>
                      <td className="px-2 py-1 text-right font-mono tabular-nums text-ink-faint">
                        {genomes}
                      </td>
                      {data.columns.map((column) => {
                        const cell = lookup.get(`${rowId}|${column}`);
                        const rate = cell?.perGenome ?? 0;
                        const intensity = rate > 0 ? 0.12 + 0.88 * (rate / maxRate) : 0;
                        const base = BGC_CLASS_COLORS[column] ?? "#8A8D86";
                        return (
                          <td
                            key={column}
                            className="border border-line px-2 py-1 text-center font-mono tabular-nums"
                            style={{
                              // Alpha on the FILL, not `opacity` on the cell.
                              // Element opacity faded the number along with
                              // its background, so exactly the cells with the
                              // least ink — the low-rate ones a reader most
                              // needs to read a value off — had the least
                              // legible text.
                              backgroundColor: intensity > 0 ? withAlpha(base, intensity) : "transparent",
                              color: intensity > 0.55 ? "#FFFFFF" : COLORS.ink,
                            }}
                            title={`${cell?.count ?? 0} clusters · ${rate.toFixed(2)}/genome · ${genomes} genome(s)`}
                          >
                            {cell?.count ? cell.count : "·"}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="mt-3 text-xs text-ink-faint">
            Cell shade encodes clusters <em>per genome</em>, not raw count — otherwise larger clades look
            richer purely for being better sampled. The number shown is the raw count.
          </div>
        </>
      )}
    </div>
  );
}
