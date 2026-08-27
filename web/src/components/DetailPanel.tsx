"use client";

import { ExternalLink, MapPin, Share2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { fetchBgc, fetchGenome } from "@/lib/api-client";
import type { BGCDetail, GenomeDetail } from "@/lib/api-types";
import { BGC_CLASS_LABELS, classColor } from "@/lib/colors";

export type Selection = { kind: "genome"; id: string } | { kind: "bgc"; id: string } | null;

interface DetailPanelProps {
  selection: Selection;
  onClose: () => void;
  onSelectBgc: (bgcId: string) => void;
  /** Families the selected BGC belongs to (from the tree payload's
   * family_ids). Lets the panel pivot from one cluster to "where is this
   * cluster's family across the tree". */
  familyIds?: string[];
  onShowFamily?: (familyId: string) => void;
}

export function DetailPanel({ selection, onClose, onSelectBgc, familyIds, onShowFamily }: DetailPanelProps) {
  const [genome, setGenome] = useState<GenomeDetail | null>(null);
  const [bgc, setBgc] = useState<BGCDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setGenome(null);
    setBgc(null);
    setError(null);
    if (!selection) return;

    let cancelled = false;
    setLoading(true);
    const request = selection.kind === "genome" ? fetchGenome(selection.id) : fetchBgc(selection.id);
    request
      .then((data) => {
        if (cancelled) return;
        if (selection.kind === "genome") setGenome(data as GenomeDetail);
        else setBgc(data as BGCDetail);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the primitive id, not the Selection object identity
  }, [selection?.kind, selection?.id]);

  if (!selection) return null;

  return (
    <div className="flex w-80 flex-shrink-0 flex-col border-l border-line bg-card">
      <div className="flex items-start justify-between border-b border-line p-4">
        <span className="text-xs uppercase tracking-wider text-ink-muted">
          {selection.kind === "genome" ? "Genome" : "BGC"}
        </span>
        <button onClick={onClose} aria-label="Close detail panel" className="text-ink-faint hover:text-ink">
          <X size={16} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {loading && <div className="text-sm text-ink-muted">Loading…</div>}
        {error && <div className="text-sm text-red-700">{error}</div>}
        {genome && <GenomeDetailView genome={genome} onSelectBgc={onSelectBgc} />}
        {bgc && (
          <BgcDetailView bgc={bgc} familyIds={familyIds ?? []} onShowFamily={onShowFamily} />
        )}
      </div>
    </div>
  );
}

function EvidenceBadge({ level }: { level: string }) {
  const curated = level === "observed_curated";
  return (
    <div
      className="mt-1 text-xs uppercase tracking-wide"
      style={{ color: curated ? "#2C5F52" : "#9A9D95" }}
    >
      {curated ? "Curated reference" : "Predicted"}
    </div>
  );
}

type GenomeTab = "overview" | "bgcs" | "info" | "lineage";

/** External resources, generated from the accession rather than
 * hardcoded. antiSMASH DB is deliberately omitted: it only resolves for
 * genomes that happen to be in that database, and a link that 404s for
 * most genomes is worse than no link. */
function externalLinks(accession: string) {
  const bare = accession.replace(/^(RS_|GB_)/, "");
  const isAssembly = /^GC[AF]_/.test(bare);
  return [
    {
      label: "NCBI",
      href: isAssembly
        ? `https://www.ncbi.nlm.nih.gov/datasets/genome/${encodeURIComponent(bare)}/`
        : `https://www.ncbi.nlm.nih.gov/nuccore/${encodeURIComponent(bare)}`,
    },
    ...(isAssembly
      ? [{ label: "GTDB", href: `https://gtdb.ecogenomic.org/genome?gid=${encodeURIComponent(bare)}` }]
      : []),
  ];
}

function GenomeDetailView({ genome, onSelectBgc }: { genome: GenomeDetail; onSelectBgc: (id: string) => void }) {
  const [tab, setTab] = useState<GenomeTab>("overview");
  const tabs: { id: GenomeTab; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "bgcs", label: `BGCs (${genome.bgcs.length})` },
    { id: "info", label: "Genome" },
    { id: "lineage", label: "Lineage" },
  ];
  return (
    <>
      <div className="mb-1 flex items-center gap-2">
        <span
          className="inline-block h-2 w-2 rounded-full"
          style={{ backgroundColor: genome.bgcs.length > 0 ? "#5B8C5A" : "#9A9D95" }}
          title={genome.bgcs.length > 0 ? "Has predicted BGCs" : "No BGCs recorded"}
        />
        <span className="font-mono text-sm text-ink">{genome.accession}</span>
      </div>
      {genome.taxon_name && <div className="mb-2 text-sm italic text-ink-muted">{genome.taxon_name}</div>}

      {genome.lineage.length > 0 && (
        <div className="mb-3 text-xs leading-relaxed text-ink-faint">
          {genome.lineage.map((step, i) => (
            <span key={`${step.rank}-${step.name}`}>
              {i > 0 && <span className="mx-1">→</span>}
              <span className={step.rank === "species" ? "italic" : ""}>{step.name}</span>
            </span>
          ))}
        </div>
      )}

      <div className="mb-3 flex gap-1 border-b border-line">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`-mb-px border-b-2 px-2 py-1 text-xs ${
              tab === t.id ? "border-signal text-signal" : "border-transparent text-ink-muted hover:text-ink"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "info" && (
        <div className="mb-4 flex items-center gap-2">
          <MapPin size={14} className="text-ink-faint" />
          <span className="text-xs text-ink-muted">
            {genome.is_mag ? "Metagenome-assembled genome" : "Isolate genome assembly"}
          </span>
        </div>
      )}

      {tab === "info" && (genome.genome_size_bp != null || genome.completeness_pct != null) && (
        <dl className="mb-4 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
          {genome.genome_size_bp != null && (
            <>
              <dt className="text-ink-faint">Genome size</dt>
              <dd className="font-mono text-ink">{genome.genome_size_bp.toLocaleString()} bp</dd>
            </>
          )}
          {genome.gc_content_pct != null && (
            <>
              <dt className="text-ink-faint">GC content</dt>
              <dd className="font-mono text-ink">{genome.gc_content_pct.toFixed(1)}%</dd>
            </>
          )}
          {genome.completeness_pct != null && (
            <>
              <dt className="text-ink-faint">Completeness</dt>
              <dd className="font-mono text-ink">{genome.completeness_pct.toFixed(1)}%</dd>
            </>
          )}
          {genome.contamination_pct != null && (
            <>
              <dt className="text-ink-faint">Contamination</dt>
              <dd className="font-mono text-ink">{genome.contamination_pct.toFixed(1)}%</dd>
            </>
          )}
        </dl>
      )}

      {tab === "lineage" && (
        <div className="flex flex-col gap-1">
          {genome.lineage.length === 0 && (
            <div className="text-sm text-ink-faint">
              No taxonomic hierarchy for this genome. MIBiG records a species and nothing above it — ingest
              GTDB to supply the lineage.
            </div>
          )}
          {genome.lineage.map((step) => (
            <div key={`${step.rank}-${step.name}`} className="flex items-baseline gap-2 text-sm">
              <span className="w-16 flex-shrink-0 text-xs uppercase tracking-wide text-ink-faint">
                {step.rank}
              </span>
              <span className={`text-ink ${step.rank === "species" ? "italic" : ""}`}>{step.name}</span>
            </div>
          ))}
        </div>
      )}

      {(tab === "overview" || tab === "bgcs") && (
      <div className="mb-2 text-xs uppercase tracking-wider text-ink-muted">
        Biosynthetic gene clusters ({genome.bgcs.length})
      </div>
      )}
      {(tab === "overview" || tab === "bgcs") && (
      <div className="flex flex-col gap-2">
        {genome.bgcs.length === 0 && (
          <div className="text-sm text-ink-faint">
            No clusters recorded. Run antiSMASH on this genome to populate them.
          </div>
        )}
        {(tab === "overview" ? genome.bgcs.slice(0, 6) : genome.bgcs).map((b) => (
          <button
            key={b.id}
            onClick={() => onSelectBgc(b.id)}
            className="rounded border border-line p-2 text-left hover:border-line-strong"
          >
            <div className="flex items-center gap-2">
              {classColor(b.bgc_class, b.subtype).map((c, i) => (
                <span key={i} className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: c }} />
              ))}
              <span className="text-sm text-ink">
                {b.bgc_class === "hybrid" && b.subtype
                  ? b.subtype
                      .split("+")
                      .map((c) => BGC_CLASS_LABELS[c] ?? c)
                      .join(" + ")
                  : (BGC_CLASS_LABELS[b.bgc_class] ?? b.bgc_class)}
              </span>
            </div>
            {b.subtype && b.bgc_class !== "hybrid" && <div className="mt-1 text-xs text-ink-muted">{b.subtype}</div>}
            {b.mibig_accession && (
              <div className="mt-1 font-mono text-xs text-signal">MIBiG {b.mibig_accession}</div>
            )}
            <EvidenceBadge level={b.evidence_level} />
          </button>
        ))}
        {tab === "overview" && genome.bgcs.length > 6 && (
          <button onClick={() => setTab("bgcs")} className="text-xs text-signal hover:underline">
            Show all {genome.bgcs.length} BGCs
          </button>
        )}
      </div>
      )}

      <div className="mt-5 flex flex-wrap gap-2 border-t border-line pt-3">
        {externalLinks(genome.accession).map((link) => (
          <a
            key={link.label}
            href={link.href}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 rounded border border-line px-2 py-1 text-xs text-ink-muted hover:border-line-strong hover:text-ink"
          >
            {link.label}
            <ExternalLink size={10} />
          </a>
        ))}
      </div>
    </>
  );
}

function BgcDetailView({
  bgc,
  familyIds,
  onShowFamily,
}: {
  bgc: BGCDetail;
  familyIds: string[];
  onShowFamily?: (familyId: string) => void;
}) {
  return (
    <>
      <div className="mb-1 text-sm text-ink">
        {bgc.bgc_class === "hybrid" && bgc.subtype
          ? bgc.subtype
              .split("+")
              .map((c) => BGC_CLASS_LABELS[c] ?? c)
              .join(" + ")
          : (BGC_CLASS_LABELS[bgc.bgc_class] ?? bgc.bgc_class)}
      </div>
      <div className="mb-1 font-mono text-xs text-ink-muted">{bgc.genome_accession}</div>
      {bgc.mibig_accession && <div className="mb-1 text-xs text-ink-muted">MIBiG: {bgc.mibig_accession}</div>}
      <EvidenceBadge level={bgc.evidence_level} />

      {/* How this cluster came to sit where it does on the tree. A MIBiG
          entry carries an organism name and taxid but no lineage, so its
          position comes from matching that organism to a GTDB genome —
          which is a claim about the organism, not about the assembly the
          cluster was sequenced from. Saying which route placed it lets a
          reader weigh the position rather than take it on trust. */}
      {bgc.placement_method && (
        <div className="mt-3 rounded border border-line bg-paper p-2.5">
          <div className="mb-1 flex items-center gap-1.5">
            <MapPin size={11} className="flex-shrink-0 text-ink-faint" />
            <span className="text-xs uppercase tracking-wider text-ink-muted">
              Placement on the tree
            </span>
          </div>
          <div className="text-xs leading-relaxed text-ink">
            {bgc.placement_note ?? bgc.placement_method}
          </div>
          {bgc.contig && (
            <div className="mt-1 text-[11px] leading-relaxed text-ink-faint">
              Characterized on MIBiG locus{" "}
              <span className="font-mono text-ink-muted">{bgc.contig}</span>; shown on{" "}
              <span className="font-mono text-ink-muted">{bgc.genome_accession}</span>, GTDB&apos;s
              genome for the same organism.
            </div>
          )}
        </div>
      )}

      {familyIds.length > 0 && onShowFamily && (
        <div className="mt-4 rounded border border-line bg-paper p-2.5">
          <div className="mb-1.5 text-xs uppercase tracking-wider text-ink-muted">
            Gene cluster {familyIds.length === 1 ? "family" : "families"}
          </div>
          <div className="flex flex-col gap-1">
            {familyIds.map((fid) => (
              <button
                key={fid}
                onClick={() => onShowFamily(fid)}
                className="flex items-center gap-1.5 text-left text-xs text-signal hover:underline"
              >
                <Share2 size={11} className="flex-shrink-0" />
                Show this family&apos;s distribution across the tree
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="mb-2 mt-4 text-xs uppercase tracking-wider text-ink-muted">Known / predicted products</div>
      {bgc.compounds.length === 0 && <div className="text-sm text-ink-faint">None recorded</div>}
      {bgc.compounds.map((c) => (
        <div key={c.id} className="text-sm text-ink">
          {c.name}
        </div>
      ))}
    </>
  );
}
