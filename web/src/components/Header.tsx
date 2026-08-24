"use client";

import { Dna, Search } from "lucide-react";

interface HeaderProps {
  query: string;
  onQueryChange: (query: string) => void;
  genomeCount: number;
  children?: React.ReactNode;
}

export function Header({ query, onQueryChange, genomeCount, children }: HeaderProps) {
  return (
    <div className="flex flex-shrink-0 items-center gap-4 border-b border-line bg-card px-4 py-3">
      <div className="flex items-center gap-2">
        <Dna size={18} className="text-signal" />
        <span className="text-sm font-semibold tracking-wide text-ink">BGC-scape</span>
      </div>

      <div className="relative max-w-xs flex-1">
        <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-ink-faint" />
        <input
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Search organism or accession"
          className="w-full rounded border border-line bg-paper py-1.5 pl-7 pr-2 text-sm text-ink outline-none focus:border-line-strong"
        />
      </div>

      {children}

      <span className="ml-auto flex items-center gap-3 text-xs text-ink-faint">
        <span className="hidden lg:inline">shift-click a clade to compare</span>
        <span className="font-mono">
          {genomeCount} genome{genomeCount === 1 ? "" : "s"} · taxonomic tree (GTDB)
        </span>
      </span>
    </div>
  );
}
