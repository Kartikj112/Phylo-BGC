"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchBackbonePath, fetchBackboneStatus, fetchBackboneTree, type TreeScope } from "@/lib/api-client";
import type { BackboneStatus, BackboneTreeNode } from "@/lib/api-types";
import {
  findBackboneNode,
  isUnloaded,
  mergeBackbone,
  mergeBackboneAt,
  spliceBackboneNode,
} from "@/lib/backbone";

/** Levels fetched up front: the domains and their phyla. */
const INITIAL_DEPTH = 2;

/** Children listed per clade before the rest fold into one "N more" row.
 *
 * Every clade holding corpus genomes is listed whatever this says; it caps
 * the reference-only ones. The server's default (200) drew all of GTDB's
 * phyla at once, a fan of ~200 unlabelled lines in which the dozen with any
 * clusters were hard to find, and too dense for a single label to fit.
 * Fifteen keeps those, plus the largest of the rest for scale, and one
 * click on the summary row lists everything. */
const LISTED_CHILDREN = 15;

/** What "list them all" asks for: the server's maximum. */
const ALL_CHILDREN = 1000;

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
  /** Load every clade from the root down to `backboneId` (a search hit),
   * keeping whatever was already open. Resolves true once it is in the
   * tree, false if the request failed or the tree was replaced meanwhile. */
  reveal: (backboneId: string) => Promise<boolean>;
  /** List every child of the clade with node key `key` (the synthetic root
   * is "__root__"), in place of the "N more" summary row. */
  listAll: (key: string) => boolean;
  /** A `reveal` is in flight. */
  revealing: boolean;
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
    fetchBackboneTree(scope, null, INITIAL_DEPTH, LISTED_CHILDREN)
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
      fetchBackboneTree(scope, node.backbone_id, 1, LISTED_CHILDREN)
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

  const [revealing, setRevealing] = useState(false);
  const reveal = useCallback(
    async (backboneId: string): Promise<boolean> => {
      const mine = generation.current;
      setRevealing(true);
      try {
        const path = await fetchBackbonePath(scope, backboneId, LISTED_CHILDREN);
        if (generation.current !== mine) return false;
        setTree((prev) => (prev ? mergeBackbone(prev, path) : path));
        return true;
      } catch (err: unknown) {
        if (generation.current === mine) setError(err instanceof Error ? err : new Error(String(err)));
        return false;
      } finally {
        if (generation.current === mine) setRevealing(false);
      }
    },
    [scope],
  );

  const listAll = useCallback(
    (key: string): boolean => {
      const current = treeRef.current;
      if (!current) return false;
      const node = key === "__root__" ? current : findBackboneNode(current, key);
      if (!node || node.omitted_child_count === 0) return false;
      if (key !== "__root__" && !node.backbone_id) return false;
      const mine = generation.current;
      setExpanding((prev) => new Set(prev).add(key));
      fetchBackboneTree(scope, key === "__root__" ? null : node.backbone_id, 1, ALL_CHILDREN)
        .then((loaded) => {
          if (generation.current !== mine) return;
          setTree((prev) => (prev ? mergeBackboneAt(prev, loaded) : prev));
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

  return { status, tree, loading, error, expanding, expand, reveal, revealing, listAll, reload };
}
