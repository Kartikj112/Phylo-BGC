"use client";

import { Palette } from "lucide-react";
import { useState } from "react";
import { RailHeading } from "@/components/RailHeading";
import { BGC_CLASS_COLORS, BGC_CLASS_LABELS, CLASS_ORDER } from "@/lib/colors";

interface ClassFilterRailProps {
  activeClasses: Set<string>;
  counts: Record<string, number>;
  /** The corpus's own class vocabulary, from `/api/v1/bgc-classes`.
   *
   * This rail used to iterate `CLASS_ORDER` alone — the keys of the
   * hardcoded palette in colors.ts. A class the corpus contains but the
   * palette does not would be counted by `countBgcClasses` and then never
   * rendered: no row, no toggle, no way to see or filter its clusters. The
   * vocabulary is not fixed by design (that is the whole reason
   * `native_enum=False` was chosen for `BGCClass` — see ARCHITECTURE.md),
   * so the rail asks the API what exists rather than assuming its palette
   * is exhaustive. */
  vocabulary?: string[];
  onToggle: (cls: string) => void;
  onReset: () => void;
}

export function ClassFilterRail({
  activeClasses,
  counts,
  vocabulary,
  onToggle,
  onReset,
}: ClassFilterRailProps) {
  // Palette order first, so the familiar rail does not reshuffle; anything
  // the corpus has that the palette lacks is appended rather than dropped.
  const extra = (vocabulary ?? []).filter((cls) => !CLASS_ORDER.includes(cls));
  const classes = [...CLASS_ORDER, ...extra];
  const [open, setOpen] = useState(true);
  const shown = classes.filter((cls) => activeClasses.has(cls) && (counts[cls] ?? 0) > 0).length;
  const present = classes.filter((cls) => (counts[cls] ?? 0) > 0).length;

  return (
    <div className="flex flex-col gap-1">
      <div className="mb-1">
        <RailHeading
          icon={<Palette size={12} />}
          title="BGC class"
          open={open}
          onToggle={() => setOpen((v) => !v)}
          summary={shown >= present ? "all shown" : `${shown} of ${present} shown`}
          action={
            <button onClick={onReset} className="py-1 text-xs text-chrome-accent hover:underline">
              Reset
            </button>
          }
        />
      </div>

      {open && classes.map((cls) => {
        const active = activeClasses.has(cls);
        const count = counts[cls] ?? 0;
        const color = BGC_CLASS_COLORS[cls] ?? "#8A8D86";
        return (
          <button
            key={cls}
            /* Named hooks, matching the `data-canvas-bg` / `data-figure-root`
               convention already used for the canvas: the active state is
               carried by a background utility class, which is not a stable
               thing for a test — or a future restyle — to key on. */
            data-class-filter={cls}
            data-active={active ? "true" : "false"}
            onClick={() => onToggle(cls)}
            disabled={count === 0}
            className={`flex items-center gap-2 rounded px-2 py-2 text-left transition-opacity ${
              active ? "bg-chrome-accent-wash" : "hover:bg-chrome-soft"
            }`}
            style={{ opacity: count === 0 ? 0.35 : active ? 1 : 0.45 }}
          >
            <span className="inline-block h-2.5 w-2.5 flex-shrink-0 rounded-full" style={{ backgroundColor: color }} />
            <span className="flex-1 text-sm text-chrome-ink">{BGC_CLASS_LABELS[cls] ?? cls}</span>
            <span className="font-mono text-xs tabular-nums text-chrome-ink-faint">{count}</span>
          </button>
        );
      })}

      {open && extra.length > 0 && (
        <p className="mt-1.5 text-[11px] leading-relaxed text-chrome-ink-faint">
          {extra.length} class{extra.length === 1 ? "" : "es"} in this corpus{" "}
          {extra.length === 1 ? "has" : "have"} no assigned colour yet and{" "}
          {extra.length === 1 ? "is" : "are"} drawn in grey.
        </p>
      )}
    </div>
  );
}
