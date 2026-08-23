"use client";

import { BGC_CLASS_COLORS, BGC_CLASS_LABELS, CLASS_ORDER } from "@/lib/colors";

interface ClassFilterRailProps {
  activeClasses: Set<string>;
  counts: Record<string, number>;
  onToggle: (cls: string) => void;
  onReset: () => void;
}

export function ClassFilterRail({ activeClasses, counts, onToggle, onReset }: ClassFilterRailProps) {
  return (
    <div className="flex w-52 flex-shrink-0 flex-col gap-1 border-r border-line p-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs uppercase tracking-wider text-ink-muted">BGC class</span>
        <button onClick={onReset} className="text-xs text-signal hover:underline">
          Reset
        </button>
      </div>

      {CLASS_ORDER.map((cls) => {
        const active = activeClasses.has(cls);
        const count = counts[cls] ?? 0;
        const color = BGC_CLASS_COLORS[cls] ?? "#8A8D86";
        return (
          <button
            key={cls}
            onClick={() => onToggle(cls)}
            disabled={count === 0}
            className={`flex items-center gap-2 rounded px-2 py-1.5 text-left transition-opacity ${
              active ? "bg-signal-wash" : ""
            }`}
            style={{ opacity: count === 0 ? 0.35 : active ? 1 : 0.45 }}
          >
            <span className="inline-block h-2.5 w-2.5 flex-shrink-0 rounded-full" style={{ backgroundColor: color }} />
            <span className="flex-1 text-sm text-ink">{BGC_CLASS_LABELS[cls] ?? cls}</span>
            <span className="font-mono text-xs tabular-nums text-ink-faint">{count}</span>
          </button>
        );
      })}
    </div>
  );
}
