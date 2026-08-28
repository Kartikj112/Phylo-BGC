"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { BgcTypeDonut } from "@/components/BgcTypeDonut";
import { ClassFilterRail } from "@/components/ClassFilterRail";
import { DistributionSummaryBar } from "@/components/DistributionSummaryBar";
import { FilterPanel } from "@/components/FilterPanel";
import { ComparisonPanel } from "@/components/ComparisonPanel";
import { CorpusStatsBar } from "@/components/CorpusStatsBar";
import { ExportButton } from "@/components/ExportButton";
import { GcfDetailPanel } from "@/components/GcfDetailPanel";
import { HeatmapView } from "@/components/HeatmapView";
import { LevelControl } from "@/components/LevelControl";
import { SankeyView } from "@/components/SankeyView";
import { DetailPanel, type Selection } from "@/components/DetailPanel";
import { FamilyRail } from "@/components/FamilyRail";
import { Header } from "@/components/Header";
import { TreeCanvas } from "@/components/TreeCanvas";
import { useTaxonomyTree } from "@/hooks/useTaxonomyTree";
import type { BGCFamilySummary, TaxonTreeNode } from "@/lib/api-types";
import { CLASS_ORDER } from "@/lib/colors";
import {
  bgcFamilyIndex,
  collapseToFamily,
  collapseToLevel,
  initialCollapseLevel,
  collectMatchKeys,
  countBgcClasses,
  EMPTY_FILTERS,
  applyFocus,
  applyGenomeFilters,
  familyDistribution,
  familyMembershipSets,
  familyTreeIndex,
  findMibigEntry,
  findTaxonKeyByName,
  groupUnplacedTaxa,
  pruneToBgcBearing,
  ranksPresent,
  toRootDisplayNode,
  type CollapseLevel,
  type FamilyIndexEntry,
  type GenomeFilters,
  type TreeOrientation,
} from "@/lib/tree-logic";

