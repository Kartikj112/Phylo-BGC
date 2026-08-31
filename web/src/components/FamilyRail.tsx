"use client";

import { Layers, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { fetchFamilies } from "@/lib/api-client";
import type { BGCFamilySummary } from "@/lib/api-types";
import type { FamilyIndexEntry } from "@/lib/tree-logic";

import { BGC_CLASS_COLORS, COLORS } from "@/lib/colors";

/** The two kinds of grouping, as typed by the API's `BGCFamily.kind`.
 * Previously inferred by string-matching `clustering_method`, which was
 * fragile — the engine now ships the distinction as a CHECK-constrained
 * enum precisely because conflating the two produced wrong science. */
const COMPOUND_GROUP = "compound_group";

interface FamilyRailProps {
  selectedFamilyId: string | null;
  onSelectFamily: (familyId: string | null) => void;
  /** Per-family distribution summary computed once from the full tree —
   * lets rows show "N genera / M phyla" and lets the list sort by
   * distribution shape without a request or a per-family full analysis. */
  familyIndex: Map<string, FamilyIndexEntry>;
  totalPhyla: number;
  onFamiliesLoaded?: (families: BGCFamilySummary[]) => void;
}

type SortMode = "members" | "genomes" | "scattered" | "confined";

const SORTS: { id: SortMode; label: string; hint: string }[] = [
  { id: "members", label: "Most BGCs", hint: "families with the most member clusters first" },
  { id: "genomes", label: "Most genomes", hint: "carried by the most genomes first" },
  { id: "scattered", label: "Most scattered", hint: "spanning the most genera — possible transfer or convergence signal" },
  { id: "confined", label: "Most confined", hint: "restricted to the fewest genera first" },
];

/**
 * The GCF browser. Selecting a family here is what turns the whole
 * interface into an answer to "where is this family across the tree" — so
 * it needs to be searchable and rankable by distribution, not just a flat
 * list. Each row previews the distribution (genomes · genera · phyla) so a
 * choice can be made before committing the main view to it.
 */
export function FamilyRail({
  selectedFamilyId,
  onSelectFamily,
  familyIndex,
  totalPhyla,
  onFamiliesLoaded,
}: FamilyRailProps) {
  const [families, setFamilies] = useState<BGCFamilySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortMode>("members");

  useEffect(() => {
    let cancelled = false;
    fetchFamilies()
      .then((data) => {
        if (cancelled) return;
        setFamilies(data);
        onFamiliesLoaded?.(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // onFamiliesLoaded is a stable setter from the parent
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // What KIND of grouping is loaded. A BiG-SCAPE run or a BiG-FAM export
  // produces sequence-based gene cluster families; `bgcscape
  // group-by-compound` produces groups of clusters that make the same
  // curated compound. They are different claims, so the rail names whichever
  // it actually has rather than calling both "families". Mixed corpora get
  // the neutral term.
  const kind = useMemo(() => {
    const methods = new Set(families.map((f) => f.kind));
    if (methods.size === 1 && methods.has(COMPOUND_GROUP)) {
      return {
        title: "Compound groups",
        blurb:
          "Clusters MIBiG records as making the same compound. A curated experimental link, not a sequence clustering.",
        unit: "group",
      };
    }
    if (methods.size > 0 && ![...methods].some((m) => m === COMPOUND_GROUP)) {
      return {
        title: "Gene cluster families",
        // Deliberately does not name the tool: sequence families reach this
        // corpus from a local BiG-SCAPE run OR from a BiG-FAM export, and
        // naming one when the other produced them would misattribute the
        // grouping. The panel for a selected family shows its actual method.
        blurb: "Clusters grouped by gene content and domain architecture.",
        unit: "family",
      };
    }
    return {
      title: "Cluster groups",
      blurb: "Mixed grouping methods — each row shows the method it came from.",
      unit: "group",
    };
  }, [families]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? families.filter(
          (f) =>
            f.label.toLowerCase().includes(q) ||
            f.taxon_names.some((t) => t.toLowerCase().includes(q)),
        )
      : families;

    const idxOf = (f: BGCFamilySummary) => familyIndex.get(f.id);
    const sorted = [...filtered].sort((a, b) => {
      const ia = idxOf(a);
      const ib = idxOf(b);
      switch (sort) {
        case "genomes":
          return (ib?.genomeCount ?? 0) - (ia?.genomeCount ?? 0) || a.label.localeCompare(b.label);
        case "scattered":
          return (
            (ib?.genusCount ?? 0) - (ia?.genusCount ?? 0) ||
            (ib?.phylumCount ?? 0) - (ia?.phylumCount ?? 0) ||
            a.label.localeCompare(b.label)
          );
        case "confined":
          return (
            (ia?.genusCount ?? 99) - (ib?.genusCount ?? 99) ||
            (ia?.genomeCount ?? 0) - (ib?.genomeCount ?? 0) ||
            a.label.localeCompare(b.label)
          );
        default:
          return b.member_count - a.member_count || a.label.localeCompare(b.label);
      }
    });
    return sorted;
  }, [families, familyIndex, query, sort]);

  return (
    <div className="mt-6 border-t border-chrome-line pt-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-chrome-ink-muted">
          <Layers size={12} />
          {kind.title}
        </span>
        {selectedFamilyId && (
          <button onClick={() => onSelectFamily(null)} className="py-1 text-xs text-chrome-accent hover:underline">
            Clear
          </button>
        )}
      </div>

      {!loading && !error && families.length > 0 && (
        <>
          <p className="mb-2 text-[11px] leading-relaxed text-chrome-ink-faint">{kind.blurb}</p>
          <div className="relative mb-1.5">
            <Search size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-chrome-ink-faint" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter by name or organism"
              className="w-full rounded border border-chrome-line bg-chrome-soft py-1.5 pl-7 pr-2 text-xs text-chrome-ink placeholder:text-chrome-ink-faint outline-none focus:border-chrome-accent"
            />
          </div>
          <div className="mb-2 flex flex-wrap gap-1">
            {SORTS.map((s) => (
              <button
                key={s.id}
                onClick={() => setSort(s.id)}
                title={s.hint}
                className={`rounded border px-2 py-1 text-[11px] ${
                  sort === s.id
                    ? "border-chrome-accent bg-chrome-accent-wash text-chrome-accent"
                    : "border-chrome-line text-chrome-ink-muted hover:bg-chrome-soft hover:text-chrome-ink"
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        </>
      )}

      {loading && <div className="text-xs text-chrome-ink-faint">Loading…</div>}
      {error && <div className="text-xs text-red-300">{error}</div>}
      {!loading && !error && families.length === 0 && (
        <div className="text-xs leading-relaxed text-chrome-ink-faint">
          No groups yet. Run <span className="font-mono">bgcscape group-by-compound</span> to group
          clusters by their curated product, or{" "}
          <span className="font-mono">bgcscape ingest bigfam</span> to load a real gene cluster
          family from a BiG-FAM export.
        </div>
      )}
      {!loading && !error && families.length > 0 && rows.length === 0 && (
        <div className="text-xs text-chrome-ink-faint">No {kind.unit} matches “{query}”.</div>
      )}

      <div className="chrome-scroll flex max-h-[40vh] flex-col gap-0.5 overflow-y-auto pr-1">
        {rows.map((family) => {
          const selected = family.id === selectedFamilyId;
          const idx = familyIndex.get(family.id);
          const genera = idx?.genusCount ?? 0;
          const phyla = idx?.phylumCount ?? 0;
          const genomes = idx?.genomeCount ?? 0;
          const scattered = genera > 1;
          return (
            <button
              key={family.id}
              onClick={() => onSelectFamily(selected ? null : family.id)}
              className={`rounded px-2 py-2 text-left transition-colors ${
                selected
                  ? "bg-chrome-accent-wash ring-1 ring-chrome-accent/50"
                  : "hover:bg-chrome-soft"
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="flex gap-0.5">
                  {family.bgc_classes.slice(0, 3).map((cls) => (
                    <span
                      key={cls}
                      className="inline-block h-2 w-2 rounded-full"
                      style={{ backgroundColor: BGC_CLASS_COLORS[cls] ?? "#8A8D86" }}
                    />
                  ))}
                </span>
                <span className="flex-1 truncate font-mono text-xs text-chrome-ink">{family.label}</span>
                {/* A group keyed on a product CATEGORY ("carotenoid") means
                 * "both make some carotenoid", not "both make the same
                 * molecule" — a materially weaker claim, and the largest
                 * groups in the bundled corpus are exactly these. The engine
                 * flags them; showing the flag is what makes the difference
                 * visible instead of implied. */}
                {family.is_generic_product && (
                  <span
                    className="rounded-sm bg-chrome-soft px-1 py-px font-mono text-[9px] uppercase tracking-wide text-chrome-ink-faint ring-1 ring-chrome-line"
                    title="Product category, not a single compound: members make some molecule of this class, not necessarily the same one."
                  >
                    category
                  </span>
                )}
                <span className="font-mono text-xs tabular-nums text-chrome-ink-faint">
                  {family.member_count}
                </span>
              </div>

              <div className="mt-1 flex items-center gap-2">
                {/* phylum-reach glyph: filled ticks = phyla carrying it */}
                {totalPhyla > 0 && (
                  <span className="flex gap-[2px]" title={`${phyla} of ${totalPhyla} phyla`}>
                    {Array.from({ length: Math.min(totalPhyla, 8) }).map((_, i) => (
                      <span
                        key={i}
                        className="inline-block h-2.5 w-1 rounded-[1px]"
                        style={{ backgroundColor: i < phyla ? COLORS.chromeAccent : COLORS.chromeLineStrong }}
                      />
                    ))}
                  </span>
                )}
                <span className="font-mono text-[11px] text-chrome-ink-faint">
                  {genomes}g · {genera}gen{phyla > 0 ? ` · ${phyla}phy` : ""}
                </span>
                {scattered && (
                  <span className="ml-auto text-[11px] text-chrome-accent">scattered</span>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
