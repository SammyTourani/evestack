"use client";

import { useState } from "react";

/* Counter-scrolling chip marquee with a real, keyboard-focusable pause
   control (WCAG 2.2.2 — hover-pause alone is not an accessible mechanism). */
export function MarqueeRows({ chips }: { chips: readonly string[] }) {
  const [paused, setPaused] = useState(false);
  const mid = Math.ceil(chips.length / 2);
  const rows = [
    { chips: chips.slice(0, mid), reverse: false, duration: "40s" },
    { chips: chips.slice(mid), reverse: true, duration: "48s" },
  ];

  return (
    <div className="flex flex-col gap-3">
      <div
        className="relative flex flex-col gap-3 overflow-hidden"
        style={{
          maskImage:
            "linear-gradient(to right, transparent, black 12%, black 88%, transparent)",
        }}
      >
        {rows.map((row, r) => (
          <ul
            key={r}
            aria-label={r === 0 ? "Supported integrations" : undefined}
            className="flex w-max animate-marquee gap-3 pr-3 hover:[animation-play-state:paused] motion-reduce:animate-none"
            style={{
              animationDuration: row.duration,
              animationDirection: row.reverse ? "reverse" : "normal",
              animationPlayState: paused ? "paused" : undefined,
            }}
          >
            {[0, 1].map((dup) => (
              <li key={dup} aria-hidden={dup === 1} className="flex gap-3">
                {row.chips.map((chip) => (
                  <span
                    key={chip}
                    className="whitespace-nowrap rounded-full border border-border-subtle bg-background-200 px-4 py-2 font-mono text-mono-13 text-gray-900"
                  >
                    {chip}
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
