"use client";

import { useMemo, useRef, useState } from "react";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { BgcTypeDonut } from "@/components/BgcTypeDonut";
import { ClassFilterRail } from "@/components/ClassFilterRail";
import { FilterPanel } from "@/components/FilterPanel";
import { ComparisonPanel } from "@/components/ComparisonPanel";
import { ExportButton } from "@/components/ExportButton";
import { HeatmapView } from "@/components/HeatmapView";
import { LevelControl } from "@/components/LevelControl";
import { SankeyView } from "@/components/SankeyView";
import { DetailPanel, type Selection } from "@/components/DetailPanel";
import { FamilyRail } from "@/components/FamilyRail";
import { Header } from "@/components/Header";
import { TreeCanvas } from "@/components/TreeCanvas";
import { useTaxonomyTree } from "@/hooks/useTaxonomyTree";
import { CLASS_ORDER } from "@/lib/colors";
import {
  collapseToLevel,
  collectMatchKeys,
  countBgcClasses,
  countTotalGenomes,
  EMPTY_FILTERS,
  applyFocus,
  applyGenomeFilters,
  pruneToBgcBearing,
  ranksPresent,
  toRootDisplayNode,
  type CollapseLevel,
  type GenomeFilters,
  type TreeOrientation,
} from "@/lib/tree-logic";

