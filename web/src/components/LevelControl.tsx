"use client";

import { Layers3 } from "lucide-react";
import { COLLAPSE_LEVELS, type CollapseLevel } from "@/lib/tree-logic";

interface LevelControlProps {
  activeLevel: CollapseLevel | null;
  availableRanks: Set<string>;
  onSelectLevel: (level: CollapseLevel) => void;
}

export function LevelControl({ activeLevel, availableRanks, onSelectLevel }: LevelControlProps) {
  return (
    <div>
      <div className="mb-2 flex items-center gap-1.5">
        <Layers3 size={12} className="text-chrome-ink-muted" />
        <span className="text-xs uppercase tracking-wider text-chrome-ink-muted">Show down to</span>
      </div>

      <div className="flex flex-col gap-0.5">
        {COLLAPSE_LEVELS.map((level) => {
          // Real taxonomies skip ranks, so a level absent from this
          // dataset is disabled rather than offered as a no-op button.
          const present = availableRanks.has(level.id);
          const active = activeLevel === level.id;
          return (
            <button
              key={level.id}
              onClick={() => onSelectLevel(level.id)}
              disabled={!present}
              title={present ? `Collapse the tree to ${level.label}` : `No ${level.label} rank in this dataset`}
              className={`flex items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors ${
                active
                  ? "bg-chrome-accent-wash text-chrome-accent"
                  : "text-chrome-ink hover:bg-chrome-soft"
              } ${present ? "" : "opacity-35"}`}
            >
              <span
                className={`inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-sm border text-[9px] font-semibold ${
                  active
                    ? "border-chrome-accent text-chrome-accent"
                    : "border-chrome-line-strong text-chrome-ink-muted"
                }`}
              >
                {level.badge}
              </span>
              <span className="flex-1">{level.label}</span>
            </button>
          );
        })}
      </div>

      <p className="mt-2 text-xs leading-relaxed text-chrome-ink-faint">
        Sets the depth for the whole tree; individual nodes can still be toggled afterwards. BGCs appear as
        marks on each genome rather than as nodes, so <span className="text-chrome-ink-muted">Genomes</span> is the
        deepest level.
      </p>
    </div>
  );
}
