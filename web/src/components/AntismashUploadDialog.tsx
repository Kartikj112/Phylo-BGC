"use client";

import { AlertTriangle, CheckCircle2, FileJson, Loader2, Upload, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, uploadAntismashResults } from "@/lib/api-client";
import type { UploadedGenome } from "@/lib/api-types";

/**
 * Upload antiSMASH result JSONs and report, per file, where each genome
 * actually landed.
 *
 * Two things about the form are not arbitrary, and both come from properties
 * of antiSMASH's output rather than from taste:
 *
 *   - The genome accession is taken from the FILENAME, because antiSMASH's
 *     JSON has no assembly-accession field at all — its output describes a
 *     run over some sequences, not a named assembly.
 *   - The organism name is REQUIRED, because the tree is built from taxa. A
 *     genome ingested without one is written to the database and then not
 *     drawn, which would look exactly like the upload having failed.
 *
 * The result panel leads with placement, not with a region count, for the
 * same reason: "312 regions ingested" over an unchanged tree is a lie of
 * emphasis.
 */

const PLACEMENT_COPY: Record<UploadedGenome["placement"], { label: string; detail: string }> = {
  grafted: {
    label: "On the tree",
    detail: "placed under its genus in the GTDB backbone",
  },
  species_only: {
    label: "Saved, not placed",
    detail:
      "the organism was recorded but its genus is not in GTDB — GTDB is prokaryote-only, so fungi and plants land here",
  },
  unplaced: {
    label: "Saved, not on the tree",
    detail: "no organism name, so there is no taxon to draw it under",
  },
};

