"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { agentPack } from "@/lib/copy";
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
      if (event.key === "Escape") setOpen(false);
    };
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

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
  return (
    <div
      ref={rootRef}
      data-agent-pack={variant}
      className={cn("relative inline-flex", full && "w-full")}
    >
      <div className={shell}>
        <button
          type="button"
          onClick={onCopy}
          onPointerEnter={() => void prefetch()?.catch(() => {})}
          onFocus={() => void prefetch()?.catch(() => {})}
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
          onClick={() => setOpen((v) => !v)}
          onPointerEnter={() => void prefetch()?.catch(() => {})}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={agentPack.menuLabel}
          className={cn(
            "inline-flex items-center rounded-r-full px-3 transition-opacity",
            filled ? "hover:opacity-90" : "hover:text-gray-1000",
          )}
        >
          <CaretIcon />
        </button>
      </div>

      <span aria-live="polite" className="sr-only">
        {copied ? agentPack.announce : failed ? agentPack.failed : ""}
      </span>

      {open ? (
        <div
          ref={menuRef}
          role="menu"
          data-drop={dropUp ? "up" : "down"}
          className={cn(
            "absolute left-1/2 z-50 w-[19rem] -translate-x-1/2 overflow-hidden rounded-xl border border-border-default bg-background-100 p-1.5 text-left shadow-2xl",
            dropUp ? "bottom-[calc(100%+8px)]" : "top-[calc(100%+8px)]",
          )}
        >
          {agentPack.menu.map((item) => (
            <a
              key={item.label}
              role="menuitem"
              href={item.href}
              {...(item.external ? { target: "_blank", rel: "noreferrer" } : {})}
              onClick={() => setOpen(false)}
              className="flex flex-col gap-0.5 rounded-lg px-3 py-2 transition-colors hover:bg-gray-100"
            >
              <span className="text-copy-14 text-gray-1000">{item.label}</span>
              <span className="text-label-12 text-gray-700">{item.hint}</span>
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}
