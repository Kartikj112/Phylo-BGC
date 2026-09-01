"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchTaxonomyTree, type TreeScope } from "@/lib/api-client";
import type { TaxonTreeNode } from "@/lib/api-types";

interface UseTaxonomyTreeResult {
  tree: TaxonTreeNode | null;
  loading: boolean;
  error: Error | null;
  /** Re-fetch the current scope. Needed because the corpus is no longer
   * read-only: an antiSMASH upload adds a genome, and without this the
   * reader would be told it succeeded while looking at the tree from
   * before it. */
  reload: () => void;
}

export function useTaxonomyTree(scope: TreeScope = "all"): UseTaxonomyTreeResult {
  const [tree, setTree] = useState<TaxonTreeNode | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const reload = useCallback(() => setReloadToken((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    fetchTaxonomyTree(scope)
      .then((data) => {
        if (cancelled) return;
        setTree(data);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [scope, reloadToken]);

  return { tree, loading, error, reload };
}
