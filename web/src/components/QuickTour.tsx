"use client";

import { useCallback, useEffect, useLayoutEffect, useState } from "react";

/**
 * A short tour that points at the real controls.
 *
 * It spotlights live elements rather than showing pictures of them, because
 * the thing a new reader has to learn here is not what the app can do — the
 * welcome dialog already says that — but *where* it is. This instrument puts
 * a lot on one screen: two taxonomies that must never be summed, three views
 * of the same corpus, a stats bar whose numbers are scoped to the open tab,
 * and a class strip that is also a filter. Every one of those is discoverable
 * only by knowing it is there.
 *
 * Steps target `data-tour` attributes, not classes or DOM shape, so
 * restyling a control cannot silently break the tour. A step whose target is
 * absent is SKIPPED rather than shown pointing at nothing — the orientation
 * buttons do not exist in the Flows view, and a tour that spotlights empty
 * space is worse than one step shorter.
 */

export const TOUR_SEEN_KEY = "phylo-bgc:tour-seen";

interface Step {
  /** `[data-tour="..."]` on the real element. */
  target: string;
  title: string;
  body: string;
}

const STEPS: readonly Step[] = [
  {
    target: "taxonomy",
    title: "Two taxonomies, never mixed",
    body: "Prokaryotes sit on the GTDB backbone; eukaryotes are ranked by NCBI Taxonomy, because GTDB does not cover them. They are separate trees on purpose — the counts are never added together.",
  },
  {
    target: "backbone",
    title: "All of GTDB, behind the corpus",
    body: "Switch this on to draw every GTDB genome behind the curated ones, a clade at a time. Faint, dashed clades are ones nothing here has examined; click one to open it, or search to jump straight to any GTDB clade.",
  },
  {
    target: "stats",
    title: "Everything here is scoped to the open tab",
    body: "Clusters, genomes, taxa and the class strip all describe the taxonomy you are looking at, and say what they are a fraction of. Switch tabs and every figure changes with it.",
  },
  {
    target: "views",
    title: "Three readings of the same corpus",
    body: "The tree places clusters on branches. Flows trace phylum to genus to class. The matrix is clade by class. Same data, three questions.",
  },
  {
    target: "display",
    title: "How the tree is drawn",
    body: "Horizontal or circular layout, the aligned cluster track and clade shading all live in this one menu, so the toolbar stays short.",
  },
  {
    target: "search",
    title: "Search opens the tree to what it finds",
    body: "Type a taxon, accession, compound or BGC class. Matches force open every collapsed clade on the way, so the answer is never hidden behind a fold.",
  },
  {
    target: "filters",
    title: "Filter, and see what filtering hides",
    body: "Narrow by class, cluster count, genome size or quality. The bar keeps saying how many genomes are drawn out of how many exist, so a filtered tree never passes for the whole database.",
  },
  {
    target: "upload",
    title: "Put your own genomes on this tree",
    body: "Upload antiSMASH result JSON and your genomes are placed on the same backbone, with their lineage highlighted so you can find them immediately.",
  },
];

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export function QuickTour({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);

  /** Steps whose target is actually on screen right now. */
  const [live, setLive] = useState<readonly Step[]>(STEPS);

  useLayoutEffect(() => {
    /* Present AND on screen. Below `lg` the controls rail is a drawer held
       off-canvas with `-translate-x-full`, so it is in the DOM with a
       perfectly valid bounding box sitting entirely to the left of the
       viewport. Spotlighting that would dim the whole page and ring
       nothing. */
    setLive(
      STEPS.filter((s) => {
        const el = document.querySelector(`[data-tour="${s.target}"]`);
        if (!el) return false;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        return r.right > 0 && r.left < window.innerWidth;
      }),
    );
  }, []);

  const current = live[step];

  const measure = useCallback(() => {
    if (!current) return;
    const el = document.querySelector(`[data-tour="${current.target}"]`);
    if (!el) return setRect(null);
    const r = el.getBoundingClientRect();
    setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
  }, [current]);

  useLayoutEffect(() => {
    measure();
    window.addEventListener("resize", measure);
    // `true` for capture: the rails and the tree scroll in their own
    // containers, and a scroll event there never reaches the window.
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [measure]);

  const finish = useCallback(() => {
    try {
      window.localStorage.setItem(TOUR_SEEN_KEY, "1");
    } catch {
      /* Private window, or site data blocked. The tour simply offers itself
         again next time, which is a smaller cost than not running at all. */
    }
    onClose();
  }, [onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish();
      if (e.key === "ArrowRight") setStep((i) => Math.min(i + 1, live.length - 1));
      if (e.key === "ArrowLeft") setStep((i) => Math.max(i - 1, 0));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [finish, live.length]);

  if (!current) return null;

  const last = step === live.length - 1;
  const pad = 6;

  /* Placement. Below the target normally, above it when the bottom is
     tight — and BESIDE it when the target is a full-height column, because
     a rail runs the whole viewport and there is no "below" to use: the card
     lands back at the top and covers the very control it is describing. */
  const cardWidth = 340;
  const vw = typeof window !== "undefined" ? window.innerWidth : cardWidth + 24;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const clampLeft = (x: number) => Math.max(12, Math.min(x, vw - cardWidth - 12));

  let cardTop = 0;
  let cardLeft = 12;
  if (rect) {
    const tall = rect.height > vh * 0.6;
    if (tall) {
      // Vertically centred on the target, horizontally just clear of it —
      // to its right, unless the target is itself right-aligned.
      cardTop = Math.max(12, Math.min(rect.top + rect.height / 2 - 100, vh - 220));
      cardLeft =
        rect.left + rect.width + 16 + cardWidth < vw
          ? rect.left + rect.width + 16
          : clampLeft(rect.left - cardWidth - 16);
    } else {
      const below = rect.top + rect.height + 12;
      cardTop = vh - below > 200 ? below : Math.max(12, rect.top - 212);
      cardLeft = clampLeft(rect.left);
    }
  }

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="Quick tour">
      {/* The dimming IS the spotlight: one ring with an enormous shadow
          spread darkens everything except the element inside it, so there is
          no second overlay to keep in sync with the target's position. */}
      {rect && (
        <div
          aria-hidden
          className="pointer-events-none absolute rounded"
          style={{
            top: rect.top - pad,
            left: rect.left - pad,
            width: rect.width + pad * 2,
            height: rect.height + pad * 2,
            boxShadow: "0 0 0 9999px rgba(0,0,0,0.66)",
            outline: "2px solid #EE95A3",
            outlineOffset: "1px",
            transition: "all 180ms ease-out",
          }}
        />
      )}

      {/* Catches the click that would otherwise land on the dimmed app. */}
      <div className="absolute inset-0" onClick={finish} />

      <div
        onClick={(e) => e.stopPropagation()}
        style={{ top: cardTop, left: cardLeft, width: cardWidth }}
        className="absolute rounded-lg border border-chrome-line bg-chrome p-4 shadow-2xl"
      >
        <p className="font-mono text-[10px] uppercase tracking-wide text-chrome-ink-faint">
          Step {step + 1} of {live.length}
        </p>
        <h2 className="mt-1 text-sm font-semibold text-chrome-ink">{current.title}</h2>
        <p className="mt-2 text-xs leading-relaxed text-chrome-ink-muted">{current.body}</p>

        <div className="mt-4 flex items-center justify-between gap-3">
          <button
            onClick={finish}
            className="text-[11px] text-chrome-ink-faint hover:text-chrome-ink-muted focus:outline-none focus-visible:ring-1 focus-visible:ring-chrome-accent"
          >
            Skip tour
          </button>
          <div className="flex items-center gap-2">
            {step > 0 && (
              <button
                onClick={() => setStep((i) => i - 1)}
                className="rounded border border-chrome-line px-2.5 py-1 text-xs text-chrome-ink-muted hover:text-chrome-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-chrome-accent"
              >
                Back
              </button>
            )}
            <button
              autoFocus
              onClick={() => (last ? finish() : setStep((i) => i + 1))}
              className="rounded bg-chrome-accent-wash px-3 py-1 text-xs font-medium text-chrome-accent hover:opacity-90 focus:outline-none focus-visible:ring-1 focus-visible:ring-chrome-accent"
            >
              {last ? "Done" : "Next"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
