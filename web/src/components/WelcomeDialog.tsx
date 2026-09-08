"use client";

import { FolderUp, GitBranch } from "lucide-react";
import { useEffect, useRef } from "react";

/**
 * The fork shown once the splash clears: read the reference corpus, or put
 * your own antiSMASH run on it.
 *
 * It exists because the upload path had no door. Ingestion has been in the
 * engine since early on (`bgcscape ingest antismash`), but nothing on the
 * page said so, so the only way to reach it was a terminal and a checkout —
 * which is not a feature a reader can find.
 *
 * Deliberately not a blocking modal in the strict sense: Escape and the
 * backdrop both choose "browse", because browsing is the safe default and a
 * dialog you cannot dismiss is a worse first screen than no dialog.
 */
export function WelcomeDialog({
  onBrowse,
  onUpload,
}: {
  onBrowse: () => void;
  onUpload: () => void;
}) {
  const browseRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    // Focus the safe choice, so Enter on arrival browses rather than
    // opening a file picker nobody asked for.
    browseRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onBrowse();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBrowse]);

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/45 p-4 backdrop-blur-[2px]"
      onClick={onBrowse}
      data-welcome-dialog
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="welcome-title"
        // The backdrop dismisses; a click that started inside the card must
        // not, or dragging to select the heading would close the dialog.
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg rounded-lg border border-chrome-line bg-chrome p-6 shadow-2xl sm:p-7"
      >
        <h2 id="welcome-title" className="text-lg font-semibold text-chrome-ink">
          What would you like to do?
        </h2>
        <p className="mt-1.5 text-sm text-chrome-ink-muted">
          Phylo-BGC maps biosynthetic gene clusters across the tree of life. Read the
          reference corpus, or add your own genomes to it.
        </p>

        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <button
            ref={browseRef}
            onClick={onBrowse}
            className="group flex flex-col items-start gap-2 rounded border border-chrome-line bg-chrome-soft p-4 text-left transition hover:border-chrome-accent focus:outline-none focus-visible:border-chrome-accent focus-visible:ring-2 focus-visible:ring-chrome-accent"
          >
            <GitBranch size={20} className="text-chrome-accent" aria-hidden />
            <span className="text-sm font-semibold text-chrome-ink">Browse the tree</span>
            <span className="text-xs leading-relaxed text-chrome-ink-muted">
              Explore the curated MIBiG clusters already mapped onto the GTDB and NCBI
              backbones.
            </span>
          </button>

          <button
            onClick={onUpload}
            className="group flex flex-col items-start gap-2 rounded border border-chrome-line bg-chrome-soft p-4 text-left transition hover:border-chrome-accent focus:outline-none focus-visible:border-chrome-accent focus-visible:ring-2 focus-visible:ring-chrome-accent"
          >
            <FolderUp size={20} className="text-chrome-accent" aria-hidden />
            <span className="text-sm font-semibold text-chrome-ink">
              Analyze my antiSMASH results
            </span>
            <span className="text-xs leading-relaxed text-chrome-ink-muted">
              Upload result JSON files from your own antiSMASH run and see your genomes
              placed on the same tree.
            </span>
          </button>
        </div>

        <p className="mt-4 text-[11px] text-chrome-ink-faint">
          You can switch at any time — the upload button stays in the toolbar.
        </p>
      </div>
    </div>
  );
}
