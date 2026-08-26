"use client";

import { SlidersHorizontal, X } from "lucide-react";
import { EMPTY_FILTERS, filtersAreActive, type GenomeFilters } from "@/lib/tree-logic";

interface FilterPanelProps {
  filters: GenomeFilters;
  onChange: (filters: GenomeFilters) => void;
  matched: number;
  total: number;
  filteredEverythingOut: boolean;
}

/** Only fields the data model actually stores are offered here. A filter
 * the database can't answer is worse than no filter — it silently
 * returns nothing and looks like a bug. */
export function FilterPanel({ filters, onChange, matched, total, filteredEverythingOut }: FilterPanelProps) {
  const active = filtersAreActive(filters);
  const set = <K extends keyof GenomeFilters>(key: K, value: GenomeFilters[K]) =>
    onChange({ ...filters, [key]: value });

  const num = (v: string): number | null => (v.trim() === "" ? null : Number(v));

  return (
    <div className="mb-5">
      <div className="mb-2 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-ink-muted">
          <SlidersHorizontal size={12} />
          Filters
        </span>
        {active && (
          <button
            onClick={() => onChange(EMPTY_FILTERS)}
            className="flex items-center gap-0.5 text-xs text-signal hover:underline"
          >
            <X size={10} /> Clear
          </button>
        )}
      </div>

      {filteredEverythingOut && (
        <div className="mb-2 rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs text-amber-900">
          No genome matches these filters — showing all instead.
        </div>
      )}
      {active && !filteredEverythingOut && (
        <div className="mb-2 font-mono text-xs text-ink-faint">
          {matched} of {total} genomes match
        </div>
      )}

      <div className="flex flex-col gap-2.5 text-xs">
        <Range
          label="BGC count"
          min={filters.minBgcCount}
          max={filters.maxBgcCount}
          onMin={(v) => set("minBgcCount", num(v))}
          onMax={(v) => set("maxBgcCount", num(v))}
        />

        <div>
          <div className="mb-1 text-ink-muted">MIBiG match</div>
          <div className="flex overflow-hidden rounded border border-line">
            {(["any", "matched", "unmatched"] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => set("mibigMatched", mode)}
                className={`flex-1 px-1.5 py-1 ${
                  filters.mibigMatched === mode ? "bg-signal-wash text-signal" : "text-ink-muted hover:text-ink"
                }`}
              >
                {mode}
              </button>
            ))}
          </div>
        </div>

        <Range
          label="Genome size (Mb)"
          min={filters.minGenomeSizeMb}
          max={filters.maxGenomeSizeMb}
          onMin={(v) => set("minGenomeSizeMb", num(v))}
          onMax={(v) => set("maxGenomeSizeMb", num(v))}
          step="0.1"
        />

        <Range
          label="GC content (%)"
          min={filters.minGcPct}
          max={filters.maxGcPct}
          onMin={(v) => set("minGcPct", num(v))}
          onMax={(v) => set("maxGcPct", num(v))}
          step="0.1"
        />

        <div>
          <div className="mb-1 text-ink-muted">Min completeness (%)</div>
          <input
            type="number"
            value={filters.minCompletenessPct ?? ""}
            onChange={(e) => set("minCompletenessPct", num(e.target.value))}
            placeholder="any"
            className="w-full rounded border border-line bg-paper px-1.5 py-1 text-ink outline-none focus:border-line-strong"
          />
        </div>

        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={filters.magOnly}
            onChange={(e) => set("magOnly", e.target.checked)}
            className="accent-[#2C5F52]"
          />
          <span className="text-ink">MAGs only</span>
        </label>
      </div>

      <p className="mt-2 text-xs leading-relaxed text-ink-faint">
        Genomes with no recorded value for a measurement are kept rather than filtered out — the filter
        can&apos;t speak to them.
      </p>
    </div>
  );
}

function Range({
  label,
  min,
  max,
  onMin,
  onMax,
  step,
}: {
  label: string;
  min: number | null;
  max: number | null;
  onMin: (v: string) => void;
  onMax: (v: string) => void;
  step?: string;
}) {
  return (
    <div>
      <div className="mb-1 text-ink-muted">{label}</div>
      <div className="flex items-center gap-1">
        <input
          type="number"
          step={step}
          value={min ?? ""}
          onChange={(e) => onMin(e.target.value)}
          placeholder="min"
          className="w-full rounded border border-line bg-paper px-1.5 py-1 text-ink outline-none focus:border-line-strong"
        />
        <span className="text-ink-faint">–</span>
        <input
          type="number"
          step={step}
          value={max ?? ""}
          onChange={(e) => onMax(e.target.value)}
          placeholder="max"
          className="w-full rounded border border-line bg-paper px-1.5 py-1 text-ink outline-none focus:border-line-strong"
        />
      </div>
    </div>
  );
}
