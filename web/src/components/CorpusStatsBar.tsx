"use client";

import { useEffect, useState } from "react";
import { fetchBgcTypeCounts, fetchProvenance, type TreeScope } from "@/lib/api-client";
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
  /** Which taxonomy is on screen. Every figure in this bar is scoped to it. */
  scope: TreeScope;
}

/**
 * What the taxonomy on screen contains: how many clusters, of what kinds,
 * over how many genomes.
 *
 * EVERY number here is scoped to `scope`, and the ones that describe the
 * dataset say what they are a fraction of. That is a correction, not a
 * flourish. This bar used to mix three different denominators without
 * saying so — whole database for clusters, taxa and the class strip;
 * current taxonomy for the genome total; current taxonomy after pruning for
 * genomes drawn — because it predates the prokaryote/eukaryote split and
 * was never taught about it. The visible result was that switching tabs
 * moved one number out of four, and the eukaryote view claimed 2,437
 * clusters over a tree holding 466.
 *
 * Worse, the class strip is also the class filter, and the filter operates
 * on the scoped tree: it read "PKS 1010" next to a left rail that read "PKS
 * 251" for the same class on the same screen, and the larger, wrong number
 * was the one wired to the control.
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
  scope,
}: CorpusStatsBarProps) {
  const [counts, setCounts] = useState<BGCTypeCount[] | null>(null);
  const [provenance, setProvenance] = useState<DatasetProvenanceResponse | null>(null);

  // Keyed on `scope`: this effect used to run once on mount, which is
  // precisely how the numbers came to be independent of the open tab.
  useEffect(() => {
    let cancelled = false;
    // Cleared first. Holding the previous taxonomy's figures on screen while
    // the new ones load would show a stats bar that disagrees with the tree
    // beside it — a milder version of the bug this is fixing.
    setCounts(null);
    setProvenance(null);
    Promise.all([fetchBgcTypeCounts(scope), fetchProvenance(scope)])
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
  }, [scope]);

  if (!counts || counts.length === 0) return null;

  const classTotal = counts.reduce((sum, c) => sum + c.count, 0);
  const clusterTotal = provenance?.bgc_count ?? classTotal;
  const corpusClusters = provenance?.corpus_bgc_count ?? clusterTotal;
  const hybridDoubleCount = classTotal - clusterTotal;
  const filtered = activeClasses.size < counts.length;
  const scopeLabel =
    scope === "eukaryote"
      ? "the eukaryote taxonomy"
      : scope === "prokaryote"
        ? "the prokaryote taxonomy"
        : "the corpus";

  return (
    <div
      data-tour="stats"
      className="flex flex-shrink-0 flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-chrome-line bg-chrome px-3 py-1.5 sm:gap-y-2 sm:gap-x-6 sm:px-4 sm:py-2"
    >
      <div className="-mx-3 flex w-full flex-nowrap items-center gap-x-4 overflow-x-auto px-3 sm:mx-0 sm:w-auto sm:flex-wrap sm:gap-x-5 sm:px-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {/* "N of M" on clusters and taxa, where M is the whole corpus: it is
            the only thing on screen that says a tab is a SLICE rather than
            the dataset. Genomes keeps its own pair — drawn of present in
            this taxonomy — because that is what the header states too, and
            because the rail's "Hiding 21 genome(s)…" sentence explains it.
            The two meanings are spelled out in the tooltips rather than left
            for a reader to infer, which is the failure being corrected. */}
        <Stat
          value={clusterTotal}
          of={corpusClusters !== clusterTotal ? corpusClusters : undefined}
          label="clusters"
          title={
            corpusClusters !== clusterTotal
              ? `${clusterTotal.toLocaleString()} clusters in ${scopeLabel}, of ${corpusClusters.toLocaleString()} in the whole corpus`
              : `${clusterTotal.toLocaleString()} clusters`
          }
        />
        <Stat
          value={shownGenomes}
          of={totalGenomes !== shownGenomes ? totalGenomes : undefined}
          label="genomes"
          title={
            totalGenomes !== shownGenomes
              ? `${shownGenomes.toLocaleString()} genomes drawn, of ${totalGenomes.toLocaleString()} in ${scopeLabel}. The rest carry no predicted clusters.`
              : `${shownGenomes.toLocaleString()} genomes in ${scopeLabel}`
          }
        />
        {provenance && (
          <Stat
            value={provenance.taxon_count}
            of={
              provenance.corpus_taxon_count !== provenance.taxon_count
                ? provenance.corpus_taxon_count
                : undefined
            }
            label="taxa"
            title={`${provenance.taxon_count.toLocaleString()} taxa in ${scopeLabel}, of ${provenance.corpus_taxon_count.toLocaleString()} in the whole corpus`}
          />
        )}
        <Stat
          value={counts.length}
          label="BGC classes"
          title={`${counts.length} biosynthetic classes are represented in ${scopeLabel}`}
        />
        {/* The denominator behind every absence on screen. Corpus-wide, not
            scoped: coverage is a property of the database, and reporting it
            per tab would invite a "this half was examined" reading of a
            number that never depended on the tab. */}
        {provenance && (
          <Stat
            value={provenance.examined_genome_count}
            of={provenance.corpus_genome_count}
            label="examined"
            title={provenance.coverage_note}
          />
        )}
      </div>

      {/* Proportional class strip — doubles as the class filter. */}
      <div className="flex w-full min-w-0 flex-col justify-center gap-1 sm:w-auto sm:min-w-[260px] sm:flex-1">
        <div className="flex h-4 w-full overflow-hidden rounded-sm sm:h-3">
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
        <div className="-mx-3 flex flex-nowrap items-center gap-x-3 overflow-x-auto px-3 sm:mx-0 sm:flex-wrap sm:gap-y-0.5 sm:px-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {counts.map((c) => {
            const active = activeClasses.has(c.bgc_class);
            return (
              <button
                key={c.bgc_class}
                onClick={() => onToggleClass(c.bgc_class)}
                className="flex flex-shrink-0 items-center gap-1 whitespace-nowrap py-0.5 text-[11px]"
                style={{ opacity: active ? 1 : 0.4 }}
              >
                <span
                  className="inline-block h-2 w-2 flex-shrink-0 rounded-full"
                  style={{ backgroundColor: BGC_CLASS_COLORS[c.bgc_class] ?? COLORS.inkFaint }}
                />
                <span className="text-chrome-ink">{BGC_CLASS_LABELS[c.bgc_class] ?? c.bgc_class}</span>
                <span className="font-mono tabular-nums text-chrome-ink-faint">{c.count}</span>
              </button>
            );
          })}
          {filtered && (
            <button onClick={onResetClasses} className="flex-shrink-0 whitespace-nowrap text-[11px] text-chrome-accent hover:underline">
              show all
            </button>
          )}
        </div>
      </div>

      {hybridDoubleCount > 0 && (
        <p className="w-full text-[10px] leading-tight text-chrome-ink-faint sm:w-auto sm:max-w-[15rem] sm:text-[11px]">
          {hybridDoubleCount} hybrid cluster{hybridDoubleCount === 1 ? "" : "s"} count under each
          component class, so the class figures total {classTotal}, not {clusterTotal}.
        </p>
      )}

      {/* Said once, at corpus level, rather than by greying out the tree.
          On a corpus where nothing has been examined every glyph would
          otherwise read as missing data, and "honest" would render as
          "broken" — but the fact still has to be stated somewhere a reader
          cannot miss, because it governs every absence in the figure. */}
      {provenance && provenance.examined_genome_count === 0 && (
        <p
          className="w-full text-[10px] leading-tight sm:text-[11px]"
          style={{ color: COLORS.signal }}
        >
          No genome in this corpus has been examined for clusters. Every cluster shown is a
          curated report, not a survey result — an empty clade here is not evidence that it
          produces nothing.
        </p>
      )}
    </div>
  );
}

function Stat({
  value,
  label,
  of,
  title,
}: {
  value: number;
  label: string;
  of?: number;
  /** Spells out what the two numbers are. A bare "1,971 / 2,437" is exactly
   * the kind of unexplained ratio that let the old bar mislead quietly. */
  title?: string;
}) {
  return (
    <div
      title={title}
      className="flex flex-shrink-0 flex-col items-start whitespace-nowrap leading-none"
    >
      <span className="font-mono text-sm font-semibold tabular-nums text-chrome-ink sm:text-base">
        {value.toLocaleString()}
        {of != null && (
          <span className="ml-0.5 text-[11px] font-normal text-chrome-ink-faint">
            / {of.toLocaleString()}
          </span>
        )}
      </span>
      <span className="mt-0.5 text-[9px] uppercase tracking-wider text-chrome-ink-faint sm:mt-1 sm:text-[10px]">
        {label}
      </span>
    </div>
  );
}
