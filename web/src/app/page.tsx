"use client";

import {
  BookOpen,
  Compass,
  FolderUp,
  HelpCircle,
  Home,
  Loader2,
  RotateCcw,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { BgcTypeDonut } from "@/components/BgcTypeDonut";
import { ClassFilterRail } from "@/components/ClassFilterRail";
import { DistributionSummaryBar } from "@/components/DistributionSummaryBar";
import { FilterPanel } from "@/components/FilterPanel";
import { PrioritizationPanel } from "@/components/PrioritizationPanel";
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
import { AntismashUploadDialog } from "@/components/AntismashUploadDialog";
import { BackboneGuide } from "@/components/BackboneGuide";
import {
  MenuCheckbox,
  MenuItem,
  MenuLabel,
  MenuNote,
  MenuRadio,
  MenuSeparator,
  ToolbarMenu,
} from "@/components/ToolbarMenu";
import { LoadingOverlay } from "@/components/LoadingOverlay";
import { LoadingQuestions } from "@/components/LoadingQuestions";
import { SiteFooter } from "@/components/SiteFooter";
import { WelcomeDialog } from "@/components/WelcomeDialog";
import { QuickTour } from "@/components/QuickTour";
import { TreeCanvas } from "@/components/TreeCanvas";
import { useTaxonomyTree } from "@/hooks/useTaxonomyTree";
import { useBackboneTree } from "@/hooks/useBackboneTree";
import { asTaxonTree, isComparable, omittedSummaryParentKey } from "@/lib/backbone";
import { fetchBgcClasses, search, searchBackbone, invalidateApiCache } from "@/lib/api-client";
import type { BackboneSearchHit, BGCFamilySummary, TaxonTreeNode } from "@/lib/api-types";
import { CLASS_ORDER } from "@/lib/colors";
import {
  bgcFamilyIndex,
  collapseToFamily,
  collapseToLevel,
  coverageAt,
  coverageRollupIndex,
  surveyBasis,
  initialCollapseLevel,
  collectMatchKeys,
  countBgcClasses,
  EMPTY_FILTERS,
  applyFocus,
  applyGenomeFilters,
  familyDistribution,
  familyMembershipSets,
  familyMembershipSetsForAny,
  familyTreeIndex,
  filtersAreActive,
  findMibigEntry,
  findNodeByKey,
  findTaxonKeyByName,
  groupUnplacedTaxa,
  pathToNode,
  pruneToBgcBearing,
  ranksPresent,
  toRootDisplayNode,
  type CollapseLevel,
  type FamilyIndexEntry,
  type GenomeFilters,
  uploadLineage,
  type TreeOrientation,
} from "@/lib/tree-logic";

/** One control group in the left rail.
 *
 * The divider and spacing live here rather than on each control, so the
 * order can change without the rhythm breaking. Previously `LevelControl`
 * carried a bottom margin, `FamilyRail` carried a top border and
 * `ClassFilterRail` carried neither — a set of rules that only produced
 * even spacing in the one arrangement they were written against. */
function RailSection({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-t border-chrome-line pt-4 first:border-t-0 first:pt-0 [&:not(:last-child)]:pb-4">
      {children}
    </div>
  );
}

export default function HomePage() {
  // Taxonomy and view are independent axes, and conflating them was a
  // labelling bug: the tabs read "Tree | Eukaryotes | Flows | Matrix", so one
  // named a widget and the next named a clade, and there was no way to see
  // the Sankey or the matrix for eukaryotes at all. They are now two
  // controls — which taxonomy, and which view of it.
  //
  // The split is not cosmetic. GTDB (genome-based, rank-normalised) and NCBI
  // (literature-based) disagree, so every view is scoped to one of them:
  // a merged phylum column would put Ascomycota beside Actinomycetota.
  const [taxonomy, setTaxonomy] = useState<"prokaryote" | "eukaryote">("prokaryote");
  const [view, setView] = useState<"tree" | "flow" | "heatmap">("tree");
  const isTreeView = view === "tree";
  const treeScope = taxonomy;
  const { tree: corpusTree, loading, error, reload: reloadTree } = useTaxonomyTree(treeScope);
  // "All GTDB genomes": the whole reference taxonomy behind the corpus,
  // loaded a clade at a time (see lib/backbone.ts). Off by default, offered
  // only where a backbone is loaded (GTDB, so prokaryotes), and deep-linkable
  // with ?backbone=1.
  const [showAllGenomes, setShowAllGenomes] = useState(false);
  // Read once from the URL, so a copied link (Export → Copy link) reopens
  // the same taxonomy, view and mode. Clade and class are applied later,
  // once there is a tree to find them in (see the deep-link effect).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const p = new URLSearchParams(window.location.search);
    if (p.get("backbone") === "1") setShowAllGenomes(true);
    if (p.get("scope") === "eukaryote") setTaxonomy("eukaryote");
    const v = p.get("view");
    if (v === "flow" || v === "heatmap") setView(v);
  }, []);
  const backbone = useBackboneTree(treeScope, showAllGenomes && treeScope === "prokaryote");
  const backboneOn = showAllGenomes && backbone.tree !== null;
  // A clade to open in the backbone and then focus: a search result (by
  // backbone id), or the clade that was focused when the switch was flipped
  // on (by name, since the corpus tree does not know backbone ids).
  type RevealRequest =
    | { backboneId: string; nodeKey: string; name: string; rank: string | null }
    | { name: string; rank: string | null };
  const [pendingReveal, setPendingReveal] = useState<RevealRequest | null>(null);
  const pendingRevealRef = useRef<RevealRequest | null>(null);
  pendingRevealRef.current = pendingReveal;
  const [revealingName, setRevealingName] = useState<string | null>(null);
  // Focus this node key once it is in the tree; `parentIfLeaf` focuses a
  // species' genus instead, since a species alone is a single dot.
  const [focusTarget, setFocusTarget] = useState<{ key: string; parentIfLeaf: boolean } | null>(null);
  const [guideCollapsed, setGuideCollapsed] = useState(false);
  const backboneOffered = taxonomy === "prokaryote" && backbone.status?.available === true;
  const referenceSource =
    backboneOn && backbone.status?.source_name
      ? `${backbone.status.source_name} ${backbone.status.source_version ?? ""}`.trim()
      : null;
  // The corpus tree stays on screen until the backbone arrives, and is what
  // every view falls back to when no backbone is loaded.
  const tree = useMemo(
    () => (backboneOn && backbone.tree ? asTaxonTree(backbone.tree) : corpusTree),
    [backboneOn, backbone.tree, corpusTree],
  );
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [activeClasses, setActiveClasses] = useState<Set<string>>(new Set(CLASS_ORDER));
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<Selection>(null);
  const [selectedFamilyId, setSelectedFamilyId] = useState<string | null>(null);
  const [comparisonTaxonIds, setComparisonTaxonIds] = useState<string[]>([]);
  const svgRef = useRef<SVGSVGElement | null>(null);
  // Horizontal by default: ranks read left-to-right down the depth axis and
  // every label sits upright on the same baseline, so a lineage can be read
  // off the first screen without rotating your head or the figure. The
  // radial form — better for taking in the whole corpus at once — is one
  // click away and keeps its own fit-to-view.
  const [orientation, setOrientation] = useState<TreeOrientation>("horizontal");
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
  // The class donut repeats the stats bar's class strip, and sat on top of
  // the tree's bottom-right corner where it swallowed clicks on whatever
  // clade was drawn under it. Offered in Display, off by default.
  const [showTypeChart, setShowTypeChart] = useState(false);
  // Below `lg` the left rail is an off-canvas drawer rather than a column:
  // at 375px a 208px rail leaves 167px of tree, which is not a view of
  // anything. It is a plain overlay, not a separate route, so every filter
  // keeps the exact same component and state it has on the desktop layout.
  const [railOpen, setRailOpen] = useState(false);
  // The landing splash (LoadingOverlay). Mounted once per visit and dropped
  // for good when it finishes fading — switching taxonomy reloads the tree,
  // and covering the whole screen for that would hide the very change the
  // click asked for.
  const [splashDone, setSplashDone] = useState(false);
  // The welcome fork, shown once the splash clears. "welcome" until the
  // reader picks a side; the upload dialog is reachable again afterwards
  // from the toolbar, so choosing "browse" is not a one-way door.
  const [gate, setGate] = useState<"welcome" | "upload" | "tour" | "none">("welcome");
  // What the last upload added, so the tree can show it. Accessions rather
  // than ids because that is what the response carries and what survives the
  // tree re-fetch; families come from the optional BiG-SCAPE file and are
  // empty without it.
  const [uploaded, setUploaded] = useState<{ accessions: string[]; familyIds: string[] } | null>(
    null,
  );

  /** Close the drawer after an action that changes the tree, so the result
   * is visible without a second tap. Desktop keeps the rail pinned open, so
   * this is scoped to the viewport where the rail actually overlays. */
  const closeRailOnMobile = useCallback(() => {
    if (typeof window !== "undefined" && !window.matchMedia("(min-width: 1024px)").matches) {
      setRailOpen(false);
    }
  }, []);

  function toggleComparisonTaxon(taxonId: string): void {
    // Clade comparison reads corpus taxa. A clade that is only in the
    // backbone has nothing for it to compare, and would come back as an
    // error from the endpoint.
    const node = fullRoot ? findNodeByKey(fullRoot, taxonId) : null;
    if (node && !isComparable(node)) return;
    setComparisonTaxonIds((prev) =>
      prev.includes(taxonId) ? prev.filter((id) => id !== taxonId) : [...prev, taxonId],
    );
  }

  const fullRoot = useMemo(
    () => (tree ? groupUnplacedTaxa(toRootDisplayNode(tree)) : null),
    [tree],
  );
  const pruned = useMemo(
    () => (fullRoot ? pruneToBgcBearing(fullRoot, onlyWithBgcs, backboneOn) : null),
    [fullRoot, onlyWithBgcs, backboneOn],
  );
  const filtered = useMemo(
    () => (pruned ? applyGenomeFilters(pruned.root, filters, backboneOn) : null),
    [pruned, filters, backboneOn],
  );
  const focused = useMemo(
    () => (filtered ? applyFocus(filtered.root, focusKey) : null),
    [filtered, focusKey],
  );
  const root = focused?.root ?? null;
  const focusedNode = focused && focused.path.length > 0 ? focused.path[focused.path.length - 1]! : null;
  useEffect(() => {
    focusedNodeRef.current = focusedNode;
  }, [focusedNode]);

  /** The two upload highlights, over the FULL tree so they survive filtering.
   *
   * Recomputed from the tree rather than remembered from the upload
   * response, because the response's ids describe the database and this has
   * to describe what is on screen — after a re-fetch those are the same
   * genomes, but only the tree knows where they sit. */
  const uploadHighlight = useMemo(() => {
    if (!fullRoot || !uploaded) return null;
    const { lineageKeys, genomeKeys } = uploadLineage(fullRoot, uploaded.accessions);
    if (genomeKeys.size === 0) return null;
    const shared = familyMembershipSetsForAny(fullRoot, uploaded.familyIds);
    // The upload's own genome is on its lineage already; leaving it in the
    // shared set too would double-paint the tip in the wrong colour.
    const sharedFamilyKeys = new Set(
      [...shared.nodeKeys].filter((key) => !lineageKeys.has(key)),
    );
    return { lineageKeys, genomeKeys, sharedFamilyKeys };
  }, [fullRoot, uploaded]);

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

  // ----- Coverage: what has actually been surveyed --------------------------
  // Two indices, because they answer two different questions and must not be
  // swapped. The canvas needs coverage for the tree ON SCREEN — a glyph has
  // to describe the genomes under it after pruning and filtering, and the
  // API's rolled-up examined count describes the tree before them. The
  // survey-basis sentence sits beside `familyDist`, which is computed over
  // the FULL tree so its numbers are dataset properties rather than
  // artefacts of the current view; its coverage denominator has to be the
  // same population or the sentence would divide one tree by another.
  const displayedCoverage = useMemo(
    () => (root ? coverageRollupIndex(root) : null),
    [root],
  );
  const fullCoverage = useMemo(
    () => (fullRoot ? coverageRollupIndex(fullRoot) : null),
    [fullRoot],
  );
  const familySurveyBasis = useMemo(
    () =>
      fullRoot
        ? surveyBasis(familyDist, fullCoverage, coverageAt(fullCoverage, fullRoot))
        : null,
    [familyDist, fullCoverage, fullRoot],
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
  //
  // Flipping "All GTDB genomes" is not a new taxonomy, though, and used to
  // be treated as one: whatever clade the reader had focused, the switch
  // threw them back to the root of a 900,000-genome tree. The focused clade
  // now comes along. Corpus clades keep their id in the backbone, but the
  // backbone loads a level at a time, so turning it on finds the clade by
  // name and loads the path to it; turning it off keeps the focus when the
  // clade is in the corpus.
  const prevScopeRef = useRef(treeScope);
  const focusedNodeRef = useRef<TaxonTreeNode | null>(null);
  useEffect(() => {
    const scopeChanged = prevScopeRef.current !== treeScope;
    prevScopeRef.current = treeScope;
    initialCollapseApplied.current = false;
    setCollapsed(new Set());
    setActiveLevel(null);
    setSelectedFamilyId(null);
    setNodeOffsets(new Map());
    if (scopeChanged) {
      setFocusKey(null);
      setSelection(null);
      setComparisonTaxonIds([]);
      return;
    }
    const f = focusedNodeRef.current;
    if (!f || f.id === null) {
      setFocusKey(null);
    } else if (backboneOn) {
      setFocusKey(null);
      if (!pendingRevealRef.current) setPendingReveal({ name: f.name, rank: f.rank });
    } else {
      setFocusKey(isComparable(f) ? f.id : null);
    }
  }, [treeScope, backboneOn]);


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
    // With all of GTDB behind it, open on phyla rather than the three
    // domains the node budget would pick: the phyla are already loaded, and
    // they are where the contrast this mode exists for — a few dense, many
    // untouched — first shows.
    const level: CollapseLevel =
      backboneOn && ranksPresent(root).has("phylum") ? "phylum" : initialCollapseLevel(root);
    setActiveLevel(level);
    const initial = collapseToLevel(root, level);
    // A domain holding nothing from the corpus (Archaea, on the bundled
    // data) stays shut: its phyla would double the rows on screen, crowd
    // every label out, and show nothing but unexamined genomes.
    if (backboneOn) {
      for (const child of root.children) {
        if (child.rank === "domain" && child.genome_count === 0 && child.id) initial.add(child.id);
      }
    }
    setCollapsed(initial);
    setFitSignal((n) => n + 1);
  }, [root]);

  /** An upload just added genomes to the corpus.
   *
   * Re-fetch, because the tree in memory is now the one from before the
   * upload — reporting "placed on the tree" over a stale render is the
   * failure this whole path exists to avoid. Then search for what landed:
   * the search box already forces open every collapsed clade on the way to
   * a match and frames the result, which is exactly "take me to my genome"
   * and is code that is already proven rather than a second focus path. */
  function handleIngested(accessions: string[], familyIds: string[]): void {
    // Before reloadTree(), not after: the cache would otherwise hand the
    // reload the pre-upload corpus it just cached, and the refetch would
    // faithfully redraw the tree without the genome that was just added.
    invalidateApiCache();
    reloadTree();
    backbone.reload();
    if (accessions.length === 0) return;
    setUploaded({ accessions, familyIds });
    // A focus left over from earlier browsing would crop the tree to a clade
    // the new genome may not be in, and a selected family would fight the
    // upload's own highlight for the same green.
    setFocusKey(null);
    setSelectedFamilyId(null);
    // Deliberately NOT setting the search query, which is what this used to
    // do: searching dims every branch that does not match the accession —
    // precisely the shared-family branches the highlight exists to show. The
    // canvas frames itself on the highlight instead.
    setQuery("");
  }

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
    const p = new URLSearchParams(window.location.search);
    // A eukaryote link must wait for the eukaryote tree, or the clade is
    // looked for in the prokaryote one and not found.
    if (p.get("scope") === "eukaryote" && treeScope !== "eukaryote") return;
    deepLinkApplied.current = true;
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
  }, [fullRoot, treeScope]);

  // Open a requested clade in the backbone, once the backbone is on screen.
  // Not cancelled on re-run: clearing `pendingReveal` re-runs this effect,
  // and the hook already drops a response that belongs to a replaced tree.
  const revealInBackbone = backbone.reveal;
  useEffect(() => {
    if (!pendingReveal || !backboneOn) return;
    const req = pendingReveal;
    setPendingReveal(null);
    setRevealingName(req.name);
    (async () => {
      let target: { backboneId: string; nodeKey: string; rank: string | null } | null =
        "backboneId" in req ? req : null;
      if (!target) {
        const hits = await searchBackbone(treeScope, req.name, 8).catch(() => []);
        const hit = hits.find((h) => h.name === req.name && (req.rank == null || h.rank === req.rank));
        target = hit ? { backboneId: hit.backbone_id, nodeKey: hit.node_key, rank: hit.rank } : null;
      }
      if (target && (await revealInBackbone(target.backboneId))) {
        setFocusTarget({ key: target.nodeKey, parentIfLeaf: target.rank === "species" });
      }
    })().finally(() => setRevealingName(null));
  }, [pendingReveal, backboneOn, treeScope, revealInBackbone]);

  // Focus the revealed clade once the merged tree has it.
  useEffect(() => {
    if (!focusTarget || !fullRoot) return;
    const path = pathToNode(fullRoot, focusTarget.key);
    if (path.length === 0) return;
    setFocusTarget(null);
    const target =
      focusTarget.parentIfLeaf && path.length >= 2 ? path[path.length - 2]! : path[path.length - 1]!;
    focusNode(target.id);
    // focusNode is redefined each render and reads nothing stale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullRoot, focusTarget]);

  /** A GTDB search result was picked: switch the backbone on if needed,
   * open the path to the clade, and focus it. */
  function openGtdbHit(hit: BackboneSearchHit): void {
    // Focusing the clade already says where it is. Only a species keeps the
    // query, because it is shown inside its genus and needs picking out.
    setQuery(hit.rank === "species" ? hit.name : "");
    setGuideCollapsed(true);
    setView("tree");
    setPendingReveal({ backboneId: hit.backbone_id, nodeKey: hit.node_key, name: hit.name, rank: hit.rank });
    if (!showAllGenomes) setShowAllGenomes(true);
    closeRailOnMobile();
  }

  function toggleAllGenomes(): void {
    setShowAllGenomes((v) => !v);
    setGuideCollapsed(false);
  }

  /** A link that reopens this view: taxonomy, view, mode, focused clade,
   * and a single-class filter. What the deep-link reader understands. */
  function shareUrl(): string {
    const p = new URLSearchParams();
    if (taxonomy === "eukaryote") p.set("scope", "eukaryote");
    if (view !== "tree") p.set("view", view);
    if (showAllGenomes && taxonomy === "prokaryote") p.set("backbone", "1");
    if (focusedNode && focusedNode.id !== null) p.set("taxon", focusedNode.name);
    if (activeClasses.size === 1) p.set("class", [...activeClasses][0]!);
    const qs = p.toString();
    return `${window.location.origin}${window.location.pathname}${qs ? `?${qs}` : ""}`;
  }

  function selectFamily(id: string | null): void {
    setSelectedFamilyId(id);
    if (id) closeRailOnMobile();
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

  // Asked ONLY when the tree has nothing to show for the query. The
  // client-side search is richer (compounds, accessions, cluster classes,
  // none of which /search covers) and needs no round trip, so it stays the
  // primary; this exists to stop a filtered view reading as an empty
  // database. Debounced, because it fires on a keystroke.
  // The corpus's real class vocabulary. Fetched once: it is a property of
  // the database, not of the open tab, and the rail must not silently omit
  // a class the palette happens not to know about.
  const [classVocabulary, setClassVocabulary] = useState<string[] | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    fetchBgcClasses()
      .then((v) => !cancelled && setClassVocabulary(v.component_classes))
      // Falling back to the hardcoded palette is the previous behaviour, so
      // a failed lookup degrades to what shipped rather than to an empty rail.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const [offTreeMatchCount, setOffTreeMatchCount] = useState<number | null>(null);
  useEffect(() => {
    const needle = query.trim();
    if (!needle || matchCount !== 0) {
      setOffTreeMatchCount(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      search(needle, 1)
        .then((r) => !cancelled && setOffTreeMatchCount(r.total))
        // A failed supplementary lookup must not surface as an error: the
        // primary search already answered.
        .catch(() => !cancelled && setOffTreeMatchCount(null));
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, matchCount]);

  function selectLevel(level: CollapseLevel): void {
    if (!root) return;
    closeRailOnMobile();
    setActiveLevel(level);
    setAutoFramed(false);
    setCollapsed(collapseToLevel(root, level));
    setFitSignal((n) => n + 1);
  }

  function toggleCollapse(key: string): void {
    // A backbone clade that has not been fetched opens by fetching it. A
    // level preset may have put its key in `collapsed`; take it out, or the
    // children would arrive into a clade that stays shut.
    // A "N more phyla" row lists them all when clicked.
    const summaryParent = omittedSummaryParentKey(key);
    if (summaryParent !== null) {
      if (backboneOn) backbone.listAll(summaryParent);
      return;
    }
    if (backboneOn && backbone.expand(key)) {
      setActiveLevel(null);
      setAutoFramed(false);
      setCollapsed((prev) => {
        if (!prev.has(key)) return prev;
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      return;
    }
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
    <div className="flex h-[100dvh] w-full flex-col overflow-hidden bg-paper">
      {/* The page's one h1.

          The document had no h1 at all: the wordmark is an <img> and the
          only headings on screen were the <h2>s inside the two dialogs, so
          the heading outline started at level 2 and a screen reader landing
          here was told nothing about what the page IS. It is visually hidden
          rather than drawn because the wordmark already carries the name in
          the header — a second rendering of it would be the same word twice,
          which is the reason the header states for having no text beside the
          logo. */}
      <h1 className="sr-only">
        Phylo-BGC: biosynthetic gene clusters mapped onto the tree of life
      </h1>
      {/* Driven by `loading`, not by `root`: `loading` is guaranteed to
          settle (the hook clears it in a `finally`, on success and on
          failure alike), so the splash can never outlive a failed fetch and
          strand the reader on a cover with the error hidden behind it. */}
      {!splashDone && (
        <LoadingOverlay ready={!loading} onDone={() => setSplashDone(true)} />
      )}
      {/* Only after the splash has fully gone: two stacked covers would put
          the reader through a dialog they cannot see the consequences of. */}
      {splashDone && gate === "welcome" && (
        <WelcomeDialog
          onBrowse={() => setGate("none")}
          onUpload={() => setGate("upload")}
          onTour={() => setGate("tour")}
        />
      )}
      {/* Rendered outside the welcome dialog, not inside it: the tour
          spotlights the real toolbar and rail, which are behind that
          dialog's backdrop and dimmed by it. */}
      {gate === "tour" && <QuickTour onClose={() => setGate("none")} />}

      {gate === "upload" && (
        <AntismashUploadDialog
          onClose={() => setGate("none")}
          onIngested={handleIngested}
        />
      )}
      <Header query={query} onQueryChange={setQuery} genomeCount={genomeCount}
        totalGenomes={pruned?.totalGenomes ?? 0}
        matchCount={matchCount}
        offTreeMatchCount={offTreeMatchCount}
        railOpen={railOpen}
        onToggleRail={() => setRailOpen((v) => !v)}
        onHome={() => setGate("welcome")}
        taxonomyLabel={taxonomy === "eukaryote" ? "NCBI Taxonomy" : "GTDB"}
        gtdbSearch={
          backboneOffered && backbone.status
            ? {
                scope: treeScope,
                sourceLabel: `${backbone.status.source_name ?? "GTDB"} ${backbone.status.source_version ?? ""}`.trim(),
                backboneOn: showAllGenomes,
                onPick: openGtdbHit,
              }
            : null
        }>
        {/* The toolbar reads left to right as: what data (taxonomy, and
            whether all of GTDB is drawn behind it), how to look at it (view,
            and the display settings for the tree), then what to do with it
            (add genomes, take it out) and help. Settings that only change
            how the tree is drawn live in one menu, not four buttons. */}
        <div
          data-tour="taxonomy"
          className="flex flex-shrink-0 overflow-hidden rounded border border-chrome-line"
        >
          {(
            [
              ["prokaryote", "Prokaryotes", "Bacteria and archaea, on the GTDB backbone"],
              ["eukaryote", "Eukaryotes", "Fungi and plants, ranked by NCBI Taxonomy — GTDB is prokaryote-only and cannot represent them"],
            ] as const
          ).map(([id, label, hint]) => (
            <button
              key={id}
              title={hint}
              onClick={() => setTaxonomy(id)}
              aria-pressed={taxonomy === id}
              className={`whitespace-nowrap px-2.5 py-1.5 text-xs ${
                taxonomy === id
                  ? "bg-chrome-accent-wash text-chrome-accent"
                  : "text-chrome-ink-muted hover:bg-chrome-soft hover:text-chrome-ink"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* A switch, drawn as one: it adds a layer behind the tree rather
            than choosing between peers, and the old plain button read as a
            third taxonomy tab. The count says what switching it on means. */}
        {backboneOffered && (
          <button
            type="button"
            role="switch"
            aria-checked={showAllGenomes}
            data-tour="backbone"
            onClick={toggleAllGenomes}
            title={
              showAllGenomes
                ? "Back to the BGC corpus alone: only genomes this database records something for."
                : `Draw all ${backbone.status?.reference_genome_count.toLocaleString("en-US") ?? ""} ${
                    backbone.status?.source_name ?? ""
                  } genomes behind the corpus, a clade at a time. None of them has been examined for clusters.`
            }
            className={`flex flex-shrink-0 items-center gap-2 whitespace-nowrap rounded border px-2.5 py-1.5 text-xs focus:outline-none focus-visible:ring-1 focus-visible:ring-chrome-accent ${
              showAllGenomes
                ? "border-chrome-accent/50 bg-chrome-accent-wash text-chrome-accent"
                : "border-chrome-line text-chrome-ink-muted hover:bg-chrome-soft hover:text-chrome-ink"
            }`}
          >
            <span
              aria-hidden
              className={`relative inline-flex h-3.5 w-6 flex-shrink-0 items-center rounded-full transition-colors ${
                showAllGenomes ? "bg-chrome-accent" : "bg-chrome-line-strong"
              }`}
            >
              <span
                className={`absolute left-0.5 h-2.5 w-2.5 rounded-full bg-chrome transition-transform ${
                  showAllGenomes ? "translate-x-2.5" : ""
                }`}
              />
            </span>
            All {backbone.status?.source_name ?? ""} genomes
            {showAllGenomes && (backbone.loading || backbone.revealing) ? (
              <Loader2 size={12} className="animate-spin" aria-label="Loading" />
            ) : (
              <span className="font-mono text-[10px] text-chrome-ink-faint">
                {new Intl.NumberFormat("en-US", { notation: "compact" }).format(
                  backbone.status?.reference_genome_count ?? 0,
                )}
              </span>
            )}
          </button>
        )}

        <span aria-hidden className="mx-0.5 h-5 w-px flex-shrink-0 bg-chrome-line" />

        <div
          data-tour="views"
          className="flex flex-shrink-0 overflow-hidden rounded border border-chrome-line"
        >
          {(
            [
              ["tree", "Tree", "The taxonomic tree, with BGCs on each tip"],
              ["flow", "Flows", "Phylum to genus to BGC class"],
              ["heatmap", "Matrix", "Clade by BGC class"],
            ] as const
          ).map(([id, label, hint]) => (
            <button
              key={id}
              title={hint}
              onClick={() => setView(id)}
              aria-pressed={view === id}
              className={`whitespace-nowrap px-2.5 py-1.5 text-xs ${
                view === id
                  ? "bg-chrome-accent-wash text-chrome-accent"
                  : "text-chrome-ink-muted hover:bg-chrome-soft hover:text-chrome-ink"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {isTreeView && (
          <ToolbarMenu
            label="Display"
            dataTour="display"
            title="Layout and what is drawn on the tree"
            icon={<SlidersHorizontal size={13} aria-hidden />}
            width={280}
          >
            <MenuLabel>Layout</MenuLabel>
            {(["horizontal", "radial"] as const).map((mode) => (
              <MenuRadio
                key={mode}
                checked={orientation === mode}
                title={mode === "horizontal" ? "Horizontal tree" : "Circular tree"}
                icon={mode === "horizontal" ? "⊢" : "◎"}
                onSelect={() => {
                  setOrientation(mode);
                  setFitSignal((n) => n + 1);
                }}
              >
                {mode === "horizontal" ? "Horizontal" : "Circular"}
              </MenuRadio>
            ))}
            <MenuSeparator />
            <MenuLabel>Show</MenuLabel>
            <MenuCheckbox
              checked={alignedGlyphs}
              onChange={setAlignedGlyphs}
              hint="Line every cluster glyph up in one column, so rows can be compared. Off hangs them off each node."
            >
              Aligned cluster track
            </MenuCheckbox>
            <MenuCheckbox
              checked={showRegions}
              onChange={setShowRegions}
              hint="Faint shading behind each clade, to make the nesting visible."
            >
              Clade shading
            </MenuCheckbox>
            <MenuCheckbox
              checked={showTypeChart}
              onChange={setShowTypeChart}
              hint="A donut of cluster counts by class, in the corner of the tree."
            >
              BGC class chart
            </MenuCheckbox>
            <MenuSeparator />
            <MenuItem
              icon={<RotateCcw size={13} />}
              onSelect={autoArrange}
              disabled={nodeOffsets.size === 0}
              hint={
                nodeOffsets.size === 0
                  ? "Nodes can be dragged on the tree; this puts them back."
                  : `Undo ${nodeOffsets.size} dragged node${nodeOffsets.size === 1 ? "" : "s"} and re-centre.`
              }
            >
              Reset node positions
            </MenuItem>
          </ToolbarMenu>
        )}

        <span aria-hidden className="mx-0.5 h-5 w-px flex-shrink-0 bg-chrome-line" />

        {/* The upload path's permanent door. Without it the only way back
            to it would be a page reload, since the welcome fork is shown
            once per visit. */}
        <button
          data-tour="upload"
          onClick={() => setGate("upload")}
          title="Upload antiSMASH result JSON files and place those genomes on the tree"
          aria-label="Upload antiSMASH results"
          className="flex flex-shrink-0 items-center gap-1.5 whitespace-nowrap rounded border border-chrome-line px-2.5 py-1.5 text-xs text-chrome-ink-muted hover:bg-chrome-soft hover:text-chrome-ink"
        >
          <FolderUp size={13} aria-hidden />
          Upload<span className="hidden 2xl:inline"> antiSMASH</span>
        </button>

        <ExportButton
          svgRef={svgRef}
          collapsed={collapsed}
          activeClasses={activeClasses}
          selectedFamilyId={selectedFamilyId}
          comparisonTaxonIds={comparisonTaxonIds}
          searchQuery={query}
          canExportFigure={isTreeView && root !== null}
          shareUrl={shareUrl}
        />

        <ToolbarMenu
          label="Help"
          iconOnly
          align="right"
          dataTour="help"
          title="Help: the tour, and how to move around the tree"
          icon={<HelpCircle size={14} aria-hidden />}
          width={300}
        >
          <MenuItem icon={<Compass size={13} />} onSelect={() => setGate("tour")}>
            Take the quick tour
          </MenuItem>
          <MenuItem icon={<Home size={13} />} onSelect={() => setGate("welcome")}>
            Back to the start screen
          </MenuItem>
          <MenuSeparator />
          <MenuLabel>On the tree</MenuLabel>
          <MenuNote>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              {[
                ["Click a clade", "open or close it"],
                ["Double-click", "focus on that clade"],
                ["Shift-click", "add it to a comparison"],
                ["Click a genome", "show its clusters"],
                ["Drag", "pan · drag a node to move it"],
                ["Scroll or pinch", "zoom"],
              ].map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="whitespace-nowrap text-chrome-ink">{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          </MenuNote>
          <MenuSeparator />
          <MenuItem
            icon={<BookOpen size={13} />}
            onSelect={() => {
              window.location.href = "/data-sources";
            }}
          >
            Data sources and how to cite
          </MenuItem>
        </ToolbarMenu>
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
        scope={treeScope}
      />

      {isTreeView && selectedFamilyId && familyDist && (
        <DistributionSummaryBar
          family={selectedFamily}
          distribution={familyDist}
          surveyBasis={familySurveyBasis}
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

      <div className="relative flex min-h-0 flex-1">
        {/* Scrim for the mobile drawer. Below `lg` the rail floats over the
            canvas, so a tap outside it has to dismiss it — otherwise the
            only way back to the tree is the header button, which the rail
            partially covers on a narrow phone. */}
        {railOpen && (
          <div
            aria-hidden
            onClick={() => setRailOpen(false)}
            className="absolute inset-0 z-30 bg-ink/50 lg:hidden"
          />
        )}

        <aside
          data-tour="filters"
          aria-label="Controls"
          className={`chrome-scroll absolute inset-y-0 left-0 z-40 w-[17rem] max-w-[86vw] flex-shrink-0 overflow-y-auto overscroll-contain border-r border-chrome-line bg-chrome p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-2xl transition-transform duration-200 ease-out lg:static lg:z-auto lg:w-56 lg:translate-x-0 lg:shadow-none ${
            railOpen ? "translate-x-0" : "-translate-x-full"
          }`}
        >
          <div className="mb-4 flex items-center justify-between lg:hidden">
            <span className="text-xs uppercase tracking-wider text-chrome-ink-muted">Controls</span>
            <button
              onClick={() => setRailOpen(false)}
              aria-label="Close controls"
              className="-mr-1 flex h-8 w-8 items-center justify-center rounded text-chrome-ink-faint hover:bg-chrome-soft hover:text-chrome-ink"
            >
              <X size={18} />
            </button>
          </div>

          {/* Own container so `first:` applies to the first SECTION rather
              than to the rail header above it. */}
          <div className="flex flex-col">
          {/* Ordered by the question each control answers, coarsest first:
              how much tree to show, then which family to trace across it,
              then how to colour what is left, then which genomes belong in
              it at all. Spacing is owned here rather than by each section,
              so the rhythm survives a reorder — it previously lived on the
              components as ad-hoc margins that only lined up in one
              arrangement. */}
          <RailSection>
            <LevelControl
              activeLevel={activeLevel}
              availableRanks={availableRanks}
              onSelectLevel={selectLevel}
              note={
                backboneOn
                  ? "With all of GTDB drawn, a level opens only the clades already loaded. Click a clade to load deeper ranks, or search to jump straight to one."
                  : undefined
              }
            />
          </RailSection>

          <RailSection>
            <FamilyRail
              selectedFamilyId={selectedFamilyId}
              onSelectFamily={selectFamily}
              familyIndex={familyIndex}
              totalPhyla={totalPhyla}
              onFamiliesLoaded={setFamiliesList}
            />
          </RailSection>

          {/* After the family rail and before the class filter: it answers
              "which of these should I look at", which is a coarser question
              than "which classes do I want to see" and a finer one than
              "which family am I tracing". */}
          <RailSection>
            <PrioritizationPanel
              onSelectBgc={(bgcId) => setSelection({ kind: "bgc", id: bgcId })}
              selectedBgcId={selection?.kind === "bgc" ? selection.id : null}
            />
          </RailSection>

          <RailSection>
            <ClassFilterRail
              activeClasses={activeClasses}
              counts={classCounts}
              vocabulary={classVocabulary}
              onToggle={toggleClass}
              onReset={() => setActiveClasses(new Set(CLASS_ORDER))}
            />
          </RailSection>

          <RailSection>
            <label className="flex cursor-pointer items-start gap-2 py-1">
              <input
                type="checkbox"
                checked={onlyWithBgcs}
                onChange={(e) => setOnlyWithBgcs(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-[#EE95A3]"
              />
              <span className="text-sm text-chrome-ink">Only genomes with BGCs</span>
            </label>
            <p className="mb-4 mt-1 pl-6 text-xs leading-relaxed text-chrome-ink-faint">
              {pruned?.fellBackToFull ? (
                <span className="text-amber-300">
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
            <FilterPanel
              filters={filters}
              onChange={setFilters}
              matched={filtered?.matched ?? 0}
              total={pruned?.shownGenomes ?? 0}
              filteredEverythingOut={filtered?.filteredEverythingOut ?? false}
            />
            {backboneOn && filtersAreActive(filters) && (
              <p className="mt-2 text-xs leading-relaxed text-chrome-ink-faint">
                Filters test genomes, so they apply only to clades that have been opened. An
                unopened clade is drawn whole until you open it.
              </p>
            )}
          </RailSection>
          <SiteFooter />
          </div>
        </aside>

        <main
          id="main"
          tabIndex={-1}
          className={`relative min-w-0 flex-1 p-2 sm:p-4 lg:p-6 focus:outline-none ${
            isTreeView ? "overflow-hidden" : "overflow-auto"
          }`}
        >
          {/* Bottom-right, out of the tree's way. It is context for the tree,
              not a peer of it, so it sits in the corner the eye reaches last
              and never crosses the centre where the radial layout puts its
              densest structure. Hidden below lg, where the tree needs the
              whole viewport more than the breakdown does. */}
          {isTreeView && root && showTypeChart && (
            <div className="pointer-events-none absolute bottom-4 right-4 z-10 hidden lg:block">
              <BgcTypeDonut scope={treeScope} />
            </div>
          )}
          {/* Legend for the upload highlight. Two colours on a tree mean
              nothing without it, and the second line has to state what the
              green is claiming — "shares a BiG-SCAPE family" is a much
              narrower statement than "similar", and the difference is the
              whole reason the clustering file is asked for. */}
          {/* Top-left of the canvas: what the tree is showing beyond the
              corpus. Stacked, so the GTDB guide and an upload legend never
              sit on top of each other. */}
          {isTreeView && ((showAllGenomes && backboneOffered) || uploadHighlight) && (
          <div className="pointer-events-none absolute left-2 top-2 z-10 flex flex-col items-start gap-2 sm:left-4 sm:top-4">
          {showAllGenomes && backboneOffered && backbone.status && (
            <BackboneGuide
              sourceLabel={referenceSource ?? `${backbone.status.source_name ?? "GTDB"} ${backbone.status.source_version ?? ""}`.trim()}
              referenceGenomes={backbone.status.reference_genome_count}
              referenceSpecies={backbone.status.reference_species_count}
              corpusGenomes={backbone.tree?.genome_count ?? pruned?.totalGenomes ?? 0}
              loading={backbone.loading}
              error={backbone.error}
              revealing={revealingName}
              collapsed={guideCollapsed}
              onToggleCollapsed={() => setGuideCollapsed((v) => !v)}
              onRetry={backbone.reload}
              onTurnOff={() => setShowAllGenomes(false)}
            />
          )}
          {uploadHighlight && (
            <div className="pointer-events-auto max-w-xs rounded border border-line bg-card/95 px-3 py-2.5 shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-ink">Your upload</p>
                  <div className="mt-1.5 space-y-1 text-[11px] text-ink-muted">
                    <p className="flex items-center gap-1.5">
                      <span className="inline-block h-0.5 w-4 flex-shrink-0 rounded bg-signal" />
                      lineage to {uploaded?.accessions.length ?? 0} uploaded genome
                      {(uploaded?.accessions.length ?? 0) === 1 ? "" : "s"}
                    </p>
                    {uploadHighlight.sharedFamilyKeys.size > 0 ? (
                      <p className="flex items-start gap-1.5">
                        <span className="mt-1.5 inline-block h-0.5 w-4 flex-shrink-0 rounded bg-[#2C5F52]" />
                        <span>
                          shares a BiG-SCAPE family with one of your clusters
                        </span>
                      </p>
                    ) : (
                      <p className="text-ink-faint">
                        {uploaded?.familyIds.length
                          ? "No other branch carries these families."
                          : "Add a BiG-SCAPE clustering file to also mark where the same clusters occur."}
                      </p>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => setUploaded(null)}
                  aria-label="Clear the upload highlight"
                  className="-mr-1 -mt-1 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-ink-faint hover:bg-paper hover:text-ink"
                >
                  <X size={14} />
                </button>
              </div>
            </div>
          )}
          </div>
          )}
          {view === "flow" && <SankeyView scope={taxonomy} />}
          {view === "heatmap" && <HeatmapView scope={taxonomy} />}
          {isTreeView && loading && (
            // Sitting slightly above centre rather than dead-centre: the
            // optical middle of a mostly-empty stage is a little high, and
            // the provenance line hangs below the questions.
            <div className="flex h-full items-center justify-center pb-[8vh]">
              <LoadingQuestions />
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
              uploadHighlight={uploadHighlight}
              familyEnclosingKeys={familyEnclosingKeys}
              coverageIndex={displayedCoverage}
              familyLabel={selectedFamily?.label ?? null}
              fitSignal={fitSignal}
              onFocusNode={focusNode}
              nodeOffsets={nodeOffsets}
              onNodeDrag={nudgeNode}
              showRegions={showRegions}
              alignedGlyphs={alignedGlyphs}
              referenceSource={referenceSource}
              expandingKeys={backbone.expanding}
            />
          )}
        </main>

        {/* Right-hand panels. Below `lg` they dock to the bottom as a sheet
            instead of taking a 320px column out of a 375px screen — same
            components, same content, different edge. */}
        {selection ? (
          <DetailPanel
            selection={selection}
            onClose={() => setSelection(null)}
            onSelectBgc={(id) => setSelection({ kind: "bgc", id })}
            familyIds={selectedBgcFamilyIds}
            families={familiesList}
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
