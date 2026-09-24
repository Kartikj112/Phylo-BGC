"use client";

import { ChevronDown, ChevronRight } from "lucide-react";

/**
 * The heading of a left-rail section, which folds the section away.
 *
 * The rail holds five sections, and on a laptop the last two (the class
 * filter and the genome filters) started below the fold, under a family
 * list a reader may never use. Every section now folds the same way "Where
 * to look first" already did, and a folded one keeps a one-line summary of
 * its state, so folding never hides that a filter is on.
 */
export function RailHeading({
  icon,
  title,
  open,
  onToggle,
  summary,
  action,
}: {
  icon?: React.ReactNode;
  title: string;
  open: boolean;
  onToggle: () => void;
  /** Shown beside the title while folded: what the section is set to. */
  summary?: React.ReactNode;
  /** A control on the right of the heading (Reset, Clear), shown open. */
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-chrome-accent"
      >
        {open ? (
          <ChevronDown size={13} className="flex-shrink-0 text-chrome-ink-faint" aria-hidden />
        ) : (
          <ChevronRight size={13} className="flex-shrink-0 text-chrome-ink-faint" aria-hidden />
        )}
        {icon && <span className="flex-shrink-0 text-chrome-ink-muted">{icon}</span>}
        <span className="text-xs uppercase tracking-wider text-chrome-ink-muted">{title}</span>
        {!open && summary && (
          <span className="ml-auto min-w-0 truncate pl-2 text-[11px] normal-case tracking-normal text-chrome-ink-faint">
            {summary}
          </span>
        )}
      </button>
      {open && action}
    </div>
  );
}
