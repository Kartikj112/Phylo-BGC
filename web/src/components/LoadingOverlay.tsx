"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The splash shown from the moment the page lands until the tree is drawn.
 *
 * The taxonomy tree is a single multi-megabyte payload that then has to be
 * laid out over thousands of nodes, so on a cold API (Render's free tier
 * spins down after ~15 min idle and cold-starts in 30-60s) the first screen
 * used to be a bare "Loading taxonomy tree…" line on an empty stage, with
 * nothing to say whether the app was working or broken.
 *
 * Three properties this has to hold, in order of how badly they bite:
 *
 * 1. It must always leave. Its lifetime is driven by the `ready` prop and a
 *    timer, never by the video — if the file 404s, the codec is missing, or
 *    autoplay is refused, the overlay still fades on schedule. The video is
 *    decoration layered on top of a working loading state, not the loading
 *    state itself.
 * 2. It must not flash. A splash that appears and vanishes inside 150ms
 *    reads as a glitch, so it holds for MIN_VISIBLE_MS even when the tree
 *    was already cached.
 * 3. It must not lie. It is dismissed only once the tree has actually
 *    painted (see `ready`), not merely once the fetch resolved — otherwise
 *    it hands over to a blank canvas while d3 lays out the nodes.
 */

/** Shortest time the splash stays up, so a fast load doesn't flash it. */
const MIN_VISIBLE_MS = 600;
/** Fade-out duration. Kept in sync with the `duration-[350ms]` class below. */
const FADE_MS = 350;

export function LoadingOverlay({
  ready,
  onDone,
}: {
  /** The load has settled — the tree is committed, or it failed and the
   * error underneath needs reading. Never gate this on the video. */
  ready: boolean;
  /** Called once the fade has finished. The page drops the overlay then, so
   * it is mounted exactly once per visit and a later taxonomy switch
   * reloads the tree without covering the screen again. */
  onDone: () => void;
}) {
  const [leaving, setLeaving] = useState(false);
  // Default false so the server render and the first client render agree;
  // the effect below corrects it before the splash's minimum lifetime is up.
  const [reduceMotion, setReduceMotion] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);
  const [logoFailed, setLogoFailed] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const mountedAt = useRef(Date.now());
  // Held in a ref so a caller passing an inline arrow cannot restart the
  // fade timer on every render of the page.
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const showVideo = !reduceMotion && !videoFailed;

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduceMotion(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReduceMotion(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // `onError` alone is not enough to catch a broken video, which is how the
  // black-box case slipped through the first time. The element is in the
  // server-rendered markup, so the browser starts fetching it immediately —
  // a 404 or an unsupported codec can fire `error` BEFORE React hydrates and
  // attaches the handler, and that event is simply gone. Reading `.error`
  // once on mount covers everything that failed before hydration; `onError`
  // covers everything that fails after it.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.error) {
      setVideoFailed(true);
      return;
    }
    // Muted inline autoplay is permitted everywhere that matters, but if a
    // policy or a battery-saver mode refuses it the element parks on its
    // first frame — which on this animation is nearly empty, so it reads as
    // a broken rectangle. The still logo is the better failure.
    const started = video.play();
    if (started) started.catch(() => setVideoFailed(true));
  }, [showVideo]);

  // Guarded by a ref, not by `leaving`: with `leaving` in the dependency
  // list, `setLeaving(true)` re-ran this effect, and the re-run's cleanup
  // cleared the fade timer that had just been scheduled beside it — so the
  // splash went transparent and then sat there, mounted, for ever.
  const exitStarted = useRef(false);
  useEffect(() => {
    if (!ready || exitStarted.current) return;
    exitStarted.current = true;
    const held = Math.max(0, MIN_VISIBLE_MS - (Date.now() - mountedAt.current));
    let fadeTimer: ReturnType<typeof setTimeout> | undefined;
    let raf1 = 0;
    let raf2 = 0;
    const startTimer = setTimeout(() => {
      // Two frames, because `ready` only says React has committed the
      // canvas. The first frame is where the browser actually paints those
      // thousands of nodes; fading on the frame before it uncovers an empty
      // stage for the length of that paint.
      raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => {
          setLeaving(true);
          fadeTimer = setTimeout(onDoneRef.current, FADE_MS);
        });
      });
    }, held);
    return () => {
      clearTimeout(startTimer);
      if (fadeTimer) clearTimeout(fadeTimer);
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [ready]);

  return (
    <div
      data-loading-overlay={leaving ? "leaving" : "visible"}
      // `role="status"` + `aria-live` so a screen reader is told the app is
      // working rather than being handed a silent, focus-less cover.
      role="status"
      aria-live="polite"
      // `bg-[#191717]` rather than the `chrome` token (#191416) on purpose,
      // and this is the one place that deviation is right: it is the video's
      // OWN background, sampled from the file. Against the token the frame
      // showed as a faintly lighter rectangle with a visible edge — a box
      // with a logo in it. Matched, the artwork floats on the ground. The
      // two differ by ~2/255 per channel, so the splash still reads as one
      // family with the chrome either way.
      className={`fixed inset-0 z-50 flex flex-col items-center justify-center gap-6 bg-[#191717] transition-opacity duration-[350ms] ease-out ${
        // Non-interactive the instant it starts leaving: the tree is already
        // live underneath, and a fading cover that still swallows the first
        // click is worse than no splash at all.
        leaving ? "pointer-events-none opacity-0" : "opacity-100"
      }`}
    >
      {showVideo ? (
        <video
          // Decoration: the status line below carries the meaning and the
          // still-logo fallback carries the name, so a reader that skips
          // this loses nothing.
          aria-hidden
          autoPlay
          muted
          loop
          playsInline
          preload="auto"
          ref={videoRef}
          onError={() => setVideoFailed(true)}
          // Sized by WIDTH, not height. The source is a 1080x1350 portrait
          // frame whose artwork is a wide band across the middle third, so
          // fitting the frame to the viewport height shrinks the logo itself
          // to about half the size it should be. The empty margin above and
          // below the artwork is the same near-black as this overlay's
          // ground, so letting the element stay tall costs nothing visually.
          className="h-auto w-[min(78vw,600px)] max-h-[72vh] object-contain"
          src="/logo-animation.mp4"
        />
      ) : logoFailed ? (
        // Last resort: even the still logo did not load. Type carries the
        // identity rather than an empty gap where a mark should be.
        <span className="text-2xl font-semibold tracking-wide text-chrome-ink">Phylo-BGC</span>
      ) : (
        // Reduced motion, or the video could not be decoded/fetched. The
        // real mark, held still — same artwork as the animation's final
        // frame, so the fallback is the brand rather than a stand-in for
        // it. A PNG also survives everything the video does not: no codec,
        // no autoplay policy, no decode.
        <img
          src="/logo.png"
          alt="Phylo-BGC"
          width={710}
          height={218}
          onError={() => setLogoFailed(true)}
          className="h-auto w-[min(78vw,600px)] max-h-[72vh] object-contain"
        />
      )}

      <p className="px-6 text-center font-mono text-xs text-chrome-ink-muted">
        Loading taxonomy tree…
      </p>
    </div>
  );
}