export default function HomePage() {
  const { tree, loading, error } = useTaxonomyTree();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [activeClasses, setActiveClasses] = useState<Set<string>>(new Set(CLASS_ORDER));
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<Selection>(null);
  const [selectedFamilyId, setSelectedFamilyId] = useState<string | null>(null);
  const [comparisonTaxonIds, setComparisonTaxonIds] = useState<string[]>([]);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [orientation, setOrientation] = useState<TreeOrientation>("horizontal");
  const [view, setView] = useState<"tree" | "flow" | "heatmap">("tree");
  const [activeLevel, setActiveLevel] = useState<CollapseLevel | null>(null);
  // Defaults to on: a real GTDB ingest is mostly genomes antiSMASH has
  // never been run on, and showing them buries the signal.
  const [onlyWithBgcs, setOnlyWithBgcs] = useState(true);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [filters, setFilters] = useState<GenomeFilters>(EMPTY_FILTERS);

  function toggleComparisonTaxon(taxonId: string): void {
    setComparisonTaxonIds((prev) =>
      prev.includes(taxonId) ? prev.filter((id) => id !== taxonId) : [...prev, taxonId],
    );
  }

  const fullRoot = useMemo(() => (tree ? toRootDisplayNode(tree) : null), [tree]);
  const pruned = useMemo(
    () => (fullRoot ? pruneToBgcBearing(fullRoot, onlyWithBgcs) : null),
    [fullRoot, onlyWithBgcs],
  );
  const filtered = useMemo(
    () => (pruned ? applyGenomeFilters(pruned.root, filters) : null),
    [pruned, filters],
  );
  const focused = useMemo(
    () => (filtered ? applyFocus(filtered.root, focusKey) : null),
    [filtered, focusKey],
  );
  const root = focused?.root ?? null;

  function focusNode(key: string | null): void {
    setFocusKey(key);
    // Focusing into a collapsed clade must open it, or the new root
    // renders as a single glyph with nothing beneath it.
    if (key) {
      setCollapsed((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      setActiveLevel(null);
    }
  }
  const classCounts = useMemo(() => (root ? countBgcClasses(root) : {}), [root]);
  const availableRanks = useMemo(() => (root ? ranksPresent(root) : new Set<string>()), [root]);
  const genomeCount = pruned?.shownGenomes ?? 0;
  const matchCount = useMemo(
    () => (root && query.trim() ? collectMatchKeys(root, query).size : null),
    [root, query],
  );

  function selectLevel(level: CollapseLevel): void {
    if (!root) return;
    setActiveLevel(level);
    setCollapsed(collapseToLevel(root, level));
  }

  function toggleCollapse(key: string): void {
    // Once a node is toggled by hand the tree no longer matches the
    // preset, so the highlight is cleared rather than left claiming a
    // depth that isn't true any more.
    setActiveLevel(null);
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleClass(cls: string): void {
    setActiveClasses((prev) => {
      const next = new Set(prev);
      if (next.has(cls)) next.delete(cls);
      else next.add(cls);
      return next.size === 0 ? new Set(CLASS_ORDER) : next;
    });
  }

  return (
    <div className="flex h-screen w-full flex-col bg-paper">
      <Header query={query} onQueryChange={setQuery} genomeCount={genomeCount}
        totalGenomes={pruned?.totalGenomes ?? 0}
        matchCount={matchCount}>
        <div className="flex overflow-hidden rounded border border-line">
          {([["tree", "Tree"], ["flow", "Flows"], ["heatmap", "Matrix"]] as const).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setView(id)}
              className={`px-2.5 py-1 text-xs ${
                view === id ? "bg-signal-wash text-signal" : "text-ink-muted hover:text-ink"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {view === "tree" && (
        <div className="flex overflow-hidden rounded border border-line">
          {(["horizontal", "radial"] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => setOrientation(mode)}
              title={mode === "horizontal" ? "Horizontal tree" : "Circular tree"}
              className={`px-2 py-1 text-xs ${
                orientation === mode ? "bg-signal-wash text-signal" : "text-ink-muted hover:text-ink"
              }`}
            >
              {mode === "horizontal" ? "⊢" : "◎"}
            </button>
          ))}
        </div>
        )}

        <ExportButton
          svgRef={svgRef}
          collapsed={collapsed}
          activeClasses={activeClasses}
          selectedFamilyId={selectedFamilyId}
          comparisonTaxonIds={comparisonTaxonIds}
          searchQuery={query}
        />
      </Header>

      {view === "tree" && focused && (
        <Breadcrumbs path={focused.path} focusLost={focused.focusLost} onNavigate={focusNode} />
      )}

      <div className="flex min-h-0 flex-1">
        <div className="w-52 flex-shrink-0 overflow-y-auto border-r border-line p-4">
          <div className="mb-5">
            <label className="flex cursor-pointer items-start gap-2">
              <input
                type="checkbox"
                checked={onlyWithBgcs}
                onChange={(e) => setOnlyWithBgcs(e.target.checked)}
                className="mt-0.5 accent-[#2C5F52]"
              />
              <span className="text-sm text-ink">Only genomes with BGCs</span>
            </label>
            <p className="mt-1 pl-6 text-xs leading-relaxed text-ink-faint">
              {pruned?.fellBackToFull ? (
                <span className="text-amber-700">
                  No genome in this dataset has BGCs yet — showing all. Run{" "}
                  <span className="font-mono">bgcscape ingest antismash</span> to populate them.
                </span>
              ) : onlyWithBgcs ? (
                <>
                  Hiding {(pruned?.totalGenomes ?? 0) - (pruned?.shownGenomes ?? 0)} genome(s) with no
                  predicted clusters. They are in the database, just not drawn.
                </>
              ) : (
                <>Showing every genome, including those antiSMASH has not been run on.</>
              )}
            </p>
          </div>

          <FilterPanel
            filters={filters}
            onChange={setFilters}
            matched={filtered?.matched ?? 0}
            total={pruned?.shownGenomes ?? 0}
            filteredEverythingOut={filtered?.filteredEverythingOut ?? false}
          />

          <LevelControl
            activeLevel={activeLevel}
            availableRanks={availableRanks}
            onSelectLevel={selectLevel}
          />

          <ClassFilterRail
            activeClasses={activeClasses}
            counts={classCounts}
            onToggle={toggleClass}
            onReset={() => setActiveClasses(new Set(CLASS_ORDER))}
          />
          <FamilyRail selectedFamilyId={selectedFamilyId} onSelectFamily={setSelectedFamilyId} />
        </div>

        <div className="relative flex-1 overflow-auto p-6">
          {view === "tree" && root && (
            <div className="pointer-events-none absolute bottom-4 right-4 z-10">
              <BgcTypeDonut />
            </div>
          )}
          {view === "flow" && <SankeyView />}
          {view === "heatmap" && <HeatmapView />}
          {view === "tree" && loading && <div className="text-sm text-ink-muted">Loading taxonomy tree…</div>}
          {view === "tree" && error && (
            <div className="max-w-md text-sm text-red-700">
              Couldn&apos;t reach the API ({error.message}). Is <code className="font-mono">uvicorn
              bgcscape.api.app:app</code> running, and does <code className="font-mono">NEXT_PUBLIC_API_URL</code>{" "}
              point at it? See <code className="font-mono">web/.env.local.example</code>.
            </div>
          )}
          {view === "tree" && root && (
            <TreeCanvas
              root={root}
              collapsed={collapsed}
              onToggleCollapse={toggleCollapse}
              activeClasses={activeClasses}
              searchQuery={query}
              selectedId={selection?.id ?? null}
              selectedFamilyId={selectedFamilyId}
              comparisonTaxonIds={comparisonTaxonIds}
              onToggleComparisonTaxon={toggleComparisonTaxon}
              onSelectGenome={(id) => setSelection({ kind: "genome", id })}
              onSelectBgc={(id) => setSelection({ kind: "bgc", id })}
              svgRef={svgRef}
              orientation={orientation}
              onFocusNode={focusNode}
            />
          )}
        </div>

        <DetailPanel
          selection={selection}
          onClose={() => setSelection(null)}
          onSelectBgc={(id) => setSelection({ kind: "bgc", id })}
        />
      </div>

      <ComparisonPanel
        taxonIds={comparisonTaxonIds}
        onClose={() => setComparisonTaxonIds([])}
        onClearSelection={() => setComparisonTaxonIds([])}
      />
    </div>
  );
}
