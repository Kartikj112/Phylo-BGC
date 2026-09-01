import React, { useState, useMemo, useCallback } from "react";
import * as d3 from "d3";
import { Search, X, Dna, MapPin } from "lucide-react";

/* ---------------------------------------------------------------------
   Design tokens — see project ARCHITECTURE.md / this chunk's design plan.
   Calm, precise scientific instrument: quiet paper, functional color
   (color = BGC class almost everywhere it appears), hairline structure.
--------------------------------------------------------------------- */
const COLORS = {
  paper: "#F7F7F4",
  card: "#FFFFFF",
  ink: "#1C1E1B",
  inkMuted: "#5B5F58",
  inkFaint: "#9A9D95",
  line: "#DEDFDA",
  lineStrong: "#C4C6BF",
  signal: "#2C5F52",
  signalWash: "#E7EEEC",
};

const BGC_CLASS_COLORS = {
  nrps: "#8B5A3C",
  pks: "#4A6FA5",
  ripp: "#7B5EA7",
  terpene: "#5B8C5A",
  siderophore: "#A67C3D",
  saccharide: "#5B9C94",
  alkaloid: "#8B4560",
  other: "#8A8D86",
};

const BGC_CLASS_LABELS = {
  nrps: "NRPS",
  pks: "PKS",
  ripp: "RiPP",
  terpene: "Terpene",
  siderophore: "Siderophore",
  saccharide: "Saccharide",
  alkaloid: "Alkaloid",
  other: "Other",
};

const CLASS_ORDER = Object.keys(BGC_CLASS_COLORS);

function classColor(bgcClass, subtype) {
  if (bgcClass === "hybrid" && subtype) {
    const parts = subtype.toLowerCase().split("+");
    return [BGC_CLASS_COLORS[parts[0]] || COLORS.inkFaint, BGC_CLASS_COLORS[parts[1]] || COLORS.inkFaint];
  }
  return [BGC_CLASS_COLORS[bgcClass] || COLORS.inkFaint];
}

/* ---------------------------------------------------------------------
   Sample data — shaped exactly like GET /api/v1/taxonomy-tree's
   TaxonTreeNode response (engine/src/bgcscape/api/schemas.py), so this
   component's data-handling logic ports forward with minimal change once
   it's wired to the real API. Species names are real (ordinary
   nomenclature, not a factual claim needing verification); specific BGC/
   compound details are intentionally generic placeholders, not asserted
   real facts — this is an interaction-design demo, not a data product.
--------------------------------------------------------------------- */
let _id = 0;
const nid = (p) => `${p}-${_id++}`;

function genome(accession, isMag, bgcs) {
  return {
    _kind: "genome",
    id: nid("g"),
    accession,
    is_mag: isMag,
    bgcs: bgcs.map(([bgc_class, subtype, evidence, products]) => ({
      id: nid("b"),
      bgc_class,
      subtype,
      evidence_level: evidence,
      compounds: products,
    })),
  };
}

function taxon(name, rank, children, direct_genomes = []) {
  return { _kind: "taxon", id: nid("t"), name, rank, children, direct_genomes };
}

