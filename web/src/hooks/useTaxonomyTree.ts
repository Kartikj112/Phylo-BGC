"use client";

import { useEffect, useState } from "react";
import { fetchTaxonomyTree, type TreeScope } from "@/lib/api-client";
import type { TaxonTreeNode } from "@/lib/api-types";

interface UseTaxonomyTreeResult {
  tree: TaxonTreeNode | null;
  loading: boolean;
  error: Error | null;
}

export function useTaxonomyTree(scope: TreeScope = "all"): UseTaxonomyTreeResult {
  const [tree, setTree] = useState<TaxonTreeNode | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

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
  }, [scope]);

  return { tree, loading, error };
}
