"use client";

import { PanelLeft, Search, X } from "lucide-react";

interface HeaderProps {
  query: string;
  onQueryChange: (query: string) => void;
  genomeCount: number;
  totalGenomes?: number;
  matchCount?: number | null;
  /** Matches the SERVER found that are not in the tree on screen.
   *
   * The header searches the loaded tree, which is the right default — it
   * matches compound names, MIBiG accessions and cluster classes, none of
   * which the search endpoint covers. But the tree on screen is pruned to
   * BGC-bearing genomes by default and scoped to one taxonomy, so a genome
   * that is genuinely in the database can match nothing and read as "no
   * matches". That is the same failure the match count itself was added to
   * fix, one level further out. */
  offTreeMatchCount?: number | null;
  /** Which taxonomy the tree on screen came from. Not decoration: the
   * eukaryote view is NCBI, the prokaryote view is GTDB, and labelling both
   * "GTDB" would misattribute half the corpus. */
  taxonomyLabel?: string;
  /** Mobile only: opens/closes the off-canvas filter rail. Below `lg` the
   * rail is a drawer, so the header carries its handle. */
  railOpen?: boolean;
  onToggleRail?: () => void;
  /** Back to the landing choice (browse the tree / analyze antiSMASH
   * results). The wordmark is the only affordance for it, which is the
   * convention every site has trained readers on. */
  onHome?: () => void;
  children?: React.ReactNode;
}

