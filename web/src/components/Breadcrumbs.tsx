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
      <div className="flex items-center gap-2 border-b border-line bg-amber-50 px-4 py-1.5 text-xs text-amber-900">
        The focused clade isn&apos;t in the current view — it may have been filtered out. Showing the full
        tree.
        <button onClick={() => onNavigate(null)} className="text-signal hover:underline">
          Dismiss
        </button>
      </div>
    );
  }

  if (path.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1 border-b border-line bg-card px-4 py-1.5">
      <button
        onClick={() => onNavigate(null)}
        className="flex items-center gap-1 text-xs text-ink-muted hover:text-signal"
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
          <span key={key} className="flex items-center gap-1">
            <ChevronRight size={11} className="text-ink-faint" />
            <button
              onClick={() => onNavigate(isLast ? null : key)}
              disabled={isLast}
              className={`flex items-center gap-1 text-xs ${
                isLast ? "font-medium text-ink" : "text-ink-muted hover:text-signal"
              } ${node.rank === "species" ? "italic" : ""}`}
              title={isLast ? "Current focus" : `Focus on ${node.name}`}
            >
              {badge && (
                <span className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-sm border border-line-strong text-[8px] font-semibold not-italic text-ink-muted">
                  {badge}
                </span>
              )}
              {node.name}
            </button>
          </span>
        );
      })}

      <span className="ml-2 font-mono text-xs text-ink-faint">
        {path[path.length - 1]?.genome_count ?? 0} genomes in view
      </span>
    </div>
  );
}
