"use client";

import { GitCompareArrows, Layers, Maximize2, Minimize2, X } from "lucide-react";
import type { BGCFamilySummary } from "@/lib/api-types";
import type { FamilyDistribution } from "@/lib/tree-logic";
import { BGC_CLASS_COLORS, BGC_CLASS_LABELS } from "@/lib/colors";

interface DistributionSummaryBarProps {
  family: BGCFamilySummary | undefined;
  distribution: FamilyDistribution | null;
  autoFramed: boolean;
  onToggleFraming: () => void;
  onCompareEnclosing: () => void;
  canCompareEnclosing: boolean;
  onClear: () => void;
}

/**
 * LEVEL 1 of the information hierarchy: the answer to "where is this GCF on
 * the tree, and what does its distribution look like" in one glance, before
 * the eye reaches the tree itself.
 *
 * Every number is paired with the biological question it answers (genomes /
 * species / genera / phyla / prevalence), and the pattern line is strictly
 * descriptive — see tree-logic.ts's familyDistribution.
 */
export function DistributionSummaryBar({
  family,
  distribution,
  autoFramed,
  onToggleFraming,
  onCompareEnclosing,
  canCompareEnclosing,
  onClear,
}: DistributionSummaryBarProps) {
  if (!distribution) return null;

  const rank = (r: string) => distribution.byRank.find((x) => x.rank === r);
  const species = rank("species");
  const genera = rank("genus");
  const phyla = rank("phylum");
  const prevalencePct = distribution.prevalence * 100;
  const empty = distribution.memberGenomeCount === 0;

  return (
    <div className="flex flex-shrink-0 flex-wrap items-stretch gap-x-4 gap-y-2.5 border-b border-chrome-line bg-chrome px-3 py-2.5 sm:gap-x-6 sm:px-4">
      {/* Identity */}
      <div className="flex min-w-0 flex-col justify-center">
        <div className="flex items-center gap-2">
          <Layers size={13} className="flex-shrink-0 text-chrome-accent" />
          <span className="truncate font-mono text-sm font-semibold text-chrome-ink">
            {family?.label ?? distribution.familyId.slice(0, 8)}
          </span>
          {family?.clustering_cutoff != null && (
            <span className="font-mono text-xs text-chrome-ink-faint">c{family.clustering_cutoff}</span>
          )}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5">
          {(family?.bgc_classes ?? []).slice(0, 4).map((cls) => (
            <span key={cls} className="flex items-center gap-1 text-xs text-chrome-ink-muted">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ backgroundColor: BGC_CLASS_COLORS[cls] ?? "#8A8D86" }}
              />
              {BGC_CLASS_LABELS[cls] ?? cls}
            </span>
          ))}
          <span className="text-xs text-chrome-ink-faint">· {distribution.memberBgcCount} BGCs</span>
        </div>
      </div>

      {/* Stat strip — every count answers a biological question */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 sm:gap-5">
        <Stat value={distribution.memberGenomeCount} label="genomes" of={distribution.totalGenomes} />
        {species && <Stat value={species.containing} label="species" of={species.total} />}
        {genera && <Stat value={genera.containing} label="genera" of={genera.total} />}
        {phyla && <Stat value={phyla.containing} label="phyla" of={phyla.total} />}
        <Stat
          value={`${prevalencePct < 1 && prevalencePct > 0 ? "<1" : Math.round(prevalencePct)}%`}
          label="of genomes"
          title={`Present in ${distribution.memberGenomeCount} of ${distribution.totalGenomes} genomes in the dataset`}
        />
      </div>

      {/* Pattern read-out — descriptive, never an evolutionary claim */}
      <div className="flex w-full min-w-0 items-center sm:w-auto sm:flex-1">
        <p className="text-xs leading-snug text-chrome-ink-muted">
          <span className="uppercase tracking-wider text-chrome-ink-faint">Distribution&nbsp;</span>
          {empty ? (
            <span>
              This family has no occurrences in the loaded tree — it may sit on genomes that GTDB
              taxonomy hasn&apos;t placed, or the tree may be filtered.
            </span>
          ) : (
            <span className="text-chrome-ink">{distribution.patternLabel}</span>
          )}
        </p>
      </div>

      {/* Actions */}
      <div className="ml-auto flex items-center gap-2">
        <button
          onClick={onToggleFraming}
          title={
            autoFramed
              ? "Currently framing the containing lineages — click to show the whole tree"
              : "Frame the tree on the lineages that contain this family"
          }
          className="flex items-center gap-1 rounded border border-chrome-line px-2 py-1.5 text-xs text-chrome-ink-muted hover:border-chrome-line-strong hover:bg-chrome-soft hover:text-chrome-ink"
        >
          {autoFramed ? <Maximize2 size={11} /> : <Minimize2 size={11} />}
          {autoFramed ? "Whole tree" : "Frame"}
        </button>
        <button
          onClick={onCompareEnclosing}
          disabled={!canCompareEnclosing}
          title="Load the containing clades into the clade comparison"
          className="flex items-center gap-1 rounded border border-chrome-line px-2 py-1.5 text-xs text-chrome-ink-muted hover:border-chrome-line-strong hover:bg-chrome-soft hover:text-chrome-ink disabled:opacity-40"
        >
          <GitCompareArrows size={11} />
          Compare
        </button>
        <button
          onClick={onClear}
          aria-label="Clear selected family"
          className="p-1 text-chrome-ink-faint hover:text-chrome-ink"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
}

function Stat({
  value,
  label,
  of,
  title,
}: {
  value: number | string;
  label: string;
  of?: number;
  title?: string;
}) {
  return (
    <div className="flex flex-col items-start leading-none" title={title}>
      <span className="font-mono text-lg font-semibold tabular-nums text-chrome-ink">
        {value}
        {of != null && <span className="ml-0.5 text-xs font-normal text-chrome-ink-faint">/ {of}</span>}
      </span>
      <span className="mt-1 text-[10px] uppercase tracking-wider text-chrome-ink-faint">{label}</span>
    </div>
  );
}