export function Header({
  query,
  onQueryChange,
  genomeCount,
  totalGenomes,
  matchCount,
  offTreeMatchCount,
  taxonomyLabel = "GTDB",
  railOpen = false,
  onToggleRail,
  onHome,
  children,
}: HeaderProps) {
  return (
    <div className="flex flex-shrink-0 flex-col gap-1.5 border-b border-chrome-line bg-chrome px-3 py-1.5 pt-[max(0.375rem,env(safe-area-inset-top))] sm:gap-2 sm:px-4 sm:py-3 lg:flex-row lg:items-center lg:gap-4">
      {/* Row 1 on small screens, left group on large: identity + search.
          These two are the only things that must always be reachable, so
          they never move into the scrolling toolbar below. */}
      <div className="flex min-w-0 items-center gap-2 sm:gap-3 lg:flex-shrink-0">
        {onToggleRail && (
          <button
            onClick={onToggleRail}
            aria-label={railOpen ? "Close controls" : "Open controls"}
            aria-expanded={railOpen}
            className="-ml-1 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded text-chrome-ink-muted hover:bg-chrome-soft hover:text-chrome-ink lg:hidden"
          >
            {railOpen ? <X size={18} /> : <PanelLeft size={18} />}
          </button>
        )}

        {/* The wordmark carries the name, so there is no text beside it —
            a second "Phylo-BGC" in type would be the same word twice. The
            alt text is what a screen reader gets instead. Plain <img>
            rather than next/image: the file is a small static asset served
            from /public, and the loader's srcset machinery buys nothing at
            a fixed 28px height. */}
        <button
          type="button"
          onClick={onHome}
          disabled={!onHome}
          title={onHome ? "Back to the start" : undefined}
          className="flex flex-shrink-0 items-center rounded focus:outline-none focus-visible:ring-1 focus-visible:ring-chrome-accent enabled:hover:opacity-80"
        >
          <img
            src="/logo.png"
            alt="Phylo-BGC"
            width={710}
            height={218}
            className="h-[22px] w-auto sm:h-[26px]"
          />
        </button>

        <div className="relative min-w-0 flex-1 lg:w-44 lg:flex-none xl:w-52 2xl:w-64">
          <Search
            size={13}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-chrome-ink-faint"
          />
          <input
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            /* The box searches every field the tree carries — taxa and
               their ranks, genome accessions and assembly level, and each
               cluster's compounds, MIBiG accession and class. The
               placeholder names the kinds a reader would not guess were
               searchable; it cannot list them all. */
            placeholder="Search taxa, accessions, compounds"
            aria-label="Search taxa, accessions, compounds and BGC classes"
            /* 16px on touch: anything smaller makes iOS Safari zoom the
               whole page on focus, which then leaves the tree off-screen. */
            className="w-full rounded border border-chrome-line bg-chrome-soft py-2 pl-7 pr-16 text-base text-chrome-ink placeholder:text-chrome-ink-faint outline-none focus:border-chrome-accent sm:py-1.5 sm:text-sm"
          />
          {/* An explicit count so "no matches" is distinguishable from "search
              is broken" — the failure mode the first version had. */}
          {query.trim() !== "" && matchCount != null && (
            <span
              className={`absolute right-2 top-1/2 -translate-y-1/2 font-mono text-xs ${
                matchCount === 0 ? "text-red-300" : "text-chrome-ink-faint"
              }`}
            >
              {matchCount === 0 ? "no matches" : `${matchCount}`}
            </span>
          )}
        </div>

      </div>

      {/* Only when the tree has nothing and the database does. A count of
          "also 3 elsewhere" beside 40 visible hits would be noise; "no
          matches here, 3 in the database" is the difference between a dead
          end and a filtered view. */}
      {query.trim() !== "" && matchCount === 0 && (offTreeMatchCount ?? 0) > 0 && (
        <p className="px-1 text-[11px] leading-relaxed text-chrome-ink-faint lg:order-last lg:w-full">
          Nothing on screen matches, but the database holds{" "}
          <span className="font-mono text-chrome-ink-muted">{offTreeMatchCount}</span> matching taxon
          or genome record{offTreeMatchCount === 1 ? "" : "s"} — filtered out of this view, on the
          other taxonomy tab, or carrying no clusters. They are still in the database.
        </p>
      )}

      {/* Row 2 on small screens: the view/orientation toolbar. It scrolls
          sideways rather than wrapping into three ragged rows or being
          hidden behind another menu — every control stays one swipe away,
          and the strip keeps a fixed height so the tree never reflows. */}
      <div className="-mx-3 flex min-w-0 items-center gap-2 overflow-x-auto px-3 pb-0.5 sm:-mx-4 sm:px-4 lg:mx-0 lg:flex-1 lg:px-0 lg:pb-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {children}
        <span className="ml-auto whitespace-nowrap pl-2 font-mono text-[11px] text-chrome-ink-faint lg:hidden">
          {totalGenomes && totalGenomes !== genomeCount
            ? `${genomeCount}/${totalGenomes} genomes`
            : `${genomeCount} genome${genomeCount === 1 ? "" : "s"}`}
        </span>
      </div>

      {/* Status, hard right. On a phone this is replaced by the short form
          at the end of the toolbar row above — a viewport that can't fit
          the tree and a 320px column certainly can't fit a hint about a
          modifier key it has no way to press. */}
      <span className="ml-auto hidden flex-shrink-0 items-center gap-3 text-xs text-chrome-ink-faint lg:flex">
        <span className="hidden 2xl:inline">
          double-click a clade to focus · shift-click to compare
        </span>
        <span className="whitespace-nowrap font-mono">
          {/* "N of M" rather than a bare count: a filtered tree that
              doesn't say so is indistinguishable from missing data. */}
          {totalGenomes && totalGenomes !== genomeCount
            ? `${genomeCount} of ${totalGenomes} genomes`
            : `${genomeCount} genome${genomeCount === 1 ? "" : "s"}`}
          {/* Which taxonomy the tree came from stays on screen at every
              desktop width: an NCBI tree labelled "GTDB" misattributes half
              the corpus. Below xl it goes, because there the toolbar's own
              Prokaryotes/Eukaryotes pair is the only thing still legible. */}
          <span className="hidden xl:inline"> · taxonomic tree ({taxonomyLabel})</span>
        </span>
      </span>
    </div>
  );
}
