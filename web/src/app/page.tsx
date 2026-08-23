"use client";

import { useMemo, useState } from "react";
import { ClassFilterRail } from "@/components/ClassFilterRail";
import { DetailPanel, type Selection } from "@/components/DetailPanel";
import { Header } from "@/components/Header";
import { TreeCanvas } from "@/components/TreeCanvas";
import { useTaxonomyTree } from "@/hooks/useTaxonomyTree";
import { CLASS_ORDER } from "@/lib/colors";
import { countBgcClasses, countTotalGenomes, toRootDisplayNode } from "@/lib/tree-logic";

export default function HomePage() {
  const { tree, loading, error } = useTaxonomyTree();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [activeClasses, setActiveClasses] = useState<Set<string>>(new Set(CLASS_ORDER));
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<Selection>(null);

  const root = useMemo(() => (tree ? toRootDisplayNode(tree) : null), [tree]);
  const classCounts = useMemo(() => (root ? countBgcClasses(root) : {}), [root]);
  const genomeCount = useMemo(() => (root ? countTotalGenomes(root) : 0), [root]);

  function toggleCollapse(key: string): void {
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
      <Header query={query} onQueryChange={setQuery} genomeCount={genomeCount} />

      <div className="flex min-h-0 flex-1">
        <ClassFilterRail
          activeClasses={activeClasses}
          counts={classCounts}
          onToggle={toggleClass}
          onReset={() => setActiveClasses(new Set(CLASS_ORDER))}
        />

        <div className="flex-1 overflow-auto p-6">
          {loading && <div className="text-sm text-ink-muted">Loading taxonomy tree…</div>}
          {error && (
            <div className="max-w-md text-sm text-red-700">
              Couldn&apos;t reach the API ({error.message}). Is <code className="font-mono">uvicorn
              bgcscape.api.app:app</code> running, and does <code className="font-mono">NEXT_PUBLIC_API_URL</code>{" "}
              point at it? See <code className="font-mono">web/.env.local.example</code>.
            </div>
          )}
          {root && (
            <TreeCanvas
              root={root}
              collapsed={collapsed}
              onToggleCollapse={toggleCollapse}
              activeClasses={activeClasses}
              searchQuery={query}
              selectedId={selection?.id ?? null}
              onSelectGenome={(id) => setSelection({ kind: "genome", id })}
              onSelectBgc={(id) => setSelection({ kind: "bgc", id })}
            />
          )}
        </div>

        <DetailPanel
          selection={selection}
          onClose={() => setSelection(null)}
          onSelectBgc={(id) => setSelection({ kind: "bgc", id })}
        />
      </div>
    </div>
  );
}