const SAMPLE_TREE = taxon("Bacteria", "domain", [
  taxon("Actinomycetota", "phylum", [
    taxon("Actinomycetes", "class", [
      taxon("Streptomycetales", "order", [
        taxon("Streptomycetaceae", "family", [
          taxon("Streptomyces", "genus", [
            taxon("Streptomyces coelicolor", "species", [], [
              genome("GCF_000203835.1", false, [
                ["nrps", null, "predicted", ["Product A"]],
                ["pks", "type II", "predicted", ["Product B"]],
              ]),
              genome("GCA_902498375.1", false, [["nrps", null, "predicted", ["Product A"]]]),
            ]),
            taxon("Streptomyces griseus", "species", [], [
              genome("GCF_000009765.2", false, [
                ["nrps", null, "observed_curated", ["Product C"]],
                ["pks", "type I", "predicted", ["Product D"]],
                ["siderophore", null, "predicted", ["Product E"]],
              ]),
            ]),
            taxon("Streptomyces avermitilis", "species", [], [
              genome("GCF_000027045.1", false, [
                ["pks", "type I", "predicted", ["Product F"]],
                ["terpene", null, "predicted", ["Product G"]],
                ["hybrid", "nrps+pks", "predicted", ["Product H"]],
              ]),
            ]),
            taxon("Streptomyces venezuelae", "species", [], [
              genome("GCA_016887265.1", true, [["ripp", "lanthipeptide", "predicted", ["Product I"]]]),
            ]),
          ]),
          taxon("Kitasatospora", "genus", [
            taxon("Kitasatospora setae", "species", [], [
              genome("GCF_000164865.1", false, [
                ["ripp", null, "predicted", ["Product J"]],
                ["saccharide", null, "predicted", ["Product K"]],
              ]),
            ]),
          ]),
        ]),
      ]),
    ]),
  ]),
  taxon("Pseudomonadota", "phylum", [
    taxon("Gammaproteobacteria", "class", [
      taxon("Enterobacterales", "order", [
        taxon("Enterobacteriaceae", "family", [
          taxon("Escherichia", "genus", [
            taxon("Escherichia coli", "species", [], [
              genome("GCF_000005845.2", false, [["siderophore", null, "observed_curated", ["Product L"]]]),
            ]),
          ]),
        ]),
      ]),
    ]),
  ]),
  taxon("Bacillota", "phylum", [
    taxon("Bacilli", "class", [
      taxon("Bacillales", "order", [
        taxon("Bacillaceae", "family", [
          taxon("Bacillus", "genus", [
            taxon("Bacillus subtilis", "species", [], [
              genome("GCF_000009045.1", false, [
                ["nrps", "surfactin-like", "predicted", ["Product M"]],
                ["ripp", null, "predicted", ["Product N"]],
              ]),
            ]),
            taxon("Bacillus velezensis", "species", [], [
              genome("GCF_000015785.2", false, [
                ["nrps", null, "predicted", ["Product O"]],
                ["pks", null, "predicted", ["Product P"]],
                ["terpene", null, "predicted", ["Product Q"]],
              ]),
            ]),
          ]),
        ]),
      ]),
    ]),
  ]),
]);

/* ---------------------------------------------------------------------
   Tree flattening + layout
--------------------------------------------------------------------- */
function toD3Children(node) {
  if (node._kind === "genome") return null;
  const kids = [...(node.children || []), ...(node.direct_genomes || [])];
  return kids.length ? kids : null;
}

function nodeLabel(node) {
  return node._kind === "genome" ? node.accession : node.name;
}

function matchesQuery(node, query) {
  if (!query) return false;
  const q = query.toLowerCase();
  return nodeLabel(node).toLowerCase().includes(q);
}

function nodeVisibleClasses(node) {
  if (node._kind === "genome") return new Set(node.bgcs.flatMap(bgcComponentClasses));
  const set = new Set();
  (node.direct_genomes || []).forEach((g) => nodeVisibleClasses(g).forEach((cl) => set.add(cl)));
  (node.children || []).forEach((c) => nodeVisibleClasses(c).forEach((cl) => set.add(cl)));
  return set;
}

// A hybrid BGC's "class" for filtering/counting purposes is its component
// classes, not the literal string "hybrid" (which isn't a real filter
// option — see CLASS_ORDER). Centralized here because getting this
// decomposition right in only *some* of the places that check BGC class
// membership (counts, but not dimming) was a real bug caught while
// verifying this component: a genome whose only NRPS activity came via a
// hybrid BGC was incorrectly dimmed when filtering to NRPS-only, since the
// dimming check compared against the literal (never-matching) "hybrid".
function bgcComponentClasses(bgc) {
  if (bgc.bgc_class === "hybrid" && bgc.subtype) return bgc.subtype.split("+");
  return [bgc.bgc_class];
}

function bgcMatchesActiveClasses(bgc, activeClasses) {
  return bgcComponentClasses(bgc).some((c) => activeClasses.has(c));
}

// Named exports alongside the default export purely so these pure
// functions can be unit-tested in isolation (see this chunk's
// render_test.cjs / logic_test.cjs) without needing to simulate clicks
// through a full React render. Harmless for the artifact runtime, which
// only ever uses the default export.
export { toD3Children, matchesQuery, nodeVisibleClasses, bgcComponentClasses, bgcMatchesActiveClasses, classColor, SAMPLE_TREE };

