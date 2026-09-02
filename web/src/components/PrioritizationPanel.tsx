"use client";

import { AlertTriangle, ChevronDown, ChevronRight, ListOrdered } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { fetchPrioritization } from "@/lib/api-client";
import type { ComponentScoreOut, PrioritizationOut, PrioritizationResponse } from "@/lib/api-types";
import { BGC_CLASS_COLORS, BGC_CLASS_LABELS, COLORS } from "@/lib/colors";

/**
 * Which clusters to look at first — the engine's §8 prioritization, which
 * has worked end to end (scorer, API, CLI) with no interface at all.
 *
 * The design problem this panel has, and why it looks the way it does:
 * **a refusal is the engine's most important output, and a ranking UI is
 * the natural place to hide one.** The scorer declines to score a cluster
 * whenever fewer than two of its five components can be computed, and on a
 * curated corpus with no analysis coverage that is every cluster. A panel
 * that listed only the rows with numbers would show an empty list where the
 * engine had actually said something precise and useful — that the corpus
 * cannot support a ranking, and exactly which evidence is missing.
 *
 * So unscored rows are first-class here: they are listed, counted, and each
 * one names the components that could not be computed. The corpus caveats
 * are shown before the list rather than folded away under it, because they
 * govern how every row in it should be read.
 *
 * Nothing here is labelled "novelty". The engine refuses that framing (see
 * scoring/prioritization.py) and so does this.
 */

interface PrioritizationPanelProps {
  /** Jump to a cluster on the tree. The ranking is only useful if it can
   * hand off to the thing being ranked. */
  onSelectBgc?: (bgcId: string) => void;
  selectedBgcId?: string | null;
}

const HOW_MANY = 25;

