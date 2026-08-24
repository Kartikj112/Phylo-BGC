"use client";

import { Layers } from "lucide-react";
import { useEffect, useState } from "react";
import { fetchFamilies } from "@/lib/api-client";
import type { BGCFamilySummary } from "@/lib/api-types";
import { BGC_CLASS_COLORS } from "@/lib/colors";

interface FamilyRailProps {
  selectedFamilyId: string | null;
  onSelectFamily: (familyId: string | null) => void;
}

export function FamilyRail({ selectedFamilyId, onSelectFamily }: FamilyRailProps) {
  const [families, setFamilies] = useState<BGCFamilySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchFamilies()
      .then((data) => {
        if (!cancelled) setFamilies(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="mt-6 border-t border-line pt-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-ink-muted">
          <Layers size={12} />
          Gene cluster families
        </span>
        {selectedFamilyId && (
          <button onClick={() => onSelectFamily(null)} className="text-xs text-signal hover:underline">
            Clear
          </button>
        )}
      </div>

      {loading && <div className="text-xs text-ink-faint">Loading…</div>}
      {error && <div className="text-xs text-red-700">{error}</div>}
      {!loading && !error && families.length === 0 && (
        <div className="text-xs leading-relaxed text-ink-faint">
          No families yet. Run <span className="font-mono">bgcscape ingest bigscape</span> to group predicted BGCs
          into families.
        </div>
      )}

      <div className="flex flex-col gap-1">
        {families.map((family) => {
          const selected = family.id === selectedFamilyId;
          // A family spanning more than one taxon is the interesting case
          // — the report's core distribution question. Surfaced directly
          // in the list rather than hidden behind a click.
          const spansMultipleTaxa = family.taxon_names.length > 1;
          return (
            <button
              key={family.id}
              onClick={() => onSelectFamily(selected ? null : family.id)}
              className={`rounded px-2 py-1.5 text-left transition-colors ${
                selected ? "bg-signal-wash" : "hover:bg-paper"
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="flex gap-0.5">
                  {family.bgc_classes.slice(0, 3).map((cls) => (
                    <span
                      key={cls}
                      className="inline-block h-2 w-2 rounded-full"
                      style={{ backgroundColor: BGC_CLASS_COLORS[cls] ?? "#8A8D86" }}
                    />
                  ))}
                </span>
                <span className="flex-1 truncate font-mono text-xs text-ink">{family.label}</span>
                <span className="font-mono text-xs tabular-nums text-ink-faint">{family.member_count}</span>
              </div>
              <div className="mt-0.5 truncate text-xs text-ink-faint">
                {spansMultipleTaxa ? (
                  <span className="text-signal">spans {family.taxon_names.length} taxa</span>
                ) : (
                  <span className="italic">{family.taxon_names[0] ?? "unclassified"}</span>
                )}
                {family.clustering_cutoff != null && (
                  <span className="ml-1 not-italic">· c{family.clustering_cutoff}</span>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
