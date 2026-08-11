"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { agentPack } from "@/lib/copy";
import { ClaudeMark, OpenAIMark, TerminalMark } from "@/components/ui/agent-marks";
import { cn } from "@/lib/utils";

/* "Set up your agent" — a split button.

   The shape is the one every docs site converged on in 2026 (Vercel, Anthropic,
   Mintlify, Fumadocs, shadcn): the PRIMARY click does the thing without asking
   a question — it copies — and a caret opens the alternatives for the smaller
   number of people who want a different destination. A menu that opens on the
   main click costs everyone a decision to save a few people a step.

   Two details are load-bearing:

   1. The pack is fetched, not bundled. It is ~30 KB of markdown; inlining it
      as a prop would put all of it in the RSC payload of a page whose initial
      JS budget is the thing under the most pressure. It is prefetched on the
      first hover or focus — by the time a click lands it is already in memory,
      and a visitor who never touches the button pays nothing.

   2. The clipboard write stays inside the user gesture. Once the prefetch has
      landed the click is synchronous, which is what Safari requires. The
      awaited path is the cold fallback (no hover — touch, or a very fast
      click), and it hands `ClipboardItem` a PROMISE rather than awaiting first,
      because that is the one async form Safari accepts as still-within-gesture.
      writeText is the last resort for engines without ClipboardItem. */

type Size = "md" | "lg";

const sizeClasses: Record<Size, string> = {
  md: "h-10 text-copy-14",
  lg: "h-12 text-copy-16",
};

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
      <path d="M2.5 8.5 6 12l7.5-8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SparkIcon() {
  /* The site's own ▚ mark would read as "evestack", not as "your agent". A
     four-point spark is the shared visual shorthand for a model action across
     every tool this button is pointed at. */
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden>
      <path d="M8 0.5c.28 2.6.9 4.2 1.85 5.15C10.8 6.6 12.4 7.22 15 7.5c-2.6.28-4.2.9-5.15 1.85C8.9 10.3 8.28 11.9 8 14.5c-.28-2.6-.9-4.2-1.85-5.15C5.2 8.4 3.6 7.78 1 7.5c2.6-.28 4.2-.9 5.15-1.85C7.1 4.7 7.72 3.1 8 .5Z" />
    </svg>
  );
}

/** Slides in on row hover. Says "this leaves the page" without a label. */
function ArrowIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
      <path d="M3.5 8h9M9 4.5 12.5 8 9 11.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CaretIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
      <path d="m4 6 4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

async function copyPack(pending: Promise<string>, cached: string | null) {
  if (cached !== null) {
    await navigator.clipboard.writeText(cached);
    return cached;
  }
  /* Cold path. ClipboardItem takes the promise directly so the write is still
     attributed to this gesture; awaiting the fetch first loses that in Safari. */
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard.write) {
    const blob = pending.then((text) => new Blob([text], { type: "text/plain" }));
    await navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]);
    return pending;
  }
  const text = await pending;
  await navigator.clipboard.writeText(text);
  return text;
}

