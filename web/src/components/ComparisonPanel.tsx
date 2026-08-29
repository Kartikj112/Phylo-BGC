"use client";

import { AlertTriangle, X } from "lucide-react";
import { useEffect, useState } from "react";
import { fetchComparison } from "@/lib/api-client";
import type { CladeComparison } from "@/lib/api-types";
import { BGC_CLASS_COLORS, BGC_CLASS_LABELS, CLASS_ORDER } from "@/lib/colors";

interface ComparisonPanelProps {
  taxonIds: string[];
  onClose: () => void;
  onClearSelection: () => void;
}

export function ComparisonPanel({ taxonIds, onClose, onClearSelection }: ComparisonPanelProps) {
  const [data, setData] = useState<CladeComparison | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (taxonIds.length < 2) {
      setData(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchComparison(taxonIds)
      .then((result) => {
        if (!cancelled) setData(result);
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
  }, [taxonIds.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  if (taxonIds.length === 0) return null;

  return (
    <div className="flex max-h-[38dvh] flex-shrink-0 sm:max-h-[45dvh] flex-col border-t border-line bg-card pb-[env(safe-area-inset-bottom)]">
      <div className="flex flex-shrink-0 items-center justify-between border-b border-line px-4 py-2">
        <span className="text-xs uppercase tracking-wider text-ink-muted">
          Comparing {taxonIds.length} clade{taxonIds.length === 1 ? "" : "s"}
        </span>
        <div className="flex items-center gap-3">
          <button onClick={onClearSelection} className="text-xs text-signal hover:underline">
            Clear selection
          </button>
          <button onClick={onClose} aria-label="Close comparison" className="-m-1 p-1 text-ink-faint hover:text-ink">
            <X size={18} />
          </button>
        </div>
      </div>

      <div className="chrome-scroll overflow-y-auto overscroll-contain p-4">
        {taxonIds.length < 2 && (
          <div className="text-sm text-ink-muted">
            Select at least one more clade to compare. Shift-click a taxon label in the tree (on touch, tap the label and choose “Compare”).
          </div>
        )}
        {loading && <div className="text-sm text-ink-muted">Comparing…</div>}
        {error && <div className="text-sm text-red-700">{error}</div>}
        {data && <ComparisonTable data={data} />}
      </div>
    </div>
  );
}

function ComparisonTable({ data }: { data: CladeComparison }) {
  // Only show class rows that at least one clade actually has, so the
  // table doesn't fill with zeroes for classes nothing in the dataset
  // carries.
  const presentClasses = CLASS_ORDER.filter((cls) =>
    data.clades.some((c) => c.class_profile.some((e) => e.bgc_class === cls && e.count > 0)),
  );

  return (
    <div className="flex flex-col gap-4">
      {/* Caveats sit ABOVE the numbers, not below them: they change how
          the table should be read, so burying them under it would mean
          most readers form conclusions before seeing them. */}
      {!data.comparable && (
        <div className="flex gap-2 rounded border border-amber-300 bg-amber-50 p-3">
          <AlertTriangle size={16} className="mt-0.5 flex-shrink-0 text-amber-700" />
          <div className="text-xs leading-relaxed text-amber-900">
            <span className="font-semibold">Sampling is too thin or uneven for these numbers to support a
            claim about biology.</span>{" "}
            They&apos;re shown as a description of this dataset only.
          </div>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              <th className="border-b border-line py-1.5 pr-3 text-left text-xs font-medium uppercase tracking-wide text-ink-muted">
                Clade
              </th>
              {data.clades.map((clade) => (
                <th key={clade.taxon_id} className="border-b border-line px-3 py-1.5 text-left">
                  <span
                    className={`text-sm text-ink ${clade.rank === "species" ? "italic" : ""}`}
                  >
                    {clade.taxon_name}
                  </span>
                  <span className="ml-1 text-xs text-ink-faint">{clade.rank}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <MetricRow
              label="Genomes"
              values={data.clades.map((c) => String(c.genome_count))}
            />
            <MetricRow label="BGCs" values={data.clades.map((c) => String(c.bgc_count))} />
            <MetricRow
              label="BGCs / genome"
              emphasis
              values={data.clades.map((c) =>
                c.bgcs_per_genome == null ? "—" : c.bgcs_per_genome.toFixed(2),
              )}
            />
            <MetricRow label="Families" values={data.clades.map((c) => String(c.family_count))} />

            <tr>
              <td colSpan={data.clades.length + 1} className="pt-3 pb-1 text-xs uppercase tracking-wide text-ink-muted">
                BGC classes — per genome (count)
              </td>
            </tr>
            {presentClasses.map((cls) => (
              <tr key={cls}>
                <td className="py-1 pr-3">
                  <span className="flex items-center gap-1.5">
                    <span
                      className="inline-block h-2 w-2 flex-shrink-0 rounded-full"
                      style={{ backgroundColor: BGC_CLASS_COLORS[cls] ?? "#8A8D86" }}
                    />
                    <span className="text-sm text-ink">{BGC_CLASS_LABELS[cls] ?? cls}</span>
                  </span>
                </td>
                {data.clades.map((clade) => {
                  const entry = clade.class_profile.find((e) => e.bgc_class === cls);
                  return (
                    <td key={clade.taxon_id} className="px-3 py-1 font-mono text-xs tabular-nums text-ink">
                      {entry ? (
                        <>
                          {entry.per_genome?.toFixed(2) ?? "—"}
                          <span className="ml-1 text-ink-faint">({entry.count})</span>
                        </>
                      ) : (
                        <span className="text-ink-faint">—</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <div className="mb-1 text-xs uppercase tracking-wide text-ink-muted">
            Shared by all ({data.shared_families.length})
          </div>
          {data.shared_families.length === 0 ? (
            <div className="text-xs text-ink-faint">None</div>
          ) : (
            <div className="flex flex-wrap gap-1">
              {data.shared_families.map((f) => (
                <span key={f.id} className="rounded bg-paper px-1.5 py-0.5 font-mono text-xs text-ink">
                  {f.label}
                </span>
              ))}
            </div>
          )}
        </div>

        <div>
          <div className="mb-1 text-xs uppercase tracking-wide text-ink-muted">Only in one clade</div>
          <div className="flex flex-col gap-1">
            {data.clades
              .filter((c) => c.only_in_this_clade.length > 0)
              .map((clade) => (
                <div key={clade.taxon_id} className="text-xs">
                  <span className={`text-ink-muted ${clade.rank === "species" ? "italic" : ""}`}>
                    {clade.taxon_name}:
                  </span>{" "}
                  {clade.only_in_this_clade.map((f) => (
                    <span key={f.id} className="mr-1 font-mono text-ink">
                      {f.label}
                    </span>
                  ))}
                </div>
              ))}
            {data.clades.every((c) => c.only_in_this_clade.length === 0) && (
              <div className="text-xs text-ink-faint">None</div>
            )}
          </div>
        </div>
      </div>

      <div className="border-t border-line pt-3">
        <div className="mb-1 text-xs uppercase tracking-wide text-ink-muted">How to read this</div>
        <ul className="flex flex-col gap-1">
          {data.caveats.map((caveat, i) => (
            <li key={i} className="text-xs leading-relaxed text-ink-muted">
              · {caveat}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function MetricRow({ label, values, emphasis }: { label: string; values: string[]; emphasis?: boolean }) {
  return (
    <tr>
      <td className="py-1 pr-3 text-sm text-ink-muted">{label}</td>
      {values.map((value, i) => (
        <td
          key={i}
          className={`px-3 py-1 font-mono text-xs tabular-nums ${emphasis ? "font-medium text-ink" : "text-ink"}`}
        >
          {value}
        </td>
      ))}
    </tr>
  );
}
