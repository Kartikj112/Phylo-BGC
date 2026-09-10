"use client";

import { useEffect, useState } from "react";
import { fetchProvenance } from "@/lib/api-client";
import type { DatasetProvenanceResponse } from "@/lib/api-types";

/**
 * What the reader looks at while the taxonomy tree is in flight.
 *
 * The tree is a single multi-megabyte payload, so the wait is real — but it
 * is also unpredictable, and that asymmetry is the whole design constraint
 * here. On a warm API the tree lands in a few hundred milliseconds; on a
 * cold one it can take the better part of a minute. The copy therefore has
 * to work as a *flash* as readily as it works as a slideshow.
 *
 * Two rules follow, and both are load-bearing:
 *
 * 1. This component NEVER holds the app up. It owns no exit animation, no
 *    minimum lifetime, and no "let the current question finish" grace
 *    period — its parent unmounts it the instant the tree is ready and the
 *    rotation dies mid-question. Padding the load to show more copy would
 *    be trading the reader's time for our word count, which is not a trade
 *    this project makes.
 * 2. Because of (1), assume most readers see question 1 and nothing else.
 *    That is why the order is not arbitrary: placement on the tree — the
 *    thing the app actually does — leads, and the honest one about the
 *    limits of what is known closes.
 */

interface Question {
  /** The question, in large type. */
  q: string;
  /** One supporting line beneath it, smaller and muted. */
  a: string;
}

/** Fixed order. See rule 2 above — the first entry is the one that ships. */
const QUESTIONS: readonly Question[] = [
  {
    q: "Where does my BGC sit on the tree of life?",
    a: "Place any BGC on real GTDB branches.",
  },
  {
    q: "Is my BGC confined to one clade, or scattered?",
    a: "A family's spread hints at how it got there.",
  },
  {
    q: "Which genera are richest in biosynthetic potential?",
    a: "Find the hotspots worth mining.",
  },
  {
    q: "What distinguishes these two clades chemically?",
    a: "Compare repertoires side by side.",
  },
  {
    q: "What's known here — and what's still unexplored?",
    a: "Curated MIBiG evidence, kept separate from prediction.",
  },
];

/** How long each question holds before the next one starts crossing in. */
const HOLD_MS = 4000;

/** How long a load has to run before it is worth explaining. Comfortably
 *  longer than a warm response, comfortably shorter than a cold boot. */
const SLOW_AFTER_MS = 6_000;

/**
 * Which ground this is sitting on. The splash is the dark chrome; the
 * in-page loading state (a taxonomy switch, once the splash is gone) is
 * paper. Same tokens either way — no colour is invented for this screen.
 */
export type LoadingQuestionsTone = "paper" | "chrome";

