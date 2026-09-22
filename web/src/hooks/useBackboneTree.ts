"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchBackboneStatus, fetchBackboneTree, type TreeScope } from "@/lib/api-client";
import type { BackboneStatus, BackboneTreeNode } from "@/lib/api-types";
import { findBackboneNode, isUnloaded, spliceBackboneNode } from "@/lib/backbone";

/** Levels fetched up front: the domains and their phyla (~200 clades on GTDB). */
const INITIAL_DEPTH = 2;

interface UseBackboneTreeResult {
  /** Whether a backbone exists for this scope. Null until the answer arrives. */
  status: BackboneStatus | null;
  tree: BackboneTreeNode | null;
  loading: boolean;
  error: Error | null;
  /** Keys (node ids) of clades whose children are being fetched. */
  expanding: ReadonlySet<string>;
  /** Fetch the children of the clade with node key `key`, if it has not had
   * them yet. Returns whether a fetch was started. */
  expand: (key: string) => boolean;
  reload: () => void;
}

/**
 * The reference backbone for `scope`, grown as the reader opens clades.
 *
 * `status` is always fetched, because the toggle that switches this on is
 * only offered when a backbone exists. The tree itself is fetched only while
 * `enabled`, so the corpus-only view pays nothing for it.
 */
export function useBackboneTree(scope: TreeScope, enabled: boolean): UseBackboneTreeResult {
  const [status, setStatus] = useState<BackboneStatus | null>(null);
  const [tree, setTree] = useState<BackboneTreeNode | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [expanding, setExpanding] = useState<ReadonlySet<string>>(new Set());
  const [reloadToken, setReloadToken] = useState(0);
  const reload = useCallback(() => setReloadToken((n) => n + 1), []);
  // The tree a pending expansion belongs to. A response that lands after a
  // taxonomy switch or reload must not be spliced into the new tree.
  const generation = useRef(0);
  const treeRef = useRef<BackboneTreeNode | null>(null);
  useEffect(() => {
    treeRef.current = tree;
  }, [tree]);

  useEffect(() => {
    let cancelled = false;
    setStatus(null);
    fetchBackboneStatus(scope)
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch(() => {
        // An API without the endpoint (an older deployment) simply has no
        // backbone to offer; the toggle stays hidden.
        if (!cancelled) setStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, [scope, reloadToken]);

  const available = status?.available === true;
  useEffect(() => {
    generation.current += 1;
    setTree(null);
    setExpanding(new Set());
    setError(null);
    if (!enabled || !available) {
      setLoading(false);
      return;
    }
    const mine = generation.current;
    setLoading(true);
    fetchBackboneTree(scope, null, INITIAL_DEPTH)
      .then((root) => {
        if (generation.current === mine) setTree(root);
      })
      .catch((err: unknown) => {
        if (generation.current === mine) setError(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        if (generation.current === mine) setLoading(false);
      });
  }, [scope, enabled, available, reloadToken]);

  const expand = useCallback(
    (key: string): boolean => {
      const current = treeRef.current;
      if (!current) return false;
      const node = findBackboneNode(current, key);
      if (!node || !isUnloaded(node) || !node.backbone_id) return false;
      const mine = generation.current;
      setExpanding((prev) => new Set(prev).add(key));
      fetchBackboneTree(scope, node.backbone_id, 1)
        .then((loaded) => {
          if (generation.current !== mine) return;
          setTree((prev) => (prev ? spliceBackboneNode(prev, loaded) : prev));
        })
        .catch((err: unknown) => {
          if (generation.current === mine) setError(err instanceof Error ? err : new Error(String(err)));
        })
        .finally(() => {
          if (generation.current !== mine) return;
          setExpanding((prev) => {
            const next = new Set(prev);
            next.delete(key);
            return next;
          });
        });
      return true;
    },
    [scope],
  );

  return { status, tree, loading, error, expanding, expand, reload };
}
