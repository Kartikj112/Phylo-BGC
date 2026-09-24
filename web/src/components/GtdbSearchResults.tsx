"use client";

import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { searchBackbone, type TreeScope } from "@/lib/api-client";
import type { BackboneSearchHit } from "@/lib/api-types";
import { rankAbbreviation } from "@/lib/tree-logic";

/**
 * GTDB clades matching the search box, under it.
 *
 * The box filters the tree in the browser, which only knows the clades it
 * has loaded. With "All GTDB genomes" on that is a few hundred of GTDB's
 * quarter of a million, so typing "Micromonospora" matched nothing until
 * the reader had opened Actinomycetota, then Actinomycetes, then the order,
 * then the family — the exact walk a search exists to save. This asks the
 * server, which holds all of it, and opening a result loads the path to it
 * in one request.
 *
 * Offered with the switch off too: a result is the most direct way to learn
 * the switch exists, and picking one turns it on.
 */

export function useGtdbSearch(scope: TreeScope, query: string, enabled: boolean) {
  const [hits, setHits] = useState<BackboneSearchHit[] | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const needle = query.trim();
    if (!enabled || needle.length < 2) {
      setHits(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    // Debounced: it runs on keystrokes, and a scan of 250,000 names is not
    // free on a small host.
    const timer = setTimeout(() => {
      searchBackbone(scope, needle)
        .then((h) => !cancelled && setHits(h))
        .catch(() => !cancelled && setHits([]))
        .finally(() => !cancelled && setLoading(false));
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [scope, query, enabled]);
  return { hits, loading };
}

export function GtdbSearchResults({
  id,
  hits,
  loading,
  activeIndex,
  sourceLabel,
  backboneOn,
  treeMatchCount,
  onPick,
  onHover,
}: {
  id: string;
  hits: BackboneSearchHit[] | null;
  loading: boolean;
  activeIndex: number;
  sourceLabel: string;
  backboneOn: boolean;
  treeMatchCount: number | null | undefined;
  onPick: (hit: BackboneSearchHit) => void;
  onHover: (index: number) => void;
}) {
  return (
    <div
      // Clicks must not blur the input before they land.
      onMouseDown={(e) => e.preventDefault()}
      className="absolute left-0 top-full z-50 mt-1.5 w-[min(24rem,calc(100vw-1.5rem))] overflow-hidden rounded-md border border-chrome-line bg-chrome shadow-2xl"
    >
      {treeMatchCount != null && (
        <div className="border-b border-chrome-line px-3 py-2 text-[11px] text-chrome-ink-muted">
          {treeMatchCount === 0
            ? "Nothing in the tree on screen matches."
            : `${treeMatchCount} match${treeMatchCount === 1 ? "" : "es"} highlighted in the tree on screen.`}
        </div>
      )}
      <div className="flex items-center justify-between px-3 pb-1 pt-2 text-[10px] uppercase tracking-wider text-chrome-ink-faint">
        <span>Jump to a clade in {sourceLabel}</span>
        {loading && <Loader2 size={11} className="animate-spin" aria-label="Searching" />}
      </div>
      <ul id={id} role="listbox" aria-label={`Clades in ${sourceLabel}`} className="max-h-72 overflow-y-auto pb-1">
        {hits?.length === 0 && !loading && (
          <li className="px-3 py-2 text-xs text-chrome-ink-faint">No clade by that name.</li>
        )}
        {(hits ?? []).map((hit, i) => {
          const active = i === activeIndex;
          const parents = hit.lineage.slice(-2).join(" › ");
          return (
            <li key={hit.backbone_id} role="option" aria-selected={active} id={`${id}-${i}`}>
              <button
                type="button"
                tabIndex={-1}
                onClick={() => onPick(hit)}
                onMouseEnter={() => onHover(i)}
                className={`flex w-full items-start gap-2 px-3 py-1.5 text-left ${
                  active ? "bg-chrome-soft" : ""
                }`}
              >
                <span
                  title={hit.rank}
                  className="mt-0.5 inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-sm border border-chrome-line-strong text-[9px] font-semibold text-chrome-ink-muted"
                >
                  {rankAbbreviation(hit.rank) ?? "·"}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs text-chrome-ink">{hit.name}</span>
                  {parents && (
                    <span className="block truncate text-[10px] text-chrome-ink-faint">{parents}</span>
                  )}
                </span>
                <span className="flex flex-shrink-0 flex-col items-end">
                  <span className="font-mono text-[10px] tabular-nums text-chrome-ink-muted">
                    {hit.reference_genome_count.toLocaleString("en-US")} genomes
                  </span>
                  <span
                    className={`text-[10px] ${hit.in_corpus ? "text-chrome-accent" : "text-chrome-ink-faint"}`}
                  >
                    {hit.in_corpus
                      ? `${hit.corpus_genome_count.toLocaleString("en-US")} with BGC data`
                      : `${sourceLabel.split(" ")[0]} only`}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {!backboneOn && (
        <p className="border-t border-chrome-line px-3 py-2 text-[11px] leading-relaxed text-chrome-ink-faint">
          Opening one switches on <span className="text-chrome-ink-muted">All GTDB genomes</span>, so
          the clade is shown with everything around it.
        </p>
      )}
    </div>
  );
}
