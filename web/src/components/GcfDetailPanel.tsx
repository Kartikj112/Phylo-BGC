"use client";

import { GitCompareArrows, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { fetchFamily } from "@/lib/api-client";
import type { BGCFamilyDetail, BGCFamilySummary } from "@/lib/api-types";
import type { FamilyDistribution } from "@/lib/tree-logic";
import { BGC_CLASS_COLORS, BGC_CLASS_LABELS, COLORS } from "@/lib/colors";

/** Matches CLUSTERING_METHOD in engine/src/bgcscape/ingest/compound_groups.py. */
const COMPOUND_METHOD = "MIBiG shared compound";

interface GcfDetailPanelProps {
  familyId: string;
  family: BGCFamilySummary | undefined;
  distribution: FamilyDistribution | null;
  onClose: () => void;
  onSelectGenome: (genomeId: string) => void;
  onCompareEnclosing: () => void;
  canCompareEnclosing: boolean;
}

/**
 * LEVEL 3: the detail behind the summary bar and the tree. Nothing here is
 * needed for the first-glance read — it answers follow-up questions
 * (representative organisms, how concentrated, how broad, which clades
 * exactly) once the user has one.
 */
export function GcfDetailPanel({
  familyId,
  family,
  distribution,
  onClose,
  onSelectGenome,
  onCompareEnclosing,
  canCompareEnclosing,
}: GcfDetailPanelProps) {
  const [detail, setDetail] = useState<BGCFamilyDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAllMembers, setShowAllMembers] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDetail(null);
    setShowAllMembers(false);
    fetchFamily(familyId)
      .then((d) => !cancelled && setDetail(d))
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [familyId]);

  const members = useMemo(() => {
    const list = detail?.members ?? [];
    return [...list].sort((a, b) => (a.taxon_name ?? "").localeCompare(b.taxon_name ?? ""));
  }, [detail]);
  const shownMembers = showAllMembers ? members : members.slice(0, 12);

  const curated = (family?.evidence_level ?? detail?.evidence_level) === "observed_curated";

  /* Bottom sheet below `lg`, side column above — see DetailPanel. */
  return (
    <div className="flex w-full flex-shrink-0 flex-col border-t border-line bg-card absolute inset-x-0 bottom-0 z-30 max-h-[55dvh] shadow-[0_-8px_24px_rgba(28,30,27,0.18)] lg:static lg:inset-auto lg:z-auto lg:max-h-none lg:w-80 lg:border-l lg:border-t-0 lg:shadow-none">
      <div className="flex flex-shrink-0 items-start justify-between border-b border-line p-4">
        <div className="min-w-0">
          <div className="text-xs uppercase tracking-wider text-ink-muted">
            {family?.clustering_method === COMPOUND_METHOD ? "Compound group" : "Gene cluster family"}
          </div>
          <div className="mt-0.5 truncate font-mono text-sm text-ink">
            {family?.label ?? familyId.slice(0, 12)}
          </div>
        </div>
        <button onClick={onClose} aria-label="Close family panel" className="-m-1 p-1 text-ink-faint hover:text-ink">
          <X size={18} />
        </button>
      </div>

      <div className="chrome-scroll flex-1 overflow-y-auto overscroll-contain p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {/* Identity */}
        <div className="flex flex-wrap items-center gap-2">
          {(family?.bgc_classes ?? []).map((cls) => (
            <span key={cls} className="flex items-center gap-1 text-xs text-ink-muted">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ backgroundColor: BGC_CLASS_COLORS[cls] ?? "#8A8D86" }}
              />
              {BGC_CLASS_LABELS[cls] ?? cls}
            </span>
          ))}
        </div>
        <div
          className="mt-1.5 text-xs uppercase tracking-wide"
          style={{ color: curated ? COLORS.signal : COLORS.inkFaint }}
        >
          {family?.clustering_method === COMPOUND_METHOD
            ? "Grouped by shared curated compound"
            : curated
              ? "Curated reference family"
              : "Computed by sequence clustering"}
          {family?.clustering_method ? ` · ${family.clustering_method}` : ""}
          {family?.clustering_cutoff != null ? ` · cutoff ${family.clustering_cutoff}` : ""}
        </div>

        {/* Distribution shape */}
        {distribution && distribution.memberGenomeCount > 0 && (
          <div className="mt-4 border-t border-line pt-3">
            <div className="mb-2 text-xs uppercase tracking-wider text-ink-muted">
              Distribution shape
            </div>
            <p className="mb-3 text-xs leading-relaxed text-ink">{distribution.patternLabel}</p>

            <Meter
              label="Concentration"
              value={distribution.concentration}
              caption={
                distribution.dominantClade
                  ? `${Math.round(distribution.concentration * 100)}% of occurrences in ${
                      distribution.dominantClade.name
                    }`
                  : "confined to a single clade"
              }
            />
            {distribution.phylumBreadth != null && (
              <Meter
                label="Phylum breadth"
                value={distribution.phylumBreadth}
                caption={`${distribution.byRank.find((r) => r.rank === "phylum")?.containing ?? 0} of ${
                  distribution.byRank.find((r) => r.rank === "phylum")?.total ?? 0
                } phyla in the dataset`}
              />
            )}

            <div className="mt-3 flex flex-col gap-1.5">
              {distribution.byRank
                .filter((r) => r.rank !== "domain")
                .map((r) => (
                  <div key={r.rank} className="flex items-center gap-2 text-xs">
                    <span className="w-14 flex-shrink-0 capitalize text-ink-faint">{r.rank}</span>
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-line">
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${r.total ? (r.containing / r.total) * 100 : 0}%`,
                          backgroundColor: COLORS.present,
                        }}
                      />
                    </div>
                    <span className="w-12 flex-shrink-0 text-right font-mono tabular-nums text-ink">
                      {r.containing}
                      <span className="text-ink-faint">/{r.total}</span>
                    </span>
                  </div>
                ))}
            </div>
          </div>
        )}

        {/* Contained in */}
        {distribution && distribution.enclosingClades.length > 0 && (
          <div className="mt-4 border-t border-line pt-3">
            <div className="mb-1.5 text-xs uppercase tracking-wider text-ink-muted">
              {distribution.commonAncestor ? "Smallest containing clade" : "Disjoint occurrences in"}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {distribution.enclosingClades.map((c) => (
                <span
                  key={c.key}
                  className="rounded border border-line bg-paper px-1.5 py-0.5 text-xs text-ink"
                >
                  {c.name}
                  {c.rank ? <span className="text-ink-faint"> · {c.rank}</span> : null}
                  <span className="ml-1 font-mono text-ink-faint">{c.memberGenomes}g</span>
                </span>
              ))}
            </div>
            {canCompareEnclosing && (
              <button
                onClick={onCompareEnclosing}
                className="mt-2 flex items-center gap-1 text-xs text-signal hover:underline"
              >
                <GitCompareArrows size={11} />
                Compare these clades
              </button>
            )}
          </div>
        )}

        {/* Representative organisms */}
        <div className="mt-4 border-t border-line pt-3">
          <div className="mb-2 text-xs uppercase tracking-wider text-ink-muted">
            Member organisms {detail ? `(${members.length})` : ""}
          </div>
          {loading && <div className="text-xs text-ink-faint">Loading members…</div>}
          {error && <div className="text-xs text-red-700">{error}</div>}
          {!loading && !error && members.length === 0 && (
            <div className="text-xs text-ink-faint">No members recorded for this family.</div>
          )}
          <div className="flex flex-col gap-1">
            {shownMembers.map((m) => (
              <button
                key={m.bgc_id}
                onClick={() => onSelectGenome(m.genome_id)}
                className="flex items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-paper"
              >
                <span
                  className="inline-block h-2 w-2 flex-shrink-0 rounded-full"
                  style={{ backgroundColor: BGC_CLASS_COLORS[m.bgc_class] ?? "#8A8D86" }}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs italic text-ink">
                    {m.taxon_name ?? "unclassified"}
                  </span>
                  <span className="block truncate font-mono text-[11px] text-ink-faint">
                    {m.genome_accession}
                  </span>
                </span>
                {m.similarity_score != null && (
                  <span className="flex-shrink-0 font-mono text-[11px] tabular-nums text-ink-faint">
                    {m.similarity_score.toFixed(2)}
                  </span>
                )}
              </button>
            ))}
          </div>
          {members.length > 12 && (
            <button
              onClick={() => setShowAllMembers((v) => !v)}
              className="mt-1 text-xs text-signal hover:underline"
            >
              {showAllMembers ? "Show fewer" : `Show all ${members.length}`}
            </button>
          )}
        </div>

        <p className="mt-4 border-t border-line pt-3 text-[11px] leading-relaxed text-ink-faint">
          Distribution figures describe what is present in the loaded dataset. Absence from a clade
          reflects sampling and prediction coverage, not confirmed absence of the pathway.
        </p>
      </div>
    </div>
  );
}

function Meter({ label, value, caption }: { label: string; value: number; caption: string }) {
  return (
    <div className="mb-2">
      <div className="flex items-baseline justify-between">
        <span className="text-xs text-ink-muted">{label}</span>
        <span className="font-mono text-xs tabular-nums text-ink">{Math.round(value * 100)}%</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-line">
        <div
          className="h-full rounded-full"
          style={{ width: `${Math.min(100, Math.max(0, value * 100))}%`, backgroundColor: COLORS.present }}
        />
      </div>
      <div className="mt-0.5 text-[11px] leading-tight text-ink-faint">{caption}</div>
    </div>
  );
}
