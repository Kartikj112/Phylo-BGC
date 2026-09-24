"use client";

import { Download, FileCode2, FileText, Link2, Loader2 } from "lucide-react";
import { useState } from "react";
import { exportFigure, fetchProvenance } from "@/lib/api-client";
import { buildViewConfig, figureFilename, serializeSvgForExport } from "@/lib/export";
import { CLASS_ORDER } from "@/lib/colors";
import { MenuItem, MenuSeparator, ToolbarMenu } from "@/components/ToolbarMenu";

interface ExportButtonProps {
  svgRef: React.RefObject<SVGSVGElement | null>;
  collapsed: Set<string>;
  activeClasses: Set<string>;
  selectedFamilyId: string | null;
  comparisonTaxonIds: string[];
  searchQuery: string;
  /** Whether a tree is on screen to export. The Flows and Matrix views
   * draw their own charts, which this path does not serialise. */
  canExportFigure: boolean;
  /** A link that reopens the current view, for "Copy link". */
  shareUrl: () => string;
}

/** Everything that takes the view off the page: the figure as SVG or PDF,
 * and a link back to it. One menu rather than three toolbar buttons. */
export function ExportButton({
  svgRef,
  collapsed,
  activeClasses,
  selectedFamilyId,
  comparisonTaxonIds,
  searchQuery,
  canExportFigure,
  shareUrl,
}: ExportButtonProps) {
  const [busy, setBusy] = useState<"svg" | "pdf" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

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

  async function copyLink() {
    setError(null);
    try {
      await navigator.clipboard.writeText(shareUrl());
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access is refused on plain http and in some embeds; the
      // link is still worth having, so hand it over to copy by hand.
      window.prompt("Copy this link", shareUrl());
    }
  }

  return (
    <div className="flex flex-shrink-0 items-center gap-1.5">
      <ToolbarMenu
        label="Export"
        dataTour="export"
        title="Download the figure, or copy a link to this view"
        align="right"
        icon={
          busy ? (
            <Loader2 size={13} className="animate-spin" aria-hidden />
          ) : (
            <Download size={13} aria-hidden />
          )
        }
      >
        <MenuItem
          icon={<FileCode2 size={13} />}
          onSelect={() => handleExport("svg")}
          disabled={busy !== null || !canExportFigure}
          hint="Editable vector, with the view settings embedded"
        >
          SVG figure
        </MenuItem>
        <MenuItem
          icon={<FileText size={13} />}
          onSelect={() => handleExport("pdf")}
          disabled={busy !== null || !canExportFigure}
          hint="For a manuscript or a poster"
        >
          PDF figure
        </MenuItem>
        {!canExportFigure && (
          <p className="px-3 pb-1 text-[11px] text-chrome-ink-faint">
            Figures export from the Tree view.
          </p>
        )}
        <MenuSeparator />
        <MenuItem
          icon={<Link2 size={13} />}
          onSelect={copyLink}
          hint="Reopens this taxonomy, view and clade"
        >
          Copy link to this view
        </MenuItem>
      </ToolbarMenu>
      {copied && <span className="whitespace-nowrap text-xs text-chrome-accent">Link copied</span>}
      {error && (
        <span title={error} className="max-w-[10rem] truncate text-xs text-red-300">
          {error}
        </span>
      )}
    </div>
  );
}