export function AntismashUploadDialog({
  onClose,
  onIngested,
}: {
  onClose: () => void;
  /** Fired after a successful upload with the accessions that landed, so the
   * page can re-fetch the tree and take the reader to them. */
  onIngested: (accessions: string[]) => void;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [organism, setOrganism] = useState("");
  const [isMag, setIsMag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<UploadedGenome[] | null>(null);
  const [rejected, setRejected] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Never yank the dialog away mid-request: the upload would keep
      // running with nowhere to report to.
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  const addFiles = useCallback((incoming: FileList | null) => {
    if (!incoming) return;
    const json = Array.from(incoming).filter((f) => /\.json$/i.test(f.name));
    setFiles((prev) => {
      // De-duplicate by name+size, so dropping the same file twice does not
      // queue it twice and then report it as an "update" on the server.
      const seen = new Set(prev.map((f) => `${f.name}:${f.size}`));
      return [...prev, ...json.filter((f) => !seen.has(`${f.name}:${f.size}`))];
    });
  }, []);

  async function submit() {
    if (files.length === 0 || organism.trim() === "" || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await uploadAntismashResults(files, {
        organism: organism.trim(),
        isMag,
      });
      setResults(response.genomes);
      setRejected(response.rejected);
      const landed = response.genomes.filter((g) => g.placement === "grafted");
      if (landed.length > 0) onIngested(landed.map((g) => g.accession));
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : `Upload failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setBusy(false);
    }
  }

  const totalBytes = files.reduce((n, f) => n + f.size, 0);
  const canSubmit = files.length > 0 && organism.trim() !== "" && !busy;

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/45 p-4 backdrop-blur-[2px]"
      data-upload-dialog
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="upload-title"
        className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-chrome-line bg-chrome shadow-2xl"
      >
        <div className="flex flex-shrink-0 items-start justify-between gap-4 border-b border-chrome-line px-6 py-4">
          <div>
            <h2 id="upload-title" className="text-lg font-semibold text-chrome-ink">
              Analyze antiSMASH results
            </h2>
            <p className="mt-1 text-xs text-chrome-ink-muted">
              Upload the result JSON from an antiSMASH run. Each file becomes one genome.
            </p>
          </div>
          <button
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            className="-mr-2 -mt-1 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded text-chrome-ink-muted hover:bg-chrome-soft hover:text-chrome-ink disabled:opacity-40"
          >
            <X size={18} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto chrome-scroll px-6 py-5">
          {results ? (
            <ResultPanel results={results} rejected={rejected} />
          ) : (
            <>
              {/* File drop zone */}
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  addFiles(e.dataTransfer.files);
                }}
                onClick={() => inputRef.current?.click()}
                className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded border-2 border-dashed px-6 py-8 text-center transition ${
                  dragging
                    ? "border-chrome-accent bg-chrome-accent-wash/40"
                    : "border-chrome-line bg-chrome-soft hover:border-chrome-line-strong"
                }`}
              >
                <Upload size={22} className="text-chrome-accent" aria-hidden />
                <span className="text-sm text-chrome-ink">
                  Drop antiSMASH <code className="font-mono">.json</code> files here, or click to
                  choose
                </span>
                <span className="text-[11px] text-chrome-ink-faint">
                  Up to 25 files, 128 MB each
                </span>
                <input
                  ref={inputRef}
                  type="file"
                  accept=".json,application/json"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    addFiles(e.target.files);
                    // Reset, or choosing the same file after removing it
                    // fires no change event and appears to do nothing.
                    e.target.value = "";
                  }}
                />
              </div>

              {files.length > 0 && (
                <ul className="mt-3 space-y-1.5">
                  {files.map((file) => (
                    <li
                      key={`${file.name}:${file.size}`}
                      className="flex items-center gap-2 rounded bg-chrome-soft px-3 py-2 text-xs"
                    >
                      <FileJson size={14} className="flex-shrink-0 text-chrome-ink-faint" aria-hidden />
                      <span className="min-w-0 flex-1 truncate font-mono text-chrome-ink">
                        {file.name}
                      </span>
                      <span className="flex-shrink-0 font-mono text-chrome-ink-faint">
                        {(file.size / (1024 * 1024)).toFixed(1)} MB
                      </span>
                      <button
                        onClick={() => setFiles((prev) => prev.filter((f) => f !== file))}
                        aria-label={`Remove ${file.name}`}
                        className="flex-shrink-0 text-chrome-ink-faint hover:text-chrome-ink"
                      >
                        <X size={13} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              <div className="mt-5">
                <label
                  htmlFor="organism"
                  className="block text-xs font-semibold uppercase tracking-wide text-chrome-ink-muted"
                >
                  Organism <span className="text-chrome-accent">*</span>
                </label>
                <input
                  id="organism"
                  value={organism}
                  onChange={(e) => setOrganism(e.target.value)}
                  placeholder="Streptomyces coelicolor"
                  className="mt-1.5 w-full rounded border border-chrome-line bg-chrome-soft px-3 py-2 text-sm text-chrome-ink placeholder:text-chrome-ink-faint outline-none focus:border-chrome-accent"
                />
                <p className="mt-1.5 text-[11px] leading-relaxed text-chrome-ink-faint">
                  Required, and antiSMASH cannot supply it: its output records no lineage. The
                  tree is drawn from taxa, so without this your genome is stored but never
                  appears. Genus is what gets matched — <code className="font-mono">Streptomyces
                  sp. XYZ</code> is enough.
                </p>
              </div>

              <label className="mt-4 flex items-center gap-2 text-xs text-chrome-ink-muted">
                <input
                  type="checkbox"
                  checked={isMag}
                  onChange={(e) => setIsMag(e.target.checked)}
                  className="accent-chrome-accent"
                />
                These are metagenome-assembled genomes (MAGs)
              </label>

              <p className="mt-4 border-t border-chrome-line pt-3 text-[11px] leading-relaxed text-chrome-ink-faint">
                The genome accession comes from each filename —{" "}
                <code className="font-mono">GCF_000203835.1.json</code> becomes{" "}
                <code className="font-mono">GCF_000203835.1</code>. Everything you add is
                recorded as a user upload and marked <em>predicted</em>, never as curated
                reference data.
              </p>

              {error && (
                <div className="mt-4 flex items-start gap-2 rounded border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-200">
                  <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" aria-hidden />
                  <span>{error}</span>
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex flex-shrink-0 items-center justify-between gap-3 border-t border-chrome-line px-6 py-4">
          <span className="font-mono text-[11px] text-chrome-ink-faint">
            {results
              ? `${results.length} file${results.length === 1 ? "" : "s"} processed`
              : files.length > 0
                ? `${files.length} file${files.length === 1 ? "" : "s"} · ${(totalBytes / (1024 * 1024)).toFixed(1)} MB`
                : ""}
          </span>
          <div className="flex items-center gap-2">
            {results ? (
              <button
                onClick={onClose}
                className="rounded bg-chrome-accent-wash px-4 py-2 text-sm font-semibold text-chrome-accent hover:brightness-125"
              >
                View the tree
              </button>
            ) : (
              <>
                <button
                  onClick={onClose}
                  disabled={busy}
                  className="rounded px-3 py-2 text-sm text-chrome-ink-muted hover:text-chrome-ink disabled:opacity-40"
                >
                  Cancel
                </button>
                <button
                  onClick={submit}
                  disabled={!canSubmit}
                  className="flex items-center gap-2 rounded bg-chrome-accent-wash px-4 py-2 text-sm font-semibold text-chrome-accent hover:brightness-125 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {busy && <Loader2 size={14} className="animate-spin" aria-hidden />}
                  {busy ? "Ingesting…" : "Upload and place on tree"}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ResultPanel({ results, rejected }: { results: UploadedGenome[]; rejected: string[] }) {
  return (
    <div className="space-y-3">
      {results.map((genome) => {
        const copy = PLACEMENT_COPY[genome.placement];
        const good = genome.placement === "grafted";
        return (
          <div
            key={genome.filename}
            className={`rounded border px-4 py-3 ${
              good ? "border-chrome-line bg-chrome-soft" : "border-amber-900/60 bg-amber-950/25"
            }`}
          >
            <div className="flex items-start gap-2">
              {good ? (
                <CheckCircle2 size={15} className="mt-0.5 flex-shrink-0 text-chrome-accent" aria-hidden />
              ) : (
                <AlertTriangle size={15} className="mt-0.5 flex-shrink-0 text-amber-400" aria-hidden />
              )}
              <div className="min-w-0 flex-1">
                <p className="font-mono text-sm text-chrome-ink">{genome.accession}</p>
                <p className="mt-0.5 text-xs font-semibold text-chrome-ink-muted">{copy.label}</p>
                <p className="mt-0.5 text-[11px] leading-relaxed text-chrome-ink-faint">
                  {copy.detail}
                  {genome.grafted_to ? ` (${genome.grafted_to})` : ""}
                </p>
                <p className="mt-1.5 font-mono text-[11px] text-chrome-ink-faint">
                  {genome.regions_created} new · {genome.regions_updated} updated
                </p>
                {genome.errors.length > 0 && (
                  <ul className="mt-1.5 space-y-0.5 text-[11px] text-amber-300">
                    {genome.errors.slice(0, 5).map((message) => (
                      <li key={message}>{message}</li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </div>
        );
      })}

      {rejected.length > 0 && (
        <div className="rounded border border-red-900/60 bg-red-950/30 px-4 py-3">
          <p className="text-xs font-semibold text-red-200">Not read</p>
          <ul className="mt-1 space-y-0.5 text-[11px] text-red-200/80">
            {rejected.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </div>
      )}

      {results.length === 0 && rejected.length === 0 && (
        <p className="text-sm text-chrome-ink-muted">Nothing was uploaded.</p>
      )}
    </div>
  );
}
