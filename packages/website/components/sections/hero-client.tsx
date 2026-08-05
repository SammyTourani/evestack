"use client";

import { HeroStage } from "@/components/three/hero/hero-stage";
import { SLABS } from "@/components/three/hero/slab-data";

/* Row screen positions for the disassembled stack — derived from the scene
   constants (camera z 8.2, fov 30 → half-height 2.20u; rows at ±1.65/±0.55)
   projected through the 1112×460 INNER frame, expressed as percentages of
   the 1240×580 outer (bleed) box. The box's fixed aspect keeps them stable. */
const ROW_TOP = [20.2, 40.1, 59.9, 79.8];
const LABEL_LEFT = 65.2;
const SPINE_X = 62.6;

export function HeroClient({ children }: { children: React.ReactNode }) {
  return (
    <>
      {/* 3D stage behind the copy, eve.dev geometry: centered, no pointer events */}
      <div
        data-hero-stage
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-1/2 z-0 aspect-[1240/580] w-[min(1240px,107vw)] -translate-x-1/2 -translate-y-[calc(50%+2.5rem)]"
      >
        {/* The canvas renders with film-back bleed (hero-canvas expands the
            frustum, composition unchanged) and these nested masks feather the
            bleed margin — glow dissolves into the page instead of hitting the
            buffer edge. Nested (not comma-composited) so no mask-composite
            support is needed. Annotations stay outside: labels never fade. */}
        <div className="absolute inset-0 [-webkit-mask-image:linear-gradient(to_right,transparent,black_5.2%,black_94.8%,transparent)] [mask-image:linear-gradient(to_right,transparent,black_5.2%,black_94.8%,transparent)]">
          <div className="absolute inset-0 [-webkit-mask-image:linear-gradient(to_bottom,transparent,black_10.3%,black_89.7%,transparent)] [mask-image:linear-gradient(to_bottom,transparent,black_10.3%,black_89.7%,transparent)]">
            <HeroStage />
          </div>
        </div>

        {/* Disassembly annotations: connector spine + layer labels.
            Pure decoration for the animated path — starts opacity-0 and only
            the scrub timeline ever reveals it. */}
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
      </div>
    </>
  );
}
