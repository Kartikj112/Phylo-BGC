"use client";

import { PanelLeft, Search, X } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { GtdbSearchResults, useGtdbSearch } from "@/components/GtdbSearchResults";
import { ScrollableToolbar } from "@/components/ScrollableToolbar";
import type { TreeScope } from "@/lib/api-client";
import type { BackboneSearchHit } from "@/lib/api-types";

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
  /** Set where a reference backbone exists to search (GTDB, prokaryotes):
   * the box then also offers matching clades from all of it. */
  gtdbSearch?: {
    scope: TreeScope;
    sourceLabel: string;
    backboneOn: boolean;
    onPick: (hit: BackboneSearchHit) => void;
  } | null;
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
  gtdbSearch = null,
  children,
}: HeaderProps) {
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const listId = useId();
  const suggest = !!gtdbSearch && focused && !dismissed && query.trim().length >= 2;
  const { hits, loading } = useGtdbSearch(
    gtdbSearch?.scope ?? "prokaryote",
    query,
    !!gtdbSearch && focused,
  );
  // A new query re-opens the list and starts again from the top.
  useEffect(() => {
    setDismissed(false);
    setActiveIndex(-1);
  }, [query]);

  function pick(hit: BackboneSearchHit) {
    gtdbSearch?.onPick(hit);
    setDismissed(true);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    const n = hits?.length ?? 0;
    if (e.key === "Escape") {
      if (suggest) setDismissed(true);
      else onQueryChange("");
    } else if (!suggest || n === 0) {
      return;
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % n);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i <= 0 ? n - 1 : i - 1));
    } else if (e.key === "Enter" && activeIndex >= 0 && hits?.[activeIndex]) {
      e.preventDefault();
      pick(hits[activeIndex]);
    }
  }

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

        <div
          data-tour="search"
          className="relative min-w-0 flex-1 lg:w-48 lg:flex-none xl:w-56 2xl:w-72"
        >
          <Search
            size={13}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-chrome-ink-faint"
          />
          <input
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={onKeyDown}
            role={gtdbSearch ? "combobox" : undefined}
            aria-expanded={gtdbSearch ? suggest : undefined}
            aria-controls={suggest ? listId : undefined}
            aria-autocomplete={gtdbSearch ? "list" : undefined}
            aria-activedescendant={suggest && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
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
          {suggest && gtdbSearch && (
            <GtdbSearchResults
              id={listId}
              hits={hits}
              loading={loading}
              activeIndex={activeIndex}
              sourceLabel={gtdbSearch.sourceLabel}
              backboneOn={gtdbSearch.backboneOn}
              treeMatchCount={matchCount}
              onPick={pick}
              onHover={setActiveIndex}
            />
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
      <ScrollableToolbar>
        {children}
        <span className="ml-auto whitespace-nowrap pl-2 font-mono text-[11px] text-chrome-ink-faint lg:hidden">
          {totalGenomes && totalGenomes !== genomeCount
            ? `${genomeCount}/${totalGenomes} genomes`
            : `${genomeCount} genome${genomeCount === 1 ? "" : "s"}`}
        </span>
      </ScrollableToolbar>

      {/* Status, hard right. On a phone this is replaced by the short form
          at the end of the toolbar row above. The genome count repeats the
          stats bar directly below, so it is only spent on very wide screens;
          which taxonomy the tree came from is kept as long as there is room
          for it, because an NCBI tree labelled "GTDB" misattributes half the
          corpus. */}
      <span className="ml-auto hidden flex-shrink-0 items-center gap-3 text-xs text-chrome-ink-faint min-[1400px]:flex">
        <span className="whitespace-nowrap font-mono">
          {/* "N of M" rather than a bare count: a filtered tree that
              doesn't say so is indistinguishable from missing data. */}
          <span className="hidden 2xl:inline">
            {totalGenomes && totalGenomes !== genomeCount
              ? `${genomeCount} of ${totalGenomes} genomes · `
              : `${genomeCount} genome${genomeCount === 1 ? "" : "s"} · `}
          </span>
          taxonomic tree ({taxonomyLabel})
        </span>
      </span>
    </div>
  );
}
