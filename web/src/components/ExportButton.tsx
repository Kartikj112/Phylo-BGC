"use client";

import { Download } from "lucide-react";
import { useState } from "react";
import { exportFigure, fetchProvenance } from "@/lib/api-client";
import { buildViewConfig, figureFilename, serializeSvgForExport } from "@/lib/export";
import { CLASS_ORDER } from "@/lib/colors";

interface ExportButtonProps {
  svgRef: React.RefObject<SVGSVGElement | null>;
  collapsed: Set<string>;
  activeClasses: Set<string>;
  selectedFamilyId: string | null;
  comparisonTaxonIds: string[];
  searchQuery: string;
}

export function ExportButton({
  svgRef,
  collapsed,
  activeClasses,
  selectedFamilyId,
  comparisonTaxonIds,
  searchQuery,
}: ExportButtonProps) {
  const [busy, setBusy] = useState<"svg" | "pdf" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleExport(format: "svg" | "pdf") {
    const svgEl = svgRef.current;
    if (!svgEl) {
      setError("Nothing to export yet.");
      return;
    }
    setBusy(format);
    setError(null);
    try {
      // Provenance is fetched at export time, not cached from page load:
      // the recorded dataset must match what the figure actually shows,
      // and an ingestion run could have happened since the page opened.
      const provenance = await fetchProvenance();
      const title = window.prompt("Figure title (optional)", "") || null;
      const config = buildViewConfig({
        provenance,
        collapsed,
        activeClasses,
        allClasses: CLASS_ORDER,
        selectedFamilyId,
        comparisonTaxonIds,
        searchQuery,
        title,
      });
      const blob = await exportFigure(serializeSvgForExport(svgEl), config, format);

      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = figureFilename(title, format);
      link.click();
      URL.revokeObjectURL(url);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Download size={13} className="text-ink-faint" />
      {(["svg", "pdf"] as const).map((format) => (
        <button
          key={format}
          onClick={() => handleExport(format)}
          disabled={busy !== null}
          className="rounded border border-line px-2 py-1 text-xs uppercase tracking-wide text-ink-muted hover:border-line-strong hover:text-ink disabled:opacity-50"
        >
          {busy === format ? "…" : format}
        </button>
      ))}
      {error && <span className="max-w-xs truncate text-xs text-red-700">{error}</span>}
    </div>
  );
}
