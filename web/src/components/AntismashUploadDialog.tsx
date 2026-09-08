"use client";

import { AlertTriangle, CheckCircle2, FileJson, Loader2, Upload, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, uploadAntismashResults } from "@/lib/api-client";
import type { ClusteringOutcome, UploadedGenome } from "@/lib/api-types";

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
  onIngested: (accessions: string[], familyIds: string[]) => void;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [clustering, setClustering] = useState<File | null>(null);
  const [organism, setOrganism] = useState("");
  const [isMag, setIsMag] = useState(false);
  const [consented, setConsented] = useState(false);
  /** Set on the first submit attempt, so the form does not scold a reader
   * about fields they have not reached yet. */
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<UploadedGenome[] | null>(null);
  const [rejected, setRejected] = useState<string[]>([]);
  const [clusteringResult, setClusteringResult] = useState<ClusteringOutcome | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const clusteringRef = useRef<HTMLInputElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const organismRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Never yank the dialog away mid-request: the upload would keep
      // running with nowhere to report to.
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  /**
   * Move focus into the dialog on open, and put it back on close.
   *
   * `aria-modal="true"` tells assistive tech the rest of the page is inert;
   * it does not move the caret, so without this a screen-reader user was
   * left in the toolbar behind a dialog they had not been told about.
   */
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => previous?.focus?.();
  }, []);

  /**
   * Keep Tab inside the dialog while it is open.
   *
   * Without a trap, tabbing off the last control walks into the tree canvas
   * and the rails underneath — controls that are visually covered and
   * declared inert, so focus simply vanishes from view.
   */
  useEffect(() => {
    const node = dialogRef.current;
    if (!node) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const focusable = node.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      const visible = Array.from(focusable).filter((el) => el.offsetParent !== null || el === node);
      const first = visible[0];
      const last = visible[visible.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    node.addEventListener("keydown", onKeyDown);
    return () => node.removeEventListener("keydown", onKeyDown);
  }, [results]);

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

  /**
   * Client-side validation, stated as a list of reasons rather than a
   * boolean, so the form can say WHICH requirement is unmet.
   *
   * The submit button used to be simply disabled when the form was
   * incomplete, which tells a reader nothing about why and is invisible to a
   * screen reader — a dead control with no explanation. The button stays
   * enabled now and submitting surfaces these.
   */
  const organismTrimmed = organism.trim();
  const organismError =
    organismTrimmed === ""
      ? "Enter the organism name — without it the genome cannot be placed on the tree."
      : organismTrimmed.length > 200
        ? "Organism name is too long (200 characters maximum)."
        : null;
  const problems: string[] = [];
  if (files.length === 0) problems.push("Choose at least one antiSMASH .json file.");
  if (organismError) problems.push(organismError);
  if (!consented) problems.push("Confirm you may publish this data before uploading.");

  async function submit() {
    setSubmitted(true);
    if (busy) return;
    if (problems.length > 0) {
      // Send focus where the first fixable problem is, rather than leaving
      // the reader to hunt for it.
      if (files.length === 0) inputRef.current?.focus();
      else if (organismError) organismRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await uploadAntismashResults(files, {
        organism: organism.trim(),
        isMag,
        clustering,
      });
      setResults(response.genomes);
      setRejected(response.rejected);
      setClusteringResult(response.clustering ?? null);
      const landed = response.genomes.filter((g) => g.placement === "grafted");
      if (landed.length > 0) {
        onIngested(
          landed.map((g) => g.accession),
          response.clustering?.family_ids ?? [],
        );
      }
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

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/45 p-4 backdrop-blur-[2px]"
      data-upload-dialog
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="upload-title"
        aria-describedby="upload-intro"
        className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-chrome-line bg-chrome shadow-2xl focus:outline-none"
      >
        <div className="flex flex-shrink-0 items-start justify-between gap-4 border-b border-chrome-line px-6 py-4">
          <div>
            <h2 id="upload-title" className="text-lg font-semibold text-chrome-ink">
              Analyze antiSMASH results
            </h2>
            <p id="upload-intro" className="mt-1 text-xs text-chrome-ink-muted">
              Upload the result JSON from an antiSMASH run. Each file becomes one genome. Uploads
              are public and are not stored permanently.
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
            <ResultPanel results={results} rejected={rejected} clustering={clusteringResult} />
          ) : (
            <>
              {/* File drop zone.

                  This was a plain <div onClick> wrapping a `hidden` file
                  input, which made choosing a file impossible without a
                  mouse: a `display:none` input is not focusable, and a div
                  has no role, no tab stop and no keyboard activation. It is
                  now a real <button> that opens the same picker, so Tab
                  reaches it and Enter/Space work for free; the drag handlers
                  ride along on the same element for pointer users. */}
              <button
                type="button"
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
                aria-describedby="dropzone-hint"
                className={`flex w-full cursor-pointer flex-col items-center justify-center gap-2 rounded border-2 border-dashed px-6 py-8 text-center transition ${
                  dragging
                    ? "border-chrome-accent bg-chrome-accent-wash/40"
                    : "border-chrome-line-strong bg-chrome-soft hover:border-chrome-accent"
                }`}
              >
                <Upload size={22} className="text-chrome-accent" aria-hidden />
                <span className="text-sm text-chrome-ink">
                  Choose antiSMASH <code className="font-mono">.json</code> files, or drop them here
                </span>
                <span id="dropzone-hint" className="text-[11px] text-chrome-ink-muted">
                  Up to 25 files, 128 MB each
                </span>
              </button>
              {/* Kept out of the button (a nested interactive element is
                  invalid) and visually hidden rather than display:none, so
                  it stays a legitimate programmatic click target. */}
              <input
                ref={inputRef}
                type="file"
                accept=".json,application/json"
                multiple
                tabIndex={-1}
                aria-hidden
                className="sr-only"
                onChange={(e) => {
                  addFiles(e.target.files);
                  // Reset, or choosing the same file after removing it
                  // fires no change event and appears to do nothing.
                  e.target.value = "";
                }}
              />
              {submitted && files.length === 0 && (
                <p className="mt-2 text-xs text-red-300">
                  Choose at least one antiSMASH <code className="font-mono">.json</code> file.
                </p>
              )}

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
                  ref={organismRef}
                  value={organism}
                  onChange={(e) => setOrganism(e.target.value)}
                  placeholder="Streptomyces coelicolor"
                  required
                  maxLength={200}
                  autoComplete="off"
                  spellCheck={false}
                  aria-required="true"
                  aria-invalid={submitted && organismError ? true : undefined}
                  aria-describedby={
                    submitted && organismError ? "organism-error organism-hint" : "organism-hint"
                  }
                  /* border-chrome-line carried 1.42:1 against the chrome
                     ground — a field boundary a low-vision reader cannot
                     locate (WCAG 1.4.11 wants 3:1 for control boundaries).
                     line-strong is 2.16:1 and still short, so the resting
                     border is the muted ink at 7.92:1. */
                  className="mt-1.5 w-full rounded border border-chrome-ink-muted bg-chrome-soft px-3 py-2 text-sm text-chrome-ink placeholder:text-chrome-ink-muted outline-none focus:border-chrome-accent aria-[invalid=true]:border-red-400"
                />
                {submitted && organismError && (
                  <p id="organism-error" className="mt-1.5 text-xs text-red-300">
                    {organismError}
                  </p>
                )}
                <p id="organism-hint" className="mt-1.5 text-[11px] leading-relaxed text-chrome-ink-muted">
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

              <div className="mt-5 border-t border-chrome-line pt-4">
                <label className="block text-xs font-semibold uppercase tracking-wide text-chrome-ink-muted">
                  BiG-SCAPE clustering <span className="normal-case text-chrome-ink-faint">(optional)</span>
                </label>
                <p className="mt-1.5 text-[11px] leading-relaxed text-chrome-ink-faint">
                  Add the <code className="font-mono">*_clustering_c0.3.tsv</code> from a BiG-SCAPE
                  run over these same regions and the tree will also highlight every branch
                  carrying a cluster in the <em>same family</em> as yours. Without it only your
                  genome&apos;s lineage is highlighted — antiSMASH alone can say two clusters share
                  a biosynthetic class, which is not the same as being the same cluster.
                </p>
                {clustering ? (
                  <div className="mt-2 flex items-center gap-2 rounded bg-chrome-soft px-3 py-2 text-xs">
                    <FileJson size={14} className="flex-shrink-0 text-chrome-ink-faint" aria-hidden />
                    <span className="min-w-0 flex-1 truncate font-mono text-chrome-ink">
                      {clustering.name}
                    </span>
                    <button
                      onClick={() => setClustering(null)}
                      aria-label={`Remove ${clustering.name}`}
                      className="flex-shrink-0 text-chrome-ink-faint hover:text-chrome-ink"
                    >
                      <X size={13} />
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => clusteringRef.current?.click()}
                    className="mt-2 flex w-full items-center justify-center gap-2 rounded border border-dashed border-chrome-line bg-chrome-soft px-3 py-2.5 text-xs text-chrome-ink-muted hover:border-chrome-line-strong hover:text-chrome-ink"
                  >
                    <Upload size={13} aria-hidden />
                    Choose a clustering .tsv
                  </button>
                )}
                <input
                  ref={clusteringRef}
                  type="file"
                  accept=".tsv,text/tab-separated-values,text/plain"
                  className="hidden"
                  onChange={(e) => {
                    setClustering(e.target.files?.[0] ?? null);
                    e.target.value = "";
                  }}
                />
              </div>

              <p className="mt-4 border-t border-chrome-line pt-3 text-[11px] leading-relaxed text-chrome-ink-muted">
                The genome accession comes from each filename —{" "}
                <code className="font-mono">GCF_000203835.1.json</code> becomes{" "}
                <code className="font-mono">GCF_000203835.1</code>. Everything you add is
                recorded as a user upload and marked <em>predicted</em>, never as curated
                reference data.
              </p>

              {/* Consent, at the point of collection.

                  The form used to take files with no statement of where they
                  go. They go into the SHARED corpus every other visitor is
                  browsing, and out through a public API — which is a
                  publication, not a private analysis, and is the one fact a
                  reader most needs before choosing a file. An unticked box
                  is deliberate: consent has to be an act, and a pre-ticked
                  box is not consent under any regime that requires it. */}
              <div className="mt-4 rounded border border-chrome-accent-wash bg-chrome-accent-wash/30 p-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-chrome-accent">
                  Before you upload
                </p>
                <p className="mt-1.5 text-[11px] leading-relaxed text-chrome-ink">
                  Uploads are added to the <strong>shared, publicly visible corpus</strong> — every
                  other visitor can see them, on the tree and through the public API. They are{" "}
                  <strong>not private</strong> and <strong>not backed up</strong>. Do not upload
                  unpublished, embargoed or confidential data. See the{" "}
                  <a
                    href="/privacy"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-chrome-accent underline underline-offset-2"
                  >
                    Privacy Policy
                  </a>{" "}
                  and{" "}
                  <a
                    href="/terms"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-chrome-accent underline underline-offset-2"
                  >
                    Terms
                  </a>
                  .
                </p>
                <label className="mt-2.5 flex cursor-pointer items-start gap-2 text-[11px] leading-relaxed text-chrome-ink">
                  <input
                    type="checkbox"
                    checked={consented}
                    onChange={(e) => setConsented(e.target.checked)}
                    aria-invalid={submitted && !consented ? true : undefined}
                    aria-describedby={submitted && !consented ? "consent-error" : undefined}
                    className="mt-0.5 flex-shrink-0 accent-chrome-accent"
                  />
                  <span>
                    I have the right to publish this data, and I understand it will be publicly
                    visible and may be deleted at any time.
                  </span>
                </label>
                {submitted && !consented && (
                  <p id="consent-error" className="mt-1.5 text-xs text-red-300">
                    Please confirm this before uploading.
                  </p>
                )}
              </div>

              {/* role="alert" so a failure is announced. Without it the
                  message appeared silently and a screen-reader user was left
                  with a button that had simply stopped doing anything. */}
              {(error || (submitted && problems.length > 0)) && (
                <div
                  role="alert"
                  className="mt-4 flex items-start gap-2 rounded border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-200"
                >
                  <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" aria-hidden />
                  {error ? (
                    <span>{error}</span>
                  ) : (
                    <span>
                      {problems.length === 1
                        ? problems[0]
                        : `${problems.length} things need attention before uploading.`}
                    </span>
                  )}
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
                ? `${files.length} file${files.length === 1 ? "" : "s"} · ${(totalBytes / (1024 * 1024)).toFixed(1)} MB${clustering ? " · + clustering" : ""}`
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
                {/* Disabled only while the request is in flight. When the
                    form is merely incomplete the button stays live and
                    submitting reports what is missing — a disabled control
                    announces nothing and gives a reader no way to find out
                    why it will not respond. */}
                <button
                  onClick={submit}
                  disabled={busy}
                  aria-describedby={submitted && problems.length > 0 ? "submit-blocked" : undefined}
                  className="flex items-center gap-2 rounded bg-chrome-accent-wash px-4 py-2 text-sm font-semibold text-chrome-accent hover:brightness-125 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {busy && <Loader2 size={14} className="animate-spin" aria-hidden />}
                  {busy ? "Ingesting…" : "Upload and place on tree"}
                </button>
                {submitted && problems.length > 0 && (
                  <span id="submit-blocked" className="sr-only">
                    {problems.join(" ")}
                  </span>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ResultPanel({
  results,
  rejected,
  clustering,
}: {
  results: UploadedGenome[];
  rejected: string[];
  clustering: ClusteringOutcome | null;
}) {
  return (
    <div className="space-y-3">
      {/* Said on the way OUT, where it changes what the reader does next.
          A hosted deployment writes to a container filesystem that is
          replaced on every restart and redeploy, so an upload that reports
          "grafted" in full detail can be gone within the hour — and nothing
          anywhere told the reader that. A success panel that omits this is
          not neutral about it; it implies persistence by saying nothing. */}
      <p className="rounded border border-amber-900/60 bg-amber-950/25 px-4 py-2.5 text-[11px] leading-relaxed text-amber-200">
        <strong>This upload is not saved permanently.</strong> Hosted deployments store the
        database on a container filesystem that is replaced on restart and on every redeploy, so
        these genomes will disappear without warning. Keep your antiSMASH JSON — re-uploading
        restores them — or run the engine locally against your own database
        (<span className="font-mono">BGCSCAPE_DATABASE_URL</span>) if you need them to persist.
      </p>
      <ClusteringSummary clustering={clustering} />
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

/** What the optional clustering file bought — or, when it is absent, what is
 * consequently NOT being claimed. Saying nothing in that case would leave a
 * reader to assume the lineage highlight was the whole answer. */
function ClusteringSummary({ clustering }: { clustering: ClusteringOutcome | null }) {
  if (!clustering) {
    return (
      <div className="rounded border border-chrome-line bg-chrome-soft px-4 py-3">
        <p className="text-xs font-semibold text-chrome-ink-muted">Lineage highlighted only</p>
        <p className="mt-1 text-[11px] leading-relaxed text-chrome-ink-faint">
          No BiG-SCAPE clustering file was supplied, so the tree marks where your genome sits and
          nothing more. Two clusters sharing a biosynthetic class are not the same cluster, and
          this will not pretend otherwise.
        </p>
      </div>
    );
  }

  const failed = clustering.errors.length > 0 || clustering.cutoff === null;
  return (
    <div
      className={`rounded border px-4 py-3 ${
        failed ? "border-amber-900/60 bg-amber-950/25" : "border-chrome-line bg-chrome-soft"
      }`}
    >
      <p className="font-mono text-sm text-chrome-ink">{clustering.filename}</p>
      {failed ? (
        <ul className="mt-1.5 space-y-0.5 text-[11px] leading-relaxed text-amber-300">
          {clustering.errors.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      ) : (
        <>
          <p className="mt-0.5 text-xs font-semibold text-chrome-ink-muted">
            {clustering.family_ids.length} cluster{clustering.family_ids.length === 1 ? "" : "s"}{" "}
            of yours matched to a family
          </p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-chrome-ink-faint">
            Every branch carrying one of those families is highlighted alongside your lineage, at
            a {clustering.cutoff} similarity cutoff.
          </p>
          <p className="mt-1.5 font-mono text-[11px] text-chrome-ink-faint">
            {clustering.memberships_created} new · {clustering.memberships_updated} updated ·{" "}
            {clustering.unmatched_rows} row{clustering.unmatched_rows === 1 ? "" : "s"} for regions
            not in this database
          </p>
        </>
      )}
    </div>
  );
}
