"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";

interface Chip {
  name: string;
  slug?: string;
}

/* Colored brand mark on a white tile (marketplace convention) — official
   brand hexes stay legible on both themes; the tile is the neutralizer. */
function BrandTile({ slug, size = "h-6 w-6" }: { slug: string; size?: string }) {
  return (
    <span aria-hidden className={cn("logo-tile shrink-0 rounded-[6px]", size)}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={`/logos/${slug}.svg`} alt="" className="h-[62%] w-[62%]" loading="lazy" />
    </span>
  );
}

/* Counter-scrolling chip marquee. Seam-proof loop: each row renders the
   same group 4× and every group animates translateX(-100% - gap), so the
   hand-off is invisible at any viewport width (no dead space, ever).
   Keyboard-focusable pause control (WCAG 2.2.2 — hover-pause alone is not
   an accessible mechanism). */
export function MarqueeRows({ rows }: { rows: readonly (readonly Chip[])[] }) {
  const [paused, setPaused] = useState(false);
  const rowSpecs = rows.map((chips, r) => ({
    chips,
    reverse: r % 2 === 1,
    duration: r % 2 === 1 ? "56s" : "48s",
  }));

  return (
    <div className="flex flex-col gap-4">
      <div
        className="relative flex flex-col gap-3 overflow-hidden"
        style={{
          maskImage:
            "linear-gradient(to right, transparent, black 10%, black 90%, transparent)",
          WebkitMaskImage:
            "linear-gradient(to right, transparent, black 10%, black 90%, transparent)",
        }}
      >
        {rowSpecs.map((row, r) => (
          <ul
            key={r}
            aria-label={r === 0 ? "Supported integrations" : undefined}
            className="group flex w-max gap-[var(--marquee-gap)] [--marquee-gap:0.75rem]"
          >
            {[0, 1, 2, 3].map((dup) => (
              <li
                key={dup}
                aria-hidden={dup > 0}
                className="flex shrink-0 animate-marquee gap-[var(--marquee-gap)] group-hover:[animation-play-state:paused] motion-reduce:animate-none"
                style={{
                  animationDuration: row.duration,
                  animationDirection: row.reverse ? "reverse" : "normal",
                  animationPlayState: paused ? "paused" : undefined,
                }}
              >
                {row.chips.map((chip) => (
                  <span
                    key={chip.name}
                    className={cn(
                      "flex items-center gap-2.5 whitespace-nowrap rounded-full border border-border-subtle bg-background-200 py-1.5 pr-4 font-mono text-mono-13 text-gray-900 transition-[border-color,color,transform] duration-200 hover:-translate-y-px hover:border-border-default hover:text-gray-1000 motion-reduce:transition-none",
                      chip.slug ? "pl-1.5" : "pl-4",
                    )}
                  >
                    {chip.slug ? <BrandTile slug={chip.slug} /> : null}
                    {chip.name}
                  </span>
                ))}
              </li>
            ))}
          </ul>
        ))}
      </div>
      <div className="site-container flex justify-center">
        <button
          type="button"
          aria-pressed={paused}
          onClick={() => setPaused((p) => !p)}
          className="rounded-full border border-border-subtle px-3 py-1 font-mono text-label-12 uppercase text-gray-700 transition-colors hover:text-gray-1000"
        >
          {paused ? "play marquee" : "pause marquee"}
        </button>
      </div>
    </div>
  );
}
