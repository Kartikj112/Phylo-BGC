"use client";

import { ChevronDown, ChevronUp, Loader2, RotateCw, Search } from "lucide-react";
import { COLORS } from "@/lib/colors";

/**
 * What "All GTDB genomes" is doing, on the canvas it changes.
 *
 * This used to be one long sentence in the stats bar, at 11px, under two
 * other caveats: accurate, and easy to never read. The switch changes the
 * tree more than any other control — from ~1,100 genomes to ~900,000, most
 * of them drawn as clades nobody has opened — so the explanation sits
 * beside the tree, says how to move through it, and offers the way back.
 *
 * It folds to one line once read, since it would otherwise cover the top of
 * the figure for as long as the mode is on.
 */
export function BackboneGuide({
  sourceLabel,
  referenceGenomes,
  referenceSpecies,
  corpusGenomes,
  loading,
  error,
  revealing,
  collapsed,
  onToggleCollapsed,
  onRetry,
  onTurnOff,
}: {
  sourceLabel: string;
  referenceGenomes: number;
  referenceSpecies: number;
  corpusGenomes: number;
  loading: boolean;
  error: Error | null;
  /** Name of the clade a search result is opening, while it loads. */
  revealing: string | null;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onRetry: () => void;
  onTurnOff: () => void;
}) {
  const shell =
    "pointer-events-auto w-[min(22rem,calc(100vw-2rem))] rounded border border-line bg-card/95 shadow-sm backdrop-blur-[1px]";

  if (error) {
    return (
      <div role="alert" className={`${shell} px-3 py-2.5`}>
        <p className="text-xs font-semibold text-ink">Couldn&apos;t load {sourceLabel}</p>
        <p className="mt-1 text-[11px] leading-relaxed text-ink-muted">{error.message}</p>
        <div className="mt-2 flex gap-2">
          <button
            onClick={onRetry}
            className="flex items-center gap-1 rounded border border-line px-2 py-1 text-[11px] text-ink hover:bg-paper"
          >
            <RotateCw size={11} aria-hidden /> Try again
          </button>
          <button onClick={onTurnOff} className="rounded px-2 py-1 text-[11px] text-ink-muted hover:text-ink">
            Back to the BGC corpus
          </button>
        </div>
      </div>
    );
  }

  if (loading || revealing) {
    return (
      <div role="status" className={`${shell} flex items-center gap-2 px-3 py-2`}>
        <Loader2 size={13} className="animate-spin text-signal" aria-hidden />
        <span className="text-xs text-ink">
          {revealing ? `Opening ${revealing}…` : `Loading the ${sourceLabel} taxonomy…`}
        </span>
      </div>
    );
  }

  return (
    <div className={shell}>
      <button
        onClick={onToggleCollapsed}
        aria-expanded={!collapsed}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left"
      >
        <span className="text-xs font-semibold text-ink">
          All of {sourceLabel}
          <span className="ml-1.5 font-mono text-[11px] font-normal text-ink-faint">
            {referenceGenomes.toLocaleString("en-US")} genomes
          </span>
        </span>
        {collapsed ? (
          <ChevronDown size={14} className="text-ink-faint" aria-label="Show the guide" />
        ) : (
          <ChevronUp size={14} className="text-ink-faint" aria-label="Fold the guide" />
        )}
      </button>

      {!collapsed && (
        <div className="border-t border-line px-3 pb-3 pt-2 text-[11px] leading-relaxed text-ink-muted">
          <p>
            {referenceGenomes.toLocaleString("en-US")} genomes in{" "}
            {referenceSpecies.toLocaleString("en-US")} species, drawn behind the{" "}
            {corpusGenomes.toLocaleString("en-US")} genomes this corpus has BGC records for. None of
            the other {sourceLabel.split(" ")[0]} genomes has been examined for clusters.
          </p>
          <ul className="mt-2 space-y-1">
            <li className="flex items-center gap-2">
              <span className="inline-block h-[3px] w-5 flex-shrink-0 rounded" style={{ background: COLORS.ink }} />
              <span>Clade with genomes in the corpus</span>
            </li>
            <li className="flex items-center gap-2">
              <span
                className="inline-block w-5 flex-shrink-0 border-t border-dashed"
                style={{ borderColor: COLORS.inkFaint }}
              />
              <span>In {sourceLabel.split(" ")[0]} only: nothing has looked</span>
            </li>
          </ul>
          <ul className="mt-2 space-y-0.5 text-ink">
            <li>
              <span className="font-medium">Click a clade</span>{" "}
              <span className="text-ink-muted">to load what is inside it.</span>
            </li>
            <li className="flex items-center gap-1">
              <Search size={11} aria-hidden className="text-ink-faint" />
              <span className="font-medium">Search</span>{" "}
              <span className="text-ink-muted">to jump to any {sourceLabel.split(" ")[0]} clade.</span>
            </li>
          </ul>
          <button
            onClick={onTurnOff}
            className="mt-2.5 rounded border border-line px-2 py-1 text-[11px] text-ink hover:bg-paper"
          >
            Back to the BGC corpus only
          </button>
        </div>
      )}
    </div>
  );
}
