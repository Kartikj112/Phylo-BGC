"use client";

import { Check, ChevronDown } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

/**
 * A toolbar button that opens a menu.
 *
 * Exists so the toolbar can hold groups rather than every switch in the
 * instrument side by side. It had grown to eleven controls, and on a laptop
 * the last of them ("Auto arrange") was scrolled out of sight with nothing
 * but a chevron to say it existed. Settings that change how the tree is
 * drawn, and the ways to take a figure out, are each one menu now.
 *
 * The menu is portalled to <body> and positioned against its trigger,
 * because the toolbar scrolls sideways (`overflow-x: auto`), and anything
 * absolutely positioned inside it would be clipped at the strip's edge.
 *
 * Keyboard: Enter/Space/ArrowDown on the trigger opens it with the first
 * item focused; arrows, Home and End move; Escape closes and returns focus
 * to the trigger; Tab closes and moves on, as it would from any control.
 */

interface MenuContextValue {
  close: () => void;
}

const MenuContext = createContext<MenuContextValue>({ close: () => undefined });

const TRIGGER =
  "flex flex-shrink-0 items-center gap-1.5 whitespace-nowrap rounded border border-chrome-line px-2.5 py-1.5 text-xs focus:outline-none focus-visible:ring-1 focus-visible:ring-chrome-accent";

export function ToolbarMenu({
  label,
  icon,
  title,
  children,
  align = "left",
  iconOnly = false,
  dataTour,
  width = 256,
}: {
  label: string;
  icon?: React.ReactNode;
  title?: string;
  children: React.ReactNode;
  /** Which edge of the trigger the menu lines up with. */
  align?: "left" | "right";
  /** Draw the icon alone; `label` is still the accessible name. */
  iconOnly?: boolean;
  dataTour?: string;
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();

  const close = useCallback((refocus = false) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, []);

  const place = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const w = Math.min(width, vw - 16);
    const left = align === "right" ? r.right - w : r.left;
    setPos({ top: r.bottom + 6, left: Math.max(8, Math.min(left, vw - w - 8)) });
  }, [align, width]);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  // Focus the first item once the portal has rendered, which is only after
  // the trigger has been measured and `pos` set.
  const placed = pos !== null;
  useEffect(() => {
    if (!open || !placed) return;
    menuRef.current?.querySelector<HTMLElement>('[role^="menuitem"]:not([disabled])')?.focus();
  }, [open, placed]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      setOpen(false);
    };
    // A scroll anywhere but inside the menu moves the trigger out from
    // under it; closing is simpler and less surprising than chasing it.
    const onScroll = (e: Event) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onResize = () => setOpen(false);
    document.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  function onMenuKey(e: React.KeyboardEvent) {
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([disabled])') ?? [],
    );
    const i = items.indexOf(document.activeElement as HTMLElement);
    const go = (n: number) => {
      e.preventDefault();
      items[(n + items.length) % items.length]?.focus();
    };
    if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") go(i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(items.length - 1);
    else if (e.key === "Escape") {
      e.preventDefault();
      close(true);
    } else if (e.key === "Tab") close(false);
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-tour={dataTour}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={iconOnly ? label : undefined}
        title={title}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className={`${TRIGGER} ${
          open
            ? "border-chrome-line-strong bg-chrome-soft text-chrome-ink"
            : "text-chrome-ink-muted hover:bg-chrome-soft hover:text-chrome-ink"
        }`}
      >
        {icon}
        {!iconOnly && <span>{label}</span>}
        {!iconOnly && <ChevronDown size={12} aria-hidden className="-mr-0.5 opacity-70" />}
      </button>
      {open &&
        pos &&
        createPortal(
          <MenuContext.Provider value={{ close: () => close(true) }}>
            <div
              ref={menuRef}
              id={menuId}
              role="menu"
              aria-label={label}
              onKeyDown={onMenuKey}
              style={{ top: pos.top, left: pos.left, width: Math.min(width, window.innerWidth - 16) }}
              className="chrome-scroll fixed z-[60] max-h-[calc(100dvh-5rem)] overflow-y-auto rounded-md border border-chrome-line bg-chrome py-1 shadow-2xl"
            >
              {children}
            </div>
          </MenuContext.Provider>,
          document.body,
        )}
    </>
  );
}

const ITEM =
  "flex w-full items-start gap-2.5 px-3 py-2 text-left text-xs text-chrome-ink hover:bg-chrome-soft focus:bg-chrome-soft focus:outline-none disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent";

/** Something to do. Closes the menu unless `keepOpen`. */
export function MenuItem({
  onSelect,
  children,
  icon,
  hint,
  title,
  disabled,
  keepOpen,
}: {
  onSelect: () => void;
  children: React.ReactNode;
  icon?: React.ReactNode;
  /** A second, quieter line under the label. */
  hint?: React.ReactNode;
  title?: string;
  disabled?: boolean;
  keepOpen?: boolean;
}) {
  const { close } = useContext(MenuContext);
  return (
    <button
      type="button"
      role="menuitem"
      title={title}
      disabled={disabled}
      onClick={() => {
        onSelect();
        if (!keepOpen) close();
      }}
      className={ITEM}
    >
      <span className="mt-px flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center text-chrome-ink-muted">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block">{children}</span>
        {hint && <span className="mt-0.5 block text-[11px] leading-snug text-chrome-ink-faint">{hint}</span>}
      </span>
    </button>
  );
}

/** An on/off setting. Stays open, so several can be flipped in one visit. */
export function MenuCheckbox({
  checked,
  onChange,
  children,
  hint,
  title,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  children: React.ReactNode;
  hint?: React.ReactNode;
  title?: string;
}) {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      title={title}
      onClick={() => onChange(!checked)}
      className={ITEM}
    >
      <span
        className={`mt-px flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded-sm border ${
          checked ? "border-chrome-accent bg-chrome-accent-wash text-chrome-accent" : "border-chrome-line-strong"
        }`}
      >
        {checked && <Check size={10} strokeWidth={3} aria-hidden />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block">{children}</span>
        {hint && <span className="mt-0.5 block text-[11px] leading-snug text-chrome-ink-faint">{hint}</span>}
      </span>
    </button>
  );
}

/** One of a set. Stays open, like a checkbox. */
export function MenuRadio({
  checked,
  onSelect,
  children,
  icon,
  title,
}: {
  checked: boolean;
  onSelect: () => void;
  children: React.ReactNode;
  icon?: React.ReactNode;
  title?: string;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      title={title}
      onClick={onSelect}
      className={`${ITEM} ${checked ? "text-chrome-accent" : ""}`}
    >
      <span className="mt-px flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center">
        <span
          className={`h-2 w-2 rounded-full ${checked ? "bg-chrome-accent" : "border border-chrome-line-strong"}`}
        />
      </span>
      <span className="flex-1">{children}</span>
      {icon && <span className="text-chrome-ink-faint">{icon}</span>}
    </button>
  );
}

export function MenuLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 pb-1 pt-2 text-[10px] uppercase tracking-wider text-chrome-ink-faint">
      {children}
    </div>
  );
}

export function MenuSeparator() {
  return <div role="separator" className="my-1 border-t border-chrome-line" />;
}

/** Static text inside a menu: an explanation, not an action. */
export function MenuNote({ children }: { children: React.ReactNode }) {
  return <div className="px-3 py-1.5 text-[11px] leading-relaxed text-chrome-ink-muted">{children}</div>;
}
