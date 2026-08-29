"use client";

import { ChevronRight, Home } from "lucide-react";
import type { TaxonDisplayNode } from "@/lib/api-types";
import { rankAbbreviation } from "@/lib/tree-logic";

interface BreadcrumbsProps {
  path: TaxonDisplayNode[];
  focusLost: boolean;
  onNavigate: (key: string | null) => void;
}

/**
 * The trail out of focus mode. Without it, drilling into a clade is a
 * one-way trip — which is the failure that makes drill-down navigation
 * feel worse than scrolling rather than better.
 */
export function Breadcrumbs({ path, focusLost, onNavigate }: BreadcrumbsProps) {
  if (focusLost) {
    return (
      <div className="flex flex-wrap items-center gap-2 border-b border-chrome-line bg-amber-200/95 px-3 py-1.5 text-xs text-amber-950 sm:px-4">
        The focused clade isn&apos;t in the current view — it may have been filtered out. Showing the full
        tree.
        <button onClick={() => onNavigate(null)} className="font-medium text-amber-900 underline">
          Dismiss
        </button>
      </div>
    );
  }

  if (path.length === 0) return null;

  // Nowrap + horizontal scroll below `sm`: a deep lineage wrapped to three
  // or four rows on a phone and pushed the tree itself off the screen.

  return (
    <div className="flex flex-nowrap items-center gap-1 overflow-x-auto border-b border-chrome-line bg-chrome px-3 py-1.5 sm:flex-wrap sm:px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <button
        onClick={() => onNavigate(null)}
        className="flex flex-shrink-0 items-center gap-1 whitespace-nowrap py-1 text-xs text-chrome-ink-muted hover:text-chrome-accent"
        title="Back to the whole tree"
      >
        <Home size={11} />
        All
      </button>

      {path.map((node, index) => {
        const key = node.id ?? "__root__";
        const isLast = index === path.length - 1;
        const badge = rankAbbreviation(node.rank);
        // The synthetic root is already represented by "All".
        if (node.id === null) return null;
        return (
          <span key={key} className="flex flex-shrink-0 items-center gap-1">
            <ChevronRight size={11} className="text-chrome-ink-faint" />
            <button
              onClick={() => onNavigate(isLast ? null : key)}
              disabled={isLast}
              className={`flex items-center gap-1 whitespace-nowrap py-1 text-xs ${
                isLast ? "font-medium text-chrome-ink" : "text-chrome-ink-muted hover:text-chrome-accent"
              } ${node.rank === "species" ? "italic" : ""}`}
              title={isLast ? "Current focus" : `Focus on ${node.name}`}
            >
              {badge && (
                <span className="inline-flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded-sm border border-chrome-line-strong text-[8px] font-semibold not-italic text-chrome-ink-muted">
                  {badge}
                </span>
              )}
              {node.name}
            </button>
          </span>
        );
      })}

      <span className="ml-2 hidden flex-shrink-0 whitespace-nowrap font-mono text-xs text-chrome-ink-faint sm:inline">
        {path[path.length - 1]?.genome_count ?? 0} genomes in view
      </span>
    </div>
  );
}