export function AgentPackButton({
  size = "md",
  className,
  variant = "primary",
}: {
  size?: Size;
  className?: string;
  /** `primary` is the hero's filled treatment; `panel` sits inside a card. */
  variant?: "primary" | "panel";
}) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [dropUp, setDropUp] = useState(false);
  const packRef = useRef<string | null>(null);
  const inflightRef = useRef<Promise<string> | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const prefetch = useCallback(() => {
    if (packRef.current !== null || inflightRef.current) return inflightRef.current;
    const request = fetch(agentPack.href)
      .then((response) => {
        if (!response.ok) throw new Error(String(response.status));
        return response.text();
      })
      .then((text) => {
        packRef.current = text;
        return text;
      })
      .catch((error) => {
        /* Cleared so a later click retries rather than replaying the failure. */
        inflightRef.current = null;
        throw error;
      });
    inflightRef.current = request;
    return request;
  }, []);

  /* Flip above the button when there is not room below it.

     This is not a nicety. In the hero the menu opens inside a `position:
     sticky` viewport on a 220vh section, so a menu that overflows the bottom
     edge cannot be scrolled to — scrolling there scrubs the disassembly
     timeline instead of moving the page. Clipped would mean unreachable.

     Measured in a layout effect so the flip is applied before paint; a
     useEffect here renders one frame in the wrong place first. */
  useLayoutEffect(() => {
    if (!open) return;
    const trigger = rootRef.current?.getBoundingClientRect();
    const menu = menuRef.current?.getBoundingClientRect();
    if (!trigger || !menu) return;
    const GUTTER = 16;
    const roomBelow = window.innerHeight - trigger.bottom;
    const roomAbove = trigger.top;
    setDropUp(roomBelow < menu.height + GUTTER && roomAbove > roomBelow);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
    };
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) dismiss();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  /* ── Hover intent ──────────────────────────────────────────────────────
     The menu opens on hover now rather than only on a click of the caret.

     Both delays exist for a reason and neither is decoration. The OPEN delay
     stops the menu flashing at anyone whose pointer merely crosses the button
     on its way somewhere else, which at this button's position in the hero is
     most passes over it. The CLOSE delay is what makes the menu reachable at
     all: there is an 8px gap between the button and the panel, and without a
     grace period the pointer leaves the button, the menu closes, and the item
     the user was travelling toward is gone before they arrive.

     Click still toggles, and focus still opens, because hover does not exist
     on touch and does not exist for keyboard users. */
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* Hover behaviour is gated on the device ACTUALLY having a hover pointer,
     and this is not belt-and-braces: without it the control is broken on
     touch. A tap emits pointerenter, then pointerup, then pointerleave, because
     the pointer stops existing when the finger lifts. So the tap opened the
     menu and the same tap closed it 220ms later, every time. Caught on an
     iPhone 13 profile, where the menu simply never opened. */
  const [canHover, setCanHover] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(hover: hover) and (pointer: fine)");
    const sync = () => setCanHover(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  /* Set when the user explicitly dismisses (Escape, or a click outside), and
     cleared only when the pointer actually leaves the control.

     Without it, dismissing is not dismissing. Escape fires while the pointer
     is still sitting on the button, the hover-open timer scheduled by the
     pointerenter that got you there is still pending, and ~90ms later the menu
     you just closed comes back. CI caught it as a flake on the Escape test and
     it is a real one: press Escape with the cursor on the button and the menu
     reappears by itself. */
  const suppressRef = useRef(false);

  const clearHoverTimer = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
  };
  const dismiss = () => {
    clearHoverTimer();
    suppressRef.current = true;
    setOpen(false);
  };
  const hoverOpen = () => {
    if (!canHover || suppressRef.current) return;
    clearHoverTimer();
    void prefetch()?.catch(() => {});
    hoverTimer.current = setTimeout(() => setOpen(true), 90);
  };
  const hoverClose = () => {
    /* The pointer has left, so a previous dismissal is spent: hovering back on
       should open again. Cleared even when !canHover, so a device that gains a
       mouse mid-session is not left permanently suppressed. */
    suppressRef.current = false;
    if (!canHover) return;
    clearHoverTimer();
    hoverTimer.current = setTimeout(() => setOpen(false), 220);
  };
  useEffect(() => clearHoverTimer, []);

  const onCopy = async () => {
    setFailed(false);
    try {
      await copyPack(prefetch() ?? Promise.resolve(packRef.current ?? ""), packRef.current);
      setCopied(true);
      setTimeout(() => setCopied(false), 2600);
    } catch {
      /* Clipboard blocked, or the pack did not load. Saying so beats a button
         that looks like it worked — the raw URL is the way out either way. */
      setFailed(true);
      setTimeout(() => setFailed(false), 4000);
    }
  };

  const filled = variant === "primary";
  /* In a card this button is that card's primary action, so it takes the full
     measure rather than sitting as a small pill in a large empty panel. In the
     hero it must stay content-width — it is one of three CTAs on a row. */
  const full = variant === "panel";
  /* The panel variant carries a blue-tinted edge rather than the neutral one.
     It exists for exactly one place — §09's agent card, whose accent rail and
     under-wash are already blue — and a neutral outline there read as inert
     next to five copyable command plates. A filled white pill was the other
     candidate and is too loud at full width on a dark card.

     This is a variant rather than a className override on purpose: `cn` is
     plain clsx with no tailwind-merge, so a passed `border-*` would not
     replace the base one — both would land and the cascade would decide. */
  const shell = cn(
    "inline-flex select-none items-stretch rounded-full border transition-colors duration-150",
    filled
      ? "border-transparent bg-gray-1000 text-background-100"
      : "border-blue-700/35 bg-background-100 text-gray-1000 hover:border-blue-700/70",
    full && "w-full",
    sizeClasses[size],
    className,
  );

  /* data-agent-pack is a QA handle, in the same spirit as data-hero / data-mon
     elsewhere. It exists because the primary button's accessible NAME changes
     when it copies ("Set up your agent" → "Copied — paste it in"), so a
     by-name locator silently re-resolves to the other instance of this
     component mid-assertion. A structural hook does not move. */
  const MARKS = { claude: ClaudeMark, openai: OpenAIMark, terminal: TerminalMark };

  /* data-agent-pack is a QA handle, in the same spirit as data-hero / data-mon
     elsewhere. It exists because the primary button's accessible NAME changes
     when it copies ("Set up your agent" -> "Copied, paste it in"), so a
     by-name locator silently re-resolves to the other instance of this
     component mid-assertion. A structural hook does not move. */
  return (
    <div
      ref={rootRef}
      data-agent-pack={variant}
      className={cn("relative inline-flex", full && "w-full")}
      onPointerEnter={hoverOpen}
      onPointerLeave={hoverClose}
      onFocus={(event) => {
        /* Keyboard focus only. A tap focuses the button too, and if focus
           opened the menu the tap's own click would immediately toggle it
           shut. :focus-visible is exactly the "arrived here by keyboard"
           signal, so ask the platform rather than guessing from event order. */
        if ((event.target as HTMLElement).matches?.(":focus-visible")) setOpen(true);
      }}
      onBlur={(event) => {
        /* Only when focus has actually left the whole control. relatedTarget
           is the element receiving focus, so tabbing from the caret into the
           first menu item must not close the thing being tabbed into. */
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <div className={shell}>
        <button
          type="button"
          onClick={onCopy}
          className={cn(
            "inline-flex items-center gap-2 rounded-l-full pl-5 pr-4 font-medium transition-opacity",
            filled ? "hover:opacity-90" : "hover:text-gray-1000",
            full && "flex-1 justify-center",
          )}
        >
          <span className={cn("transition-colors", copied && "text-ok")}>
            {copied ? <CheckIcon /> : <SparkIcon />}
          </span>
          {copied ? agentPack.copied : failed ? agentPack.failed : agentPack.label}
        </button>

        <span aria-hidden className={cn("my-2 w-px", filled ? "bg-background-100/25" : "bg-border-default")} />

        <button
          type="button"
          onClick={() => (open ? dismiss() : setOpen(true))}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={agentPack.menuLabel}
          className={cn(
            "inline-flex items-center rounded-r-full px-3 transition-[opacity,transform] duration-200",
            filled ? "hover:opacity-90" : "hover:text-gray-1000",
            open && "rotate-180",
          )}
        >
          <CaretIcon />
        </button>
      </div>

      <span aria-live="polite" className="sr-only">
        {copied ? agentPack.announce : failed ? agentPack.failed : ""}
      </span>

      {/* The menu stays MOUNTED and is shown by attribute, which is what lets
          it animate out as well as in. Rendered conditionally it could only
          ever animate in, because the element is gone before a leave
          transition can run.

          `inert` while closed is doing the accessibility work that `hidden`
          would have done: the links leave the tab order and the accessibility
          tree without any of them needing display:none, which would kill the
          transition again. */}
      <div
        ref={menuRef}
        role="menu"
        data-agent-menu
        data-open={open || undefined}
        data-drop={dropUp ? "up" : "down"}
        inert={!open}
        className={cn(
          "absolute left-1/2 z-50 w-[20rem] -translate-x-1/2 rounded-xl border border-border-default bg-background-100 p-1.5 text-left",
          dropUp ? "bottom-[calc(100%+8px)]" : "top-[calc(100%+8px)]",
        )}
      >
        {/* The bridge. An 8px gap sits between the button and this panel, and
            a pointer crossing it is briefly over neither. The close delay
            covers that, and this covers the rest: an invisible strip so the
            pointer never actually leaves the control. */}
        <span
          aria-hidden
          className={cn(
            "absolute inset-x-0 h-3",
            dropUp ? "top-full" : "bottom-full",
          )}
        />
        {agentPack.menu.map((item, i) => {
          const Mark = MARKS[item.mark];
          return (
            <a
              key={item.label}
              role="menuitem"
              href={item.href}
              {...(item.external ? { target: "_blank", rel: "noreferrer" } : {})}
              onClick={() => setOpen(false)}
              data-agent-menu-item
              style={{ "--i": i } as React.CSSProperties}
              className="group/item relative flex items-center gap-3 rounded-lg px-3 py-2.5"
            >
              <span className="relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border-subtle bg-background-200 text-gray-900 transition-colors group-hover/item:border-blue-700/40 group-hover/item:text-blue-700">
                <Mark className="h-4 w-4" />
              </span>
              <span className="relative z-10 flex min-w-0 flex-col gap-0.5">
                <span className="text-copy-14 text-gray-1000">{item.label}</span>
                <span className="truncate text-label-12 text-gray-700">{item.hint}</span>
              </span>
              <span
                aria-hidden
                className="relative z-10 ml-auto text-gray-600 opacity-0 transition-[opacity,transform] duration-200 group-hover/item:translate-x-0.5 group-hover/item:opacity-100"
              >
                <ArrowIcon />
              </span>
            </a>
          );
        })}
      </div>
    </div>
  );
}