export default function HomePage() {
  const [view, setView] = useState<"tree" | "eukaryotes" | "flow" | "heatmap">("tree");
  // Two taxonomies, two views. GTDB (genome-based) and NCBI (literature-based)
  // are different methodologies that disagree, so the eukaryotes GTDB cannot
  // represent get their own tree rather than being grafted onto the bacterial
  // backbone — a merged tree would be a hybrid a reader could not pick apart.
  // Both use the same canvas and the same controls.
  const isTreeView = view === "tree" || view === "eukaryotes";
  const treeScope = view === "eukaryotes" ? "eukaryote" : "prokaryote";
  const { tree, loading, error } = useTaxonomyTree(treeScope);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [activeClasses, setActiveClasses] = useState<Set<string>>(new Set(CLASS_ORDER));
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<Selection>(null);
  const [selectedFamilyId, setSelectedFamilyId] = useState<string | null>(null);
  const [comparisonTaxonIds, setComparisonTaxonIds] = useState<string[]>([]);
  const svgRef = useRef<SVGSVGElement | null>(null);
  // Radial by default: it shows the shape of the whole corpus in one
  // screen-filling form, which is the "where does this sit across the tree"
  // question the tool exists to answer. Horizontal is better for reading
  // exact lineages and stays one click away.
  const [orientation, setOrientation] = useState<TreeOrientation>("radial");
  const [activeLevel, setActiveLevel] = useState<CollapseLevel | null>(null);
  // Defaults to on: a real GTDB ingest is mostly genomes antiSMASH has
  // never been run on, and showing them buries the signal.
  const [onlyWithBgcs, setOnlyWithBgcs] = useState(true);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [filters, setFilters] = useState<GenomeFilters>(EMPTY_FILTERS);
  // Set of families the browser has loaded, so the summary/detail panels
  // can resolve the selected id to a label + classes without a request.
  const [familiesList, setFamiliesList] = useState<BGCFamilySummary[]>([]);
  // Whether the tree is currently framed on the selected family's lineages.
  const [autoFramed, setAutoFramed] = useState(false);
  // Bumped to ask the canvas to recentre after a layout-reshaping change.
  const [fitSignal, setFitSignal] = useState(0);
  // Purely visual per-node nudges from dragging. Keyed by nodeKey(); never
  // touches the hierarchy, so topology and every derived statistic are
  // unaffected. `Auto arrange` clears this.
  const [nodeOffsets, setNodeOffsets] = useState<Map<string, { dx: number; dy: number }>>(new Map());
  const initialCollapseApplied = useRef(false);
  // Hierarchy regions are on by default but dismissible: they are a reading
  // aid, and a reader preparing a figure may want the tree bare.
  const [showRegions, setShowRegions] = useState(true);
  // Cluster glyphs on one aligned track (default) vs the original barcode
  // hanging off each node. A toggle rather than a silent replacement: the
  // inline form is still the better read when only a handful of tips are on
  // screen, and it makes the two directly comparable.
  const [alignedGlyphs, setAlignedGlyphs] = useState(true);

  function toggleComparisonTaxon(taxonId: string): void {
    setComparisonTaxonIds((prev) =>
      prev.includes(taxonId) ? prev.filter((id) => id !== taxonId) : [...prev, taxonId],
    );
  }

  const fullRoot = useMemo(
    () => (tree ? groupUnplacedTaxa(toRootDisplayNode(tree)) : null),
    [tree],
  );
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

  // ----- GCF distribution: the central question -----------------------------
  // All derived from `family_ids` already present on every BGC in the tree
  // payload, computed against the FULL tree so the numbers are stable
  // dataset properties rather than artefacts of the current view.
  const familyIndex = useMemo<Map<string, FamilyIndexEntry>>(
    () => (fullRoot ? familyTreeIndex(fullRoot) : new Map()),
    [fullRoot],
  );
  const bgcFamIndex = useMemo<Map<string, string[]>>(
    () => (fullRoot ? bgcFamilyIndex(fullRoot) : new Map()),
    [fullRoot],
  );
  const totalPhyla = useMemo(() => {
    if (!fullRoot) return 0;
    let n = 0;
    const walk = (node: TaxonTreeNode) => {
      if (node.rank === "phylum") n += 1;
      node.children.forEach(walk);
    };
    walk(fullRoot);
    return n;
  }, [fullRoot]);
  const familyMembership = useMemo(
    () => (fullRoot && selectedFamilyId ? familyMembershipSets(fullRoot, selectedFamilyId) : null),
    [fullRoot, selectedFamilyId],
  );
  const familyDist = useMemo(
    () => (fullRoot ? familyDistribution(fullRoot, selectedFamilyId) : null),
    [fullRoot, selectedFamilyId],
  );
  const familyEnclosingKeys = useMemo(
    () => new Set((familyDist?.enclosingClades ?? []).map((c) => c.key)),
    [familyDist],
  );
  const selectedFamily = useMemo(
    () => familiesList.find((f) => f.id === selectedFamilyId),
    [familiesList, selectedFamilyId],
  );
  const enclosingTaxonIds = useMemo(
    () => (familyDist?.enclosingClades ?? []).filter((c) => c.rank !== null).map((c) => c.key),
    [familyDist],
  );
  const canCompareEnclosing = enclosingTaxonIds.length >= 2;
  const selectedBgcFamilyIds = useMemo(
    () => (selection?.kind === "bgc" ? (bgcFamIndex.get(selection.id) ?? []) : []),
    [selection, bgcFamIndex],
  );

  // Switching taxonomy loads a different tree, so view state keyed to the old
  // one has to go: collapse keys are node ids that do not exist in the other
  // tree, and the initial-collapse guard must re-arm or the new tree would
  // render fully expanded.
  useEffect(() => {
    initialCollapseApplied.current = false;
    setCollapsed(new Set());
    setActiveLevel(null);
    setFocusKey(null);
    setSelection(null);
    setSelectedFamilyId(null);
    setComparisonTaxonIds([]);
    setNodeOffsets(new Map());
  }, [treeScope]);

  // Open on a readable summary, not on every leaf at once.
  //
  // The tree used to render fully expanded — 3,528 nodes on the bundled
  // corpus — so the broad distribution pattern was buried under the detail
  // before the user had asked for any of it. The level is derived from the
  // data (see initialCollapseLevel), so a small corpus still opens detailed.
  // Runs once; any later interaction owns the collapse state from then on.
  useEffect(() => {
    if (!root || initialCollapseApplied.current) return;
    initialCollapseApplied.current = true;
    const level = initialCollapseLevel(root);
    setActiveLevel(level);
    setCollapsed(collapseToLevel(root, level));
    setFitSignal((n) => n + 1);
  }, [root]);

  /** Record a purely visual drag. Accumulates so a drag reads as continuous
   * motion; the hierarchy is never consulted or changed. */
  function nudgeNode(key: string, dx: number, dy: number): void {
    setNodeOffsets((prev) => {
      const next = new Map(prev);
      const cur = next.get(key) ?? { dx: 0, dy: 0 };
      next.set(key, { dx: cur.dx + dx, dy: cur.dy + dy });
      return next;
    });
  }

  /** Clear manual drags and re-frame. The layout itself is already an even
   * distribution, so "tidy" means discarding the nudges that moved nodes
   * away from it — not a different algorithm. */
  function autoArrange(): void {
    setNodeOffsets(new Map());
    setFitSignal((n) => n + 1);
  }

  // Deep links, for the planned antiSMASH "view across the tree" button and
  // for sharing a view. Read once, from the URL directly (no useSearchParams
  // so the page can stay statically rendered):
  //   ?bgc=BGC0000123  → land on that MIBiG cluster's organism, framed on
  //                       its clade, with its biosynthetic class highlighted
  //   ?taxon=Streptomyces → focus that clade
  //   ?class=nrps       → filter to that biosynthetic class
  const deepLinkApplied = useRef(false);
  useEffect(() => {
    if (!fullRoot || deepLinkApplied.current || typeof window === "undefined") return;
    deepLinkApplied.current = true;
    const p = new URLSearchParams(window.location.search);
    const clsParam = p.get("class")?.toLowerCase();
    const bgcParam = p.get("bgc")?.trim();
    const taxonParam = p.get("taxon")?.trim();

    if (clsParam && CLASS_ORDER.includes(clsParam)) {
      setActiveClasses(new Set([clsParam]));
    }
    if (bgcParam) {
      const hit = findMibigEntry(fullRoot, bgcParam);
      if (hit) {
        setSelection({ kind: "genome", id: hit.genomeId });
        const known = hit.bgcClasses.filter((c) => CLASS_ORDER.includes(c));
        if (known.length) setActiveClasses(new Set(known));
        setFocusKey(hit.focusKey);
        setOnlyWithBgcs(true);
        setFitSignal((n) => n + 1);
      }
    } else if (taxonParam) {
      const key = findTaxonKeyByName(fullRoot, taxonParam);
      if (key) {
        setFocusKey(key);
        setFitSignal((n) => n + 1);
      }
    }
  }, [fullRoot]);

  function selectFamily(id: string | null): void {
    setSelectedFamilyId(id);
    // Focusing the whole interface on a family; a stale genome/BGC panel
    // would compete with the distribution view.
    setSelection(null);
    if (id && fullRoot) {
      const membership = familyMembershipSets(fullRoot, id);
      if (membership.genomeKeys.size > 0) {
        setAutoFramed(true);
        setCollapsed(collapseToFamily(fullRoot, membership.nodeKeys));
        setActiveLevel(null);
      } else {
        setAutoFramed(false);
        setCollapsed(new Set());
      }
    } else {
      setAutoFramed(false);
      setCollapsed(new Set());
      setActiveLevel(null);
    }
    setFitSignal((n) => n + 1);
  }

  function toggleFraming(): void {
    if (!selectedFamilyId || !fullRoot) return;
    if (autoFramed) {
      setAutoFramed(false);
      setCollapsed(new Set());
    } else {
      const membership = familyMembership ?? familyMembershipSets(fullRoot, selectedFamilyId);
      setAutoFramed(true);
      setCollapsed(collapseToFamily(fullRoot, membership.nodeKeys));
      setActiveLevel(null);
    }
    setFitSignal((n) => n + 1);
  }

  function compareEnclosing(): void {
    if (enclosingTaxonIds.length >= 2) setComparisonTaxonIds(enclosingTaxonIds);
  }

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
      setAutoFramed(false);
    }
    setFitSignal((n) => n + 1);
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
    setAutoFramed(false);
    setCollapsed(collapseToLevel(root, level));
    setFitSignal((n) => n + 1);
  }

  function toggleCollapse(key: string): void {
    // Once a node is toggled by hand the tree no longer matches the
    // preset, so the highlight is cleared rather than left claiming a
    // depth that isn't true any more.
    setActiveLevel(null);
    setAutoFramed(false);
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
        matchCount={matchCount}
        taxonomyLabel={view === "eukaryotes" ? "NCBI Taxonomy" : "GTDB"}>
        <div className="flex flex-shrink-0 overflow-hidden rounded border border-line">
          {(
            [
              ["tree", "Tree", "Prokaryotes on the GTDB backbone"],
              ["eukaryotes", "Eukaryotes", "Fungi and plants, ranked by NCBI Taxonomy — GTDB is prokaryote-only and cannot represent them"],
              ["flow", "Flows", "Phylum to genus to BGC class"],
              ["heatmap", "Matrix", "Clade by BGC class"],
            ] as const
          ).map(([id, label, hint]) => (
            <button
              key={id}
              title={hint}
              onClick={() => setView(id)}
              className={`px-2.5 py-1 text-xs ${
                view === id ? "bg-signal-wash text-signal" : "text-ink-muted hover:text-ink"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {isTreeView && (
        <div className="flex flex-shrink-0 overflow-hidden rounded border border-line">
          {(["horizontal", "radial"] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => {
                setOrientation(mode);
                setFitSignal((n) => n + 1);
              }}
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

        {isTreeView && (
          <button
            onClick={() => setAlignedGlyphs((v) => !v)}
            title={
              alignedGlyphs
                ? "Cluster glyphs share one aligned track, so counts and classes line up across the whole tree. Click to hang them off each node instead."
                : "Cluster glyphs hang off each node. Click to align them on a shared track so rows can be compared."
            }
            className={`flex-shrink-0 whitespace-nowrap rounded border border-line px-2 py-1 text-xs ${
              alignedGlyphs ? "bg-signal-wash text-signal" : "text-ink-muted hover:text-ink"
            }`}
          >
            Aligned
          </button>
        )}

        {isTreeView && (
          <button
            onClick={() => setShowRegions((v) => !v)}
            title={
              showRegions
                ? "Hide the taxonomic grouping shading"
                : "Show subtle shading behind each clade to make the taxonomic nesting visible"
            }
            className={`flex-shrink-0 whitespace-nowrap rounded border border-line px-2 py-1 text-xs ${
              showRegions ? "bg-signal-wash text-signal" : "text-ink-muted hover:text-ink"
            }`}
          >
            Clades
          </button>
        )}

        {isTreeView && (
          <button
            onClick={autoArrange}
            disabled={nodeOffsets.size === 0}
            title={
              nodeOffsets.size === 0
                ? "Layout is already tidy — drag nodes to rearrange, then use this to restore it"
                : `Discard ${nodeOffsets.size} manual node move(s) and re-centre`
            }
            className="flex-shrink-0 whitespace-nowrap rounded border border-line px-2 py-1 text-xs text-ink-muted enabled:hover:text-ink disabled:opacity-40"
          >
            Auto arrange
          </button>
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

      {/* What this dataset contains, above everything: how many clusters,
          of what kinds, over how many genomes. Doubles as the class filter
          so it can never disagree with the left rail. */}
      <CorpusStatsBar
        activeClasses={activeClasses}
        onToggleClass={toggleClass}
        onResetClasses={() => setActiveClasses(new Set(CLASS_ORDER))}
        shownGenomes={genomeCount}
        totalGenomes={pruned?.totalGenomes ?? 0}
      />

      {isTreeView && selectedFamilyId && familyDist && (
        <DistributionSummaryBar
          family={selectedFamily}
          distribution={familyDist}
          autoFramed={autoFramed}
          onToggleFraming={toggleFraming}
          onCompareEnclosing={compareEnclosing}
          canCompareEnclosing={canCompareEnclosing}
          onClear={() => selectFamily(null)}
        />
      )}

      {isTreeView && focused && (
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
          <FamilyRail
            selectedFamilyId={selectedFamilyId}
            onSelectFamily={selectFamily}
            familyIndex={familyIndex}
            totalPhyla={totalPhyla}
            onFamiliesLoaded={setFamiliesList}
          />
        </div>

        <div className={`relative flex-1 p-6 ${isTreeView ? "overflow-hidden" : "overflow-auto"}`}>
          {/* Bottom-right, out of the tree's way. It is context for the tree,
              not a peer of it, so it sits in the corner the eye reaches last
              and never crosses the centre where the radial layout puts its
              densest structure. Hidden below lg, where the tree needs the
              whole viewport more than the breakdown does. */}
          {isTreeView && root && (
            <div className="pointer-events-none absolute bottom-4 right-4 z-10 hidden lg:block">
              <BgcTypeDonut />
            </div>
          )}
          {view === "flow" && <SankeyView />}
          {view === "heatmap" && <HeatmapView />}
          {isTreeView && loading && (
            <div className="flex h-full items-center justify-center text-sm text-ink-muted">
              Loading taxonomy tree…
            </div>
          )}
          {isTreeView && error && (
            <div className="max-w-md text-sm text-red-700">
              Couldn&apos;t reach the API ({error.message}). Is <code className="font-mono">uvicorn
              bgcscape.api.app:app</code> running, and does <code className="font-mono">NEXT_PUBLIC_API_URL</code>{" "}
              point at it? See <code className="font-mono">web/.env.local.example</code>.
            </div>
          )}
          {isTreeView && root && (
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
              familyMembership={familyMembership}
              familyEnclosingKeys={familyEnclosingKeys}
              familyLabel={selectedFamily?.label ?? null}
              fitSignal={fitSignal}
              onFocusNode={focusNode}
              nodeOffsets={nodeOffsets}
              onNodeDrag={nudgeNode}
              showRegions={showRegions}
              alignedGlyphs={alignedGlyphs}
            />
          )}
        </div>

        {selection ? (
          <DetailPanel
            selection={selection}
            onClose={() => setSelection(null)}
            onSelectBgc={(id) => setSelection({ kind: "bgc", id })}
            familyIds={selectedBgcFamilyIds}
            onShowFamily={selectFamily}
          />
        ) : selectedFamilyId ? (
          <GcfDetailPanel
            familyId={selectedFamilyId}
            family={selectedFamily}
            distribution={familyDist}
            onClose={() => selectFamily(null)}
            onSelectGenome={(id) => setSelection({ kind: "genome", id })}
            onCompareEnclosing={compareEnclosing}
            canCompareEnclosing={canCompareEnclosing}
          />
        ) : null}
      </div>

      <ComparisonPanel
        taxonIds={comparisonTaxonIds}
        onClose={() => setComparisonTaxonIds([])}
        onClearSelection={() => setComparisonTaxonIds([])}
      />
    </div>
  );
}
