"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The toolbar strip, with its overflow made visible and operable.
 *
 * The strip scrolls sideways rather than wrapping into ragged rows or
 * collapsing into an overflow menu — that decision predates this component
 * and is kept, because a fixed-height strip is what stops the tree
 * reflowing every time a control appears.
 *
 * What was missing is that the scrollbar is deliberately hidden, so on a
 * narrow desktop window — or any window the reader has zoomed in, which is
 * the same thing in CSS pixels — the trailing controls were simply gone.
 * "Auto arrange" was clipped past the right edge with nothing to say it
 * existed: no scrollbar, no fade, and no swipe to discover it with, because
 * a mouse does not swipe. A control that is one gesture away on a phone and
 * undiscoverable on a laptop is hidden, whatever the CSS calls it.
 *
 * So: a fade on each edge that has content behind it, and a chevron that
 * actually scrolls. Both appear ONLY when that edge is genuinely overflowing
 * — a permanent fade would imply hidden controls on a toolbar that has none.
 */
export function ScrollableToolbar({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState({ left: false, right: false });

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    // 1px of slack: sub-pixel layout rounding otherwise leaves a permanent
    // 0.5px "overflow" and the fade never switches off.
    const max = el.scrollWidth - el.clientWidth;
    setOverflow({
      left: el.scrollLeft > 1,
      right: el.scrollLeft < max - 1,
    });
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    // Both are needed: the window resize catches a zoom or a dragged window
    // edge, and the observer catches the toolbar's own contents changing —
    // switching to Flows removes the orientation and layout buttons, which
    // changes whether anything overflows without any resize at all.
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    for (const child of Array.from(el.children)) observer.observe(child);
    window.addEventListener("resize", measure);
    return () => {
      el.removeEventListener("scroll", measure);
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [measure, children]);

  const nudge = (direction: -1 | 1) => {
    const el = ref.current;
    if (!el) return;
    // Most of a screenful, not all of it: leaving a couple of controls in
    // common between the two positions keeps the reader oriented.
    el.scrollBy({ left: direction * el.clientWidth * 0.8, behavior: "smooth" });
  };

  return (
    <div className="relative flex min-w-0 items-center lg:flex-1">
      <div
        ref={ref}
        className="-mx-3 flex min-w-0 flex-1 items-center gap-2 overflow-x-auto px-3 pb-0.5 sm:-mx-4 sm:px-4 lg:mx-0 lg:px-0 lg:pb-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {children}
      </div>

      {(["left", "right"] as const).map((side) =>
        overflow[side] ? (
          <div
            key={side}
            className={`pointer-events-none absolute inset-y-0 z-10 flex items-center ${
              side === "left" ? "left-0 pl-0.5 pr-6" : "right-0 pl-6 pr-0.5"
            }`}
            style={{
              // The fade is the chrome colour itself, so the clipped control
              // dissolves into the bar rather than sitting behind a panel.
              background: `linear-gradient(to ${side === "left" ? "right" : "left"}, #191416 55%, transparent)`,
            }}
          >
            <button
              type="button"
              onClick={() => nudge(side === "left" ? -1 : 1)}
              aria-label={side === "left" ? "Scroll toolbar left" : "Scroll toolbar right"}
              title={
                side === "left"
                  ? "More controls to the left"
                  : "More controls to the right"
              }
              className="pointer-events-auto flex h-6 w-5 items-center justify-center rounded border border-chrome-line bg-chrome-soft text-[10px] text-chrome-ink-muted hover:text-chrome-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-chrome-accent"
            >
              {side === "left" ? "‹" : "›"}
            </button>
          </div>
        ) : null,
      )}
    </div>
  );
}
