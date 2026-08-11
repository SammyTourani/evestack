"use client";

import { useRef } from "react";
import { cn } from "@/lib/utils";

/* Cursor-tracking spotlight: pointermove writes --mx/--my; a masked radial
   gradient lights the card. Pointer-driven → inherently inert on touch/no-JS. */
export function SpotlightCard({
  className,
  children,
  /* The lit colour, and the radius it carries. Defaults are the neutral grey
     lift the bento has always used — §09's path cards tint theirs toward the
     accent that column owns, which is the whole reason this is a prop and not
     a second component. Any CSS colour works; pass it with its own alpha. */
  spotlight = "var(--ds-gray-200)",
  radius = 240,
}: {
  className?: string;
  children: React.ReactNode;
  spotlight?: string;
  radius?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);

  return (
    <div
      ref={ref}
      onPointerMove={(e) => {
        const el = ref.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        el.style.setProperty("--mx", `${e.clientX - rect.left}px`);
        el.style.setProperty("--my", `${e.clientY - rect.top}px`);
      }}
      className={cn("group relative isolate overflow-hidden bg-background-100", className)}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 z-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
        style={{
          background: `radial-gradient(${radius}px circle at var(--mx, 50%) var(--my, 50%), ${spotlight}, transparent 70%)`,
        }}
      />
      <div className="relative z-10 h-full">{children}</div>
    </div>
  );
}
