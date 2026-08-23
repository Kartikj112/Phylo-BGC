"use client";

import { MapPin, X } from "lucide-react";
import { useEffect, useState } from "react";
import { fetchBgc, fetchGenome } from "@/lib/api-client";
import type { BGCDetail, GenomeDetail } from "@/lib/api-types";
import { BGC_CLASS_LABELS, classColor } from "@/lib/colors";

export type Selection = { kind: "genome"; id: string } | { kind: "bgc"; id: string } | null;

interface DetailPanelProps {
  selection: Selection;
  onClose: () => void;
  onSelectBgc: (bgcId: string) => void;
}

export function DetailPanel({ selection, onClose, onSelectBgc }: DetailPanelProps) {
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
        {bgc && <BgcDetailView bgc={bgc} />}
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

function GenomeDetailView({ genome, onSelectBgc }: { genome: GenomeDetail; onSelectBgc: (id: string) => void }) {
  return (
    <>
      <div className="mb-1 font-mono text-sm text-ink">{genome.accession}</div>
      {genome.taxon_name && <div className="mb-3 text-sm italic text-ink-muted">{genome.taxon_name}</div>}

      <div className="mb-4 flex items-center gap-2">
        <MapPin size={14} className="text-ink-faint" />
        <span className="text-xs text-ink-muted">
          {genome.is_mag ? "Metagenome-assembled genome" : "Isolate genome assembly"}
        </span>
      </div>

      {(genome.genome_size_bp != null || genome.completeness_pct != null) && (
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

      <div className="mb-2 text-xs uppercase tracking-wider text-ink-muted">
        Biosynthetic gene clusters ({genome.bgcs.length})
      </div>
      <div className="flex flex-col gap-2">
        {genome.bgcs.map((b) => (
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
            <EvidenceBadge level={b.evidence_level} />
          </button>
        ))}
      </div>
    </>
  );
}

function BgcDetailView({ bgc }: { bgc: BGCDetail }) {
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