export function LoadingQuestions({ tone = "paper" }: { tone?: LoadingQuestionsTone }) {
  const [index, setIndex] = useState(0);
  // Default false so the server render and the first client render agree.
  // The effect corrects it well inside the first question's hold.
  const [reduceMotion, setReduceMotion] = useState(false);
  const [provenance, setProvenance] = useState<DatasetProvenanceResponse | null>(null);
  const [slow, setSlow] = useState(false);

  /* The wait has two quite different causes and the reader cannot tell them
     apart. A warm API answers in a few hundred milliseconds; a cold one has
     to boot a container first, and the deployed API is on a free tier that
     spins down after ~15 minutes idle. Measured against the live deployment,
     that cold path took over two minutes — during which this screen said
     exactly what it says at 300ms, so the honest reading was "it is broken".

     The threshold matters: below it nothing appears, so a warm load is never
     given a paragraph explaining a delay it did not have. */
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), SLOW_AFTER_MS);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduceMotion(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReduceMotion(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    // Reduced motion gets question 1, held still. Not a faster rotation —
    // a crossfade is still motion, and the reader asked for none.
    if (reduceMotion) {
      setIndex(0);
      return;
    }
    const timer = setInterval(() => setIndex((i) => (i + 1) % QUESTIONS.length), HOLD_MS);
    return () => clearInterval(timer);
  }, [reduceMotion]);

  // Provenance is fetched here rather than passed down so this component
  // stays droppable anywhere, and it is deliberately allowed to lose the
  // race: if the tree arrives first, this line simply never renders. A
  // placeholder or a row of zeros would be a claim about the corpus that
  // we cannot yet support.
  useEffect(() => {
    let cancelled = false;
    fetchProvenance()
      .then((p) => {
        if (!cancelled) setProvenance(p);
      })
      .catch(() => {
        /* No line, then. The tree's own error state owns the failure. */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const onChrome = tone === "chrome";
  const questionColor = onChrome ? "text-chrome-ink" : "text-ink";
  const supportColor = onChrome ? "text-chrome-ink-muted" : "text-ink-muted";
  // Muted, not faint. `ink-faint` reads at ~2.4:1 on paper, which is fine
  // for a decorative rule and not fine for the only numbers on the screen.
  // Size is what makes this line recede, not a colour that fails contrast.
  const provenanceColor = onChrome ? "text-chrome-ink-muted" : "text-ink-muted";
  const provenanceLine = formatProvenance(provenance);

  return (
    <div className="flex w-full max-w-[44rem] flex-col items-center px-6 text-center">
      {/* The visual rotation is hidden from assistive tech: an aria-live
          region that re-reads itself every four seconds is a nuisance, and
          the questions are atmosphere, not instructions. The status line
          below carries the one fact a reader actually needs. */}
      {/* 34rem so the questions break into two comfortable lines rather
          than stretching across the stage. The provenance line below is
          NOT held to it — it is one continuous string of real values, and
          capping it here is what orphaned "2026-08-28" onto its own row. */}
      <div aria-hidden className="grid w-full max-w-[34rem]">
        {QUESTIONS.map((item, i) => (
          <div
            key={item.q}
            // Every question occupies the same grid cell, so the block is
            // as tall as the longest one and the two states genuinely cross
            // rather than one replacing the other. Absolute positioning
            // would collapse the height and let the provenance line jump.
            style={{ gridArea: "1 / 1" }}
            className={`transition-opacity ease-in-out ${
              reduceMotion ? "duration-0" : "duration-[600ms]"
            } ${i === index ? "opacity-100" : "opacity-0"}`}
          >
            <p
              className={`text-[22px] font-medium leading-snug tracking-[-0.01em] md:text-[30px] ${questionColor}`}
            >
              {item.q}
            </p>
            <p className={`mt-3 text-sm leading-relaxed ${supportColor}`}>{item.a}</p>
          </div>
        ))}
      </div>

      {/* Real numbers or nothing. Rendered only once /api/v1/provenance has
          actually answered — this is never a skeleton. */}
      {provenanceLine && (
        <p className={`mt-10 text-xs leading-relaxed ${provenanceColor}`}>{provenanceLine}</p>
      )}

      {/* Announced, unlike the rotating questions: this one IS an
          instruction — it tells a reader who is about to give up that
          waiting is the right thing to do. */}
      {slow && (
        <p
          role="status"
          aria-live="polite"
          className={`mt-4 max-w-[34rem] text-xs leading-relaxed ${provenanceColor}`}
        >
          Still loading. The API sleeps when nobody is using it, so the first
          visit after a quiet spell has to wake it up — this can take a minute.
          Nothing is wrong, and it is quick from here on.
        </p>
      )}

      <span role="status" aria-live="polite" className="sr-only">
        Loading taxonomy tree…
      </span>
    </div>
  );
}

/**
 * The one quiet line of provenance: what is in the database right now, and
 * which releases it was built from.
 *
 * Deliberately says "clusters", not "curated clusters". The corpus holds
 * MIBiG's curated entries *and* antiSMASH predictions, and the last
 * question on this very screen promises to keep those apart — collapsing
 * them into one flattering adjective here would break that promise on the
 * loading screen itself.
 *
 * Exported for the unit test; the component uses it directly.
 */
export function formatProvenance(p: DatasetProvenanceResponse | null): string | null {
  if (!p) return null;
  const parts: string[] = [];
  if (p.bgc_count > 0) parts.push(`${p.bgc_count.toLocaleString()} clusters`);
  if (p.genome_count > 0) parts.push(`${p.genome_count.toLocaleString()} genomes`);
  for (const source of p.sources) {
    // Reference databases only. A `tool_run` or a `user_upload` is a fact
    // about one session, not about the corpus a reader is about to browse.
    if (source.source_type !== "reference_database") continue;
    parts.push(source.version ? `${source.name} ${source.version}` : source.name);
  }
  // An empty database leaves nothing worth saying — so say nothing.
  return parts.length > 0 ? parts.join(" · ") : null;
}
