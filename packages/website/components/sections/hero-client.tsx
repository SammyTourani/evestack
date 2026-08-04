"use client";

import { useState } from "react";
import { HeroStage } from "@/components/three/hero/hero-stage";
import type { HeroMode } from "@/components/three/contracts";
import { SLABS } from "@/components/three/hero/slab-data";
import { cn } from "@/lib/utils";

/* Row screen positions for the disassembled stack — derived from the scene
   constants (camera z 9.6, fov 30 → half-height 2.57u; rows at ±1.95/±0.65).
   Percentages of the canvas box; the box's fixed aspect keeps them stable. */
const ROW_TOP = [12.1, 37.35, 62.65, 87.9];
const LABEL_LEFT = 67;
const SPINE_X = 64;

/* Client island: shares the mode state between the toggle and the 3D stage.
   The copy block stays a Server Component and is passed through children. */
export function HeroClient({ children }: { children: React.ReactNode }) {
  const [mode, setMode] = useState<HeroMode>("dashboard");

  return (
    <>
      {/* 3D stage behind the copy, eve.dev geometry: centered, no pointer events */}
      <div
        data-hero-stage
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-1/2 z-0 aspect-[1112/460] w-[min(1112px,96vw)] -translate-x-1/2 -translate-y-[calc(50%+2.5rem)]"
      >
        <HeroStage mode={mode} />

        {/* Disassembly annotations: connector spine + layer labels.
            Pure decoration for the animated path (aria-hidden ancestor,
            sr-summary covers content) — starts opacity-0 and only the
            scrub timeline ever reveals it, so the static/no-JS/reduced
            hero never shows labels over the assembled mark. */}
        <div data-hero-annotations className="absolute inset-0 opacity-0">
          <svg
            className="absolute inset-0 h-full w-full"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            fill="none"
          >
            <path
              data-hero-spine
              d={`M ${SPINE_X} ${ROW_TOP[0]} L ${SPINE_X} ${ROW_TOP[3]}`}
              stroke="var(--ds-border-strong)"
              strokeWidth="0.1"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          {SLABS.map((slab, i) => (
            <div
              key={slab.id}
              data-layer-label
              className="absolute flex -translate-y-1/2 items-center gap-2"
              style={{ top: `${ROW_TOP[i]}%`, left: `${LABEL_LEFT}%` }}
            >
              <span className="h-px w-4 bg-border-strong" />
              <span className="text-copy-14 font-medium text-gray-1000">{slab.label}</span>
              <span className="rounded-full border border-border-subtle px-2 py-0.5 font-mono text-label-12 text-gray-700">
                {slab.badge}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div
        data-hero-copy
        className="site-container relative z-10 flex flex-col items-center gap-6 text-center"
      >
        {children}

        {/* Dashboard / Terminal render-mode toggle — plain toggle buttons
            (aria-pressed) so semantics match the actual keyboard behavior */}
        <div
          data-hero="toggle"
          role="group"
          aria-label="Hero render mode"
          className="mt-2 inline-flex items-center rounded-full border border-border-default p-0.5"
        >
          {(["dashboard", "terminal"] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              onClick={() => setMode(m)}
              className={cn(
                "rounded-full px-4 py-1.5 font-mono text-label-12 uppercase transition-colors",
                mode === m
                  ? "bg-gray-200 text-gray-1000"
                  : "text-gray-700 hover:text-gray-1000",
              )}
            >
              {m}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