/* ---------------------------------------------------------------------
   Sub-components
--------------------------------------------------------------------- */
function ClassFilterRail({ activeClasses, onToggle, onReset, counts }) {
  return (
    <div className="flex flex-col gap-1 p-4" style={{ borderRight: `1px solid ${COLORS.line}` }}>
      <div className="flex items-center justify-between mb-2">
        <span
          className="text-xs uppercase tracking-wide"
          style={{ color: COLORS.inkMuted, fontFamily: "'IBM Plex Sans', sans-serif", letterSpacing: "0.08em" }}
        >
          BGC class
        </span>
        <button
          onClick={onReset}
          className="text-xs"
          style={{ color: COLORS.signal, fontFamily: "'IBM Plex Sans', sans-serif" }}
        >
          Reset
        </button>
      </div>
      {CLASS_ORDER.map((cls) => {
        const active = activeClasses.has(cls);
        const count = counts[cls] || 0;
        return (
          <button
            key={cls}
            onClick={() => onToggle(cls)}
            disabled={count === 0}
            className="flex items-center gap-2 px-2 py-1.5 rounded text-left transition-opacity"
            style={{
              opacity: count === 0 ? 0.35 : active ? 1 : 0.45,
              backgroundColor: active ? COLORS.signalWash : "transparent",
            }}
          >
            <span
              className="inline-block rounded-full flex-shrink-0"
              style={{ width: 10, height: 10, backgroundColor: BGC_CLASS_COLORS[cls] }}
            />
            <span className="text-sm flex-1" style={{ color: COLORS.ink, fontFamily: "'IBM Plex Sans', sans-serif" }}>
              {BGC_CLASS_LABELS[cls]}
            </span>
            <span
              className="text-xs tabular-nums"
              style={{ color: COLORS.inkFaint, fontFamily: "'IBM Plex Mono', monospace" }}
            >
              {count}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function DetailPanel({ item, onClose }) {
  if (!item) return null;
  const isGenome = item._kind === "genome";
  return (
    <div
      className="w-80 flex-shrink-0 flex flex-col"
      style={{ borderLeft: `1px solid ${COLORS.line}`, backgroundColor: COLORS.card }}
    >
      <div className="flex items-start justify-between p-4" style={{ borderBottom: `1px solid ${COLORS.line}` }}>
        <div>
          <div
            className="text-xs uppercase tracking-wide mb-1"
            style={{ color: COLORS.inkMuted, fontFamily: "'IBM Plex Sans', sans-serif", letterSpacing: "0.08em" }}
          >
            {isGenome ? "Genome" : "BGC"}
          </div>
          <div
            className="text-sm"
            style={{
              color: COLORS.ink,
              fontFamily: isGenome ? "'IBM Plex Mono', monospace" : "'IBM Plex Sans', sans-serif",
            }}
          >
            {isGenome ? item.accession : BGC_CLASS_LABELS[item.bgc_class]}
          </div>
        </div>
        <button onClick={onClose} style={{ color: COLORS.inkFaint }}>
          <X size={16} />
        </button>
      </div>

      <div className="p-4 overflow-y-auto flex-1">
        {isGenome ? (
          <>
            <div className="flex items-center gap-2 mb-4">
              <MapPin size={14} style={{ color: COLORS.inkFaint }} />
              <span className="text-xs" style={{ color: COLORS.inkMuted, fontFamily: "'IBM Plex Sans', sans-serif" }}>
                {item.is_mag ? "Metagenome-assembled genome" : "Isolate genome assembly"}
              </span>
            </div>
            <div
              className="text-xs uppercase tracking-wide mb-2"
              style={{ color: COLORS.inkMuted, fontFamily: "'IBM Plex Sans', sans-serif", letterSpacing: "0.08em" }}
            >
              Biosynthetic gene clusters ({item.bgcs.length})
            </div>
            <div className="flex flex-col gap-2">
              {item.bgcs.map((b) => (
                <div key={b.id} className="p-2 rounded" style={{ border: `1px solid ${COLORS.line}` }}>
                  <div className="flex items-center gap-2">
                    {classColor(b.bgc_class, b.subtype).map((c, i) => (
                      <span key={i} className="inline-block rounded-full" style={{ width: 8, height: 8, backgroundColor: c }} />
                    ))}
                    <span className="text-sm" style={{ color: COLORS.ink, fontFamily: "'IBM Plex Sans', sans-serif" }}>
                      {b.bgc_class === "hybrid"
                        ? b.subtype.split("+").map((c) => BGC_CLASS_LABELS[c]).join(" + ")
                        : BGC_CLASS_LABELS[b.bgc_class]}
                    </span>
                  </div>
                  {b.subtype && b.bgc_class !== "hybrid" && (
                    <div className="text-xs mt-1" style={{ color: COLORS.inkMuted, fontFamily: "'IBM Plex Sans', sans-serif" }}>
                      {b.subtype}
                    </div>
                  )}
                  <div
                    className="text-xs mt-1 uppercase tracking-wide"
                    style={{
                      color: b.evidence_level === "observed_curated" ? COLORS.signal : COLORS.inkFaint,
                      fontFamily: "'IBM Plex Sans', sans-serif",
                      letterSpacing: "0.04em",
                    }}
                  >
                    {b.evidence_level === "observed_curated" ? "Curated reference" : "Predicted"}
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <>
            {item.subtype && (
              <div className="mb-3">
                <div className="text-xs uppercase tracking-wide mb-1" style={{ color: COLORS.inkMuted, fontFamily: "'IBM Plex Sans', sans-serif" }}>
                  Subtype
                </div>
                <div className="text-sm" style={{ color: COLORS.ink, fontFamily: "'IBM Plex Sans', sans-serif" }}>
                  {item.subtype}
                </div>
              </div>
            )}
            <div>
              <div className="text-xs uppercase tracking-wide mb-1" style={{ color: COLORS.inkMuted, fontFamily: "'IBM Plex Sans', sans-serif" }}>
                Known / predicted products
              </div>
              {item.compounds.map((name, i) => (
                <div key={i} className="text-sm" style={{ color: COLORS.ink, fontFamily: "'IBM Plex Sans', sans-serif" }}>
                  {name}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------
   Main tree canvas
--------------------------------------------------------------------- */
function TreeCanvas({ data, collapsed, onToggleCollapse, activeClasses, searchQuery, selectedId, onSelect }) {
  const pruned = useMemo(() => {
    function prune(node) {
      const kids = toD3Children(node);
      const copy = { ...node };
      if (!kids) return copy;
      if (collapsed.has(node.id)) {
        copy._hiddenChildren = kids.length;
        return copy;
      }
      copy.children = node.children ? node.children.map(prune) : undefined;
      copy.direct_genomes = node.direct_genomes;
      return copy;
    }
    return prune(data);
  }, [data, collapsed]);

  const { nodes, links, height } = useMemo(() => {
    const root = d3.hierarchy(pruned, (n) => toD3Children(n));
    const leafCount = root.leaves().length;
    const h = Math.max(leafCount * 34, 200);
    const w = 760;
    d3.tree().size([h, w]).separation((a, b) => (a.parent === b.parent ? 1 : 1.4))(root);
    return { nodes: root.descendants(), links: root.links(), height: h + 40 };
  }, [pruned]);

  const linkGen = d3.linkHorizontal().x((d) => d.y).y((d) => d.x);
  const dimAll = activeClasses.size < CLASS_ORDER.length;

  return (
    <svg width="100%" height={height} viewBox={`0 0 900 ${height}`} style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}>
      <g transform="translate(30,20)">
        {links.map((l, i) => (
          <path key={i} d={linkGen(l)} fill="none" stroke={COLORS.lineStrong} strokeWidth={1.25} />
        ))}
        {nodes.map((n) => {
          const isGenome = n.data._kind === "genome";
          const isMatch = matchesQuery(n.data, searchQuery);
          const dimmed = dimAll && !isGenome && ![...nodeVisibleClasses(n.data)].some((c) => activeClasses.has(c));
          const genomeDimmed = dimAll && isGenome && !n.data.bgcs.some((b) => bgcMatchesActiveClasses(b, activeClasses));

          return (
            <g key={n.data.id} transform={`translate(${n.y},${n.x})`} opacity={dimmed || genomeDimmed ? 0.25 : 1}>
              {!isGenome && (
                <circle
                  r={4.5}
                  fill={n.data._hiddenChildren ? COLORS.signal : COLORS.paper}
                  stroke={COLORS.ink}
                  strokeWidth={1.25}
                  style={{ cursor: "pointer" }}
                  onClick={() => onToggleCollapse(n.data.id)}
                />
              )}
              {!isGenome && (
                <text
                  x={-9}
                  textAnchor="end"
                  dy="0.32em"
                  fontStyle={n.data.rank === "species" ? "italic" : "normal"}
                  fontSize={n.data.rank === "domain" || n.data.rank === "phylum" ? 13 : 12}
                  fontWeight={n.data.rank === "domain" || n.data.rank === "phylum" ? 600 : 400}
                  fill={isMatch ? COLORS.signal : COLORS.ink}
                  style={{ cursor: "default" }}
                >
                  {n.data.name}
                  {n.data._hiddenChildren ? ` (+${n.data._hiddenChildren})` : ""}
                </text>
              )}

              {isGenome && (
                <g
                  style={{ cursor: "pointer" }}
                  onClick={() => onSelect(n.data)}
                  opacity={selectedId && selectedId !== n.data.id ? 0.55 : 1}
                >
                  <text
                    x={10}
                    dy="0.32em"
                    fontSize={11.5}
                    fill={isMatch ? COLORS.signal : COLORS.inkMuted}
                    fontFamily="'IBM Plex Mono', monospace"
                  >
                    {n.data.accession}
                  </text>
                  {n.data.bgcs.map((b, i) => {
                    const colors = classColor(b.bgc_class, b.subtype);
                    const x = 132 + i * 11;
                    return (
                      <g key={b.id} onClick={(e) => { e.stopPropagation(); onSelect(b); }}>
                        {colors.length === 1 ? (
                          <rect x={x} y={-5} width={7} height={10} fill={colors[0]} rx={1} />
                        ) : (
                          <>
                            <rect x={x} y={-5} width={3.5} height={10} fill={colors[0]} />
                            <rect x={x + 3.5} y={-5} width={3.5} height={10} fill={colors[1]} />
                          </>
                        )}
                      </g>
                    );
                  })}
                  {n.data.is_mag && (
                    <text x={132 + n.data.bgcs.length * 11 + 6} dy="0.32em" fontSize={9.5} fill={COLORS.inkFaint}>
                      MAG
                    </text>
                  )}
                </g>
              )}
            </g>
          );
        })}
      </g>
    </svg>
  );
}

/* ---------------------------------------------------------------------
   Root component
--------------------------------------------------------------------- */
export default function BGCScapeTreeExplorer() {
  const [collapsed, setCollapsed] = useState(new Set());
  const [activeClasses, setActiveClasses] = useState(new Set(CLASS_ORDER));
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(null);

  const classCounts = useMemo(() => {
    const counts = {};
    CLASS_ORDER.forEach((c) => (counts[c] = 0));
    function walk(node) {
      if (node._kind === "genome") {
        node.bgcs.forEach((b) => {
          bgcComponentClasses(b).forEach((c) => (counts[c] = (counts[c] || 0) + 1));
        });
      }
      (node.children || []).forEach(walk);
      (node.direct_genomes || []).forEach(walk);
    }
    walk(SAMPLE_TREE);
    return counts;
  }, []);

  const toggleCollapse = useCallback((id) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  const toggleClass = useCallback((cls) => {
    setActiveClasses((prev) => {
      const next = new Set(prev);
      next.has(cls) ? next.delete(cls) : next.add(cls);
      return next.size === 0 ? new Set(CLASS_ORDER) : next;
    });
  }, []);

  const totalGenomes = useMemo(() => {
    let n = 0;
    (function walk(node) {
      (node.direct_genomes || []).forEach(() => n++);
      (node.children || []).forEach(walk);
    })(SAMPLE_TREE);
    return n;
  }, []);

  return (
    <div className="w-full h-full flex flex-col" style={{ backgroundColor: COLORS.paper, minHeight: 640 }}>
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap"
      />

      {/* Header */}
      <div
        className="flex items-center gap-4 px-4 py-3 flex-shrink-0"
        style={{ borderBottom: `1px solid ${COLORS.line}`, backgroundColor: COLORS.card }}
      >
        <div className="flex items-center gap-2">
          <Dna size={18} style={{ color: COLORS.signal }} />
          <span className="text-sm font-semibold tracking-wide" style={{ color: COLORS.ink, fontFamily: "'IBM Plex Sans', sans-serif" }}>
            Phylo-BGC
          </span>
        </div>
        <div className="flex-1 max-w-xs relative">
          <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2" style={{ color: COLORS.inkFaint }} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search organism or accession"
            className="w-full pl-7 pr-2 py-1.5 text-sm rounded outline-none"
            style={{
              border: `1px solid ${COLORS.line}`,
              color: COLORS.ink,
              fontFamily: "'IBM Plex Sans', sans-serif",
              backgroundColor: COLORS.paper,
            }}
          />
        </div>
        <span className="text-xs ml-auto" style={{ color: COLORS.inkFaint, fontFamily: "'IBM Plex Mono', monospace" }}>
          {totalGenomes} genomes · taxonomic tree (GTDB) · sample data
        </span>
      </div>

      {/* Body */}
      <div className="flex flex-1 min-h-0">
        <ClassFilterRail activeClasses={activeClasses} onToggle={toggleClass} onReset={() => setActiveClasses(new Set(CLASS_ORDER))} counts={classCounts} />

        <div className="flex-1 overflow-auto p-6">
          <TreeCanvas
            data={SAMPLE_TREE}
            collapsed={collapsed}
            onToggleCollapse={toggleCollapse}
            activeClasses={activeClasses}
            searchQuery={query}
            selectedId={selected?.id}
            onSelect={setSelected}
          />
        </div>

        <DetailPanel item={selected} onClose={() => setSelected(null)} />
      </div>
    </div>
  );
}
