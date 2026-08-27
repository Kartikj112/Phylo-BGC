"use client";

import { useEffect, useState } from "react";
import { fetchBgcTypeCounts, fetchProvenance } from "@/lib/api-client";
import type { BGCTypeCount, DatasetProvenanceResponse } from "@/lib/api-types";
import { BGC_CLASS_COLORS, BGC_CLASS_LABELS, COLORS } from "@/lib/colors";

interface CorpusStatsBarProps {
  /** Currently active class filter, so the bar reflects and drives it. */
  activeClasses: Set<string>;
  onToggleClass: (cls: string) => void;
  onResetClasses: () => void;
  /** Genomes actually drawn vs. present, from the pruning pass. */
  shownGenomes: number;
  totalGenomes: number;
}

/**
 * What this dataset contains, stated once at the top: how many clusters,
 * of what kinds, over how many genomes.
 *
 * The class strip is proportional, so the composition of the corpus reads
 * as a shape before any number is parsed — and it is the same filter as
 * the left rail rather than a second, separate control, so the two can
 * never disagree about what is selected.
 *
 * Counts come from `/bgc-type-counts`, which attributes a hybrid cluster to
 * each of its component classes exactly as the tree, heatmap, Sankey and
 * clade comparison do. That is why the class total can exceed the cluster
 * total, and the bar says so rather than letting a reader discover the
 * discrepancy themselves.
 */
export function CorpusStatsBar({
  activeClasses,
  onToggleClass,
  onResetClasses,
  shownGenomes,
  totalGenomes,
}: CorpusStatsBarProps) {
  const [counts, setCounts] = useState<BGCTypeCount[] | null>(null);
  const [provenance, setProvenance] = useState<DatasetProvenanceResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchBgcTypeCounts(), fetchProvenance()])
      .then(([c, p]) => {
        if (cancelled) return;
        setCounts(c);
        setProvenance(p);
      })
      .catch(() => {
        if (!cancelled) setCounts([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!counts || counts.length === 0) return null;

  const classTotal = counts.reduce((sum, c) => sum + c.count, 0);
  const clusterTotal = provenance?.bgc_count ?? classTotal;
  const hybridDoubleCount = classTotal - clusterTotal;
  const filtered = activeClasses.size < counts.length;

  return (
    <div className="flex flex-shrink-0 flex-wrap items-center gap-x-6 gap-y-2 border-b border-line bg-card px-4 py-2">
      <div className="flex items-center gap-5">
        <Stat value={clusterTotal} label="clusters" />
        <Stat
          value={shownGenomes}
          of={totalGenomes !== shownGenomes ? totalGenomes : undefined}
          label="genomes"
        />
        {provenance && <Stat value={provenance.taxon_count} label="taxa" />}
        <Stat value={counts.length} label="BGC classes" />
      </div>

      {/* Proportional class strip — doubles as the class filter. */}
      <div className="flex min-w-[260px] flex-1 flex-col justify-center gap-1">
        <div className="flex h-3 w-full overflow-hidden rounded-sm">
          {counts.map((c) => {
            const active = activeClasses.has(c.bgc_class);
            return (
              <button
                key={c.bgc_class}
                onClick={() => onToggleClass(c.bgc_class)}
                title={`${BGC_CLASS_LABELS[c.bgc_class] ?? c.bgc_class}: ${c.count} clusters (${(
                  (c.count / classTotal) *
                  100
                ).toFixed(1)}%) — click to filter`}
                style={{
                  width: `${(c.count / classTotal) * 100}%`,
                  backgroundColor: BGC_CLASS_COLORS[c.bgc_class] ?? COLORS.inkFaint,
                  opacity: active ? 1 : 0.25,
                }}
                className="h-full transition-opacity first:rounded-l-sm last:rounded-r-sm"
              />
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
          {counts.map((c) => {
            const active = activeClasses.has(c.bgc_class);
            return (
              <button
                key={c.bgc_class}
                onClick={() => onToggleClass(c.bgc_class)}
                className="flex items-center gap-1 text-[11px]"
                style={{ opacity: active ? 1 : 0.4 }}
              >
                <span
                  className="inline-block h-2 w-2 flex-shrink-0 rounded-full"
                  style={{ backgroundColor: BGC_CLASS_COLORS[c.bgc_class] ?? COLORS.inkFaint }}
                />
                <span className="text-ink">{BGC_CLASS_LABELS[c.bgc_class] ?? c.bgc_class}</span>
                <span className="font-mono tabular-nums text-ink-faint">{c.count}</span>
              </button>
            );
          })}
          {filtered && (
            <button onClick={onResetClasses} className="text-[11px] text-signal hover:underline">
              show all
            </button>
          )}
        </div>
      </div>

      {hybridDoubleCount > 0 && (
        <p className="max-w-[15rem] text-[11px] leading-tight text-ink-faint">
          {hybridDoubleCount} hybrid cluster{hybridDoubleCount === 1 ? "" : "s"} count under each
          component class, so the class figures total {classTotal}, not {clusterTotal}.
        </p>
      )}
    </div>
  );
}

function Stat({ value, label, of }: { value: number; label: string; of?: number }) {
  return (
    <div className="flex flex-col items-start leading-none">
      <span className="font-mono text-base font-semibold tabular-nums text-ink">
        {value.toLocaleString()}
        {of != null && (
          <span className="ml-0.5 text-[11px] font-normal text-ink-faint">
            / {of.toLocaleString()}
          </span>
        )}
      </span>
      <span className="mt-1 text-[10px] uppercase tracking-wider text-ink-faint">{label}</span>
    </div>
  );
}