export function PrioritizationPanel({ onSelectBgc, selectedBgcId }: PrioritizationPanelProps) {
  const [data, setData] = useState<PrioritizationResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showCaveats, setShowCaveats] = useState(false);

  // Fetched on first open, not on mount: this is a scan over every cluster
  // in the corpus, and the rail has four other sections a reader is far
  // more likely to touch first.
  //
  // "Have we asked yet" is a ref, not the `loading` state, and that is not a
  // style preference. Guarding on `loading` means `loading` has to be in the
  // dependency array, so `setLoading(true)` re-runs the effect — which fires
  // the previous run's cleanup, sets `cancelled = true` on the request that
  // is still in flight, and throws its result away. The panel then sits on
  // "Scoring the corpus…" forever against an endpoint answering in under a
  // second. Observed, not theorised.
  const requested = useRef(false);
  useEffect(() => {
    if (!open || requested.current) return;
    requested.current = true;
    let cancelled = false;
    setLoading(true);
    fetchPrioritization(HOW_MANY)
      .then((d) => !cancelled && setData(d))
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        // Let a reopen retry a failure; a successful load is cached by `data`.
        requested.current = false;
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [open]);

  const { scored, unscored } = useMemo(() => {
    const rows = data?.results ?? [];
    return {
      scored: rows.filter((r) => r.score !== null),
      unscored: rows.filter((r) => r.score === null),
    };
  }, [data]);

  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 py-1 text-left"
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown size={13} className="flex-shrink-0 text-chrome-ink-faint" />
        ) : (
          <ChevronRight size={13} className="flex-shrink-0 text-chrome-ink-faint" />
        )}
        <ListOrdered size={13} className="flex-shrink-0 text-chrome-ink-faint" />
        <span className="text-xs uppercase tracking-wider text-chrome-ink-muted">
          Where to look first
        </span>
      </button>

      {!open && (
        <p className="mb-2 pl-6 text-xs leading-relaxed text-chrome-ink-faint">
          Rank clusters as candidates for follow-up. A ranking hint, never a novelty claim.
        </p>
      )}

      {open && (
        <div className="mt-1">
          {loading && <p className="py-2 text-xs text-chrome-ink-faint">Scoring the corpus…</p>}
          {error && (
            <p className="py-2 text-xs leading-relaxed" style={{ color: COLORS.signal }}>
              Could not load the ranking: {error}
            </p>
          )}

          {data && (
            <>
              {/* Stated before the list, not after it: these govern how every
                  row below should be read, and a caveat a reader reaches only
                  by scrolling past the numbers has already failed. */}
              <div className="mb-2 rounded border border-chrome-line bg-chrome-soft p-2">
                <div className="text-[11px] leading-relaxed text-chrome-ink-muted">
                  {scored.length > 0 ? (
                    <>
                      A ranking <strong>hint</strong> over {data.corpus_bgc_count.toLocaleString()}{" "}
                      clusters — not a novelty measurement, and not a probability.
                    </>
                  ) : (
                    <>
                      <strong>No cluster in this corpus can be ranked.</strong> The scorer needs at
                      least two of its five components, and this corpus supports one. That is a
                      finding about the evidence available, not a failure to compute.
                    </>
                  )}
                </div>
                <button
                  onClick={() => setShowCaveats((v) => !v)}
                  className="mt-1.5 text-[11px] text-chrome-accent hover:underline"
                >
                  {showCaveats ? "Hide" : `Why (${data.caveats.length})`}
                </button>
                {showCaveats && (
                  <ul className="mt-1.5 flex flex-col gap-1.5">
                    {data.caveats.map((c, i) => (
                      <li
                        key={i}
                        className="text-[11px] leading-relaxed text-chrome-ink-faint"
                        style={c.startsWith("DENOMINATOR") ? { color: COLORS.signal } : undefined}
                      >
                        {c}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {scored.length > 0 && (
                <ol className="flex flex-col gap-1">
                  {scored.map((row, i) => (
                    <Row
                      key={row.bgc_id}
                      row={row}
                      rank={i + 1}
                      expanded={expanded === row.bgc_id}
                      selected={selectedBgcId === row.bgc_id}
                      onToggle={() => setExpanded(expanded === row.bgc_id ? null : row.bgc_id)}
                      onSelect={() => onSelectBgc?.(row.bgc_id)}
                    />
                  ))}
                </ol>
              )}

              {/* Not hidden, and not a footnote. On this corpus it is the
                  entire result, and even where it is not, "these could not be
                  assessed" is a different and equally real answer. */}
              {unscored.length > 0 && (
                <div className={scored.length > 0 ? "mt-3" : ""}>
                  <div className="mb-1 flex items-center gap-1.5">
                    <AlertTriangle size={11} className="flex-shrink-0 text-chrome-ink-faint" />
                    <span className="text-[11px] uppercase tracking-wider text-chrome-ink-muted">
                      Could not be scored ({unscored.length})
                    </span>
                  </div>
                  <ol className="flex flex-col gap-1">
                    {unscored.map((row) => (
                      <Row
                        key={row.bgc_id}
                        row={row}
                        expanded={expanded === row.bgc_id}
                        selected={selectedBgcId === row.bgc_id}
                        onToggle={() => setExpanded(expanded === row.bgc_id ? null : row.bgc_id)}
                        onSelect={() => onSelectBgc?.(row.bgc_id)}
                      />
                    ))}
                  </ol>
                </div>
              )}

              <p className="mt-2 text-[11px] leading-relaxed text-chrome-ink-faint">
                Showing {data.results.length} of {data.corpus_bgc_count.toLocaleString()} clusters.
                Weights are uniform and uncalibrated by design — `bgcscape prioritize` takes your
                own.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Row({
  row,
  rank,
  expanded,
  selected,
  onToggle,
  onSelect,
}: {
  row: PrioritizationOut;
  rank?: number;
  expanded: boolean;
  selected: boolean;
  onToggle: () => void;
  onSelect: () => void;
}) {
  const colour = BGC_CLASS_COLORS[row.bgc_class] ?? COLORS.inkFaint;
  return (
    <li
      className="rounded border px-1.5 py-1"
      style={{
        borderColor: selected ? COLORS.signal : "transparent",
        backgroundColor: selected ? COLORS.signalWash : "transparent",
      }}
    >
      <div className="flex items-center gap-1.5">
        {rank != null && (
          <span className="w-4 flex-shrink-0 text-right font-mono text-[10px] tabular-nums text-chrome-ink-faint">
            {rank}
          </span>
        )}
        <span
          className="inline-block h-2 w-2 flex-shrink-0 rounded-full"
          style={{ backgroundColor: colour }}
        />
        <button
          onClick={onSelect}
          className="min-w-0 flex-1 truncate text-left text-xs text-chrome-ink hover:underline"
          title={`${row.genome_accession}${row.taxon_name ? ` — ${row.taxon_name}` : ""}`}
        >
          {row.taxon_name ?? row.genome_accession}
        </button>
        <span className="flex-shrink-0 font-mono text-[10px] tabular-nums text-chrome-ink-faint">
          {/* An em dash, never 0.00. A cluster that could not be assessed has
              no score, and printing a number there would be the one thing
              this whole module refuses to do. */}
          {row.score === null ? "—" : row.score.toFixed(2)}
        </span>
        <button
          onClick={onToggle}
          aria-label={expanded ? "Hide components" : "Show components"}
          className="flex-shrink-0 text-chrome-ink-faint hover:text-chrome-ink"
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
      </div>

      {expanded && (
        <div className="mt-1.5 pl-6">
          <div className="mb-1 font-mono text-[10px] text-chrome-ink-faint">
            {row.genome_accession} · {BGC_CLASS_LABELS[row.bgc_class] ?? row.bgc_class}
          </div>
          <ul className="flex flex-col gap-1">
            {row.components.map((c) => (
              <Component key={c.name} component={c} />
            ))}
          </ul>
          {row.caveats.length > 0 && (
            <ul className="mt-1.5 flex flex-col gap-1">
              {row.caveats.map((c, i) => (
                <li key={i} className="text-[10px] leading-relaxed" style={{ color: COLORS.signal }}>
                  {c}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

/** One signal, with its explanation. An unavailable component shows its
 * reason rather than a bar — the reason is the finding. */
function Component({ component }: { component: ComponentScoreOut }) {
  const label = component.name.replace(/_/g, " ");
  return (
    <li>
      <div className="flex items-center gap-1.5">
        <span className="w-[5.5rem] flex-shrink-0 truncate text-[10px] text-chrome-ink-muted">
          {label}
        </span>
        {component.available && component.value != null ? (
          <>
            <span className="h-1 flex-1 rounded-sm bg-chrome-line">
              <span
                className="block h-1 rounded-sm"
                style={{
                  width: `${Math.round(component.value * 100)}%`,
                  backgroundColor: COLORS.signal,
                }}
              />
            </span>
            <span className="w-6 flex-shrink-0 text-right font-mono text-[10px] tabular-nums text-chrome-ink-faint">
              {component.value.toFixed(2)}
            </span>
          </>
        ) : (
          <span className="flex-1 text-[10px] uppercase tracking-wider text-chrome-ink-faint">
            not computable
          </span>
        )}
      </div>
      <div className="mt-0.5 text-[10px] leading-relaxed text-chrome-ink-faint">
        {component.explanation}
      </div>
    </li>
  );
}
