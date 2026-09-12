"use client";

import { HeroStage } from "@/components/three/hero/hero-stage";
import { SLABS } from "@/components/three/hero/slab-data";

/* Row screen positions for the disassembled stack — derived from the scene
   constants (camera z 8.2, fov 30 → half-height 2.20u; rows at ±1.65/±0.55)
   projected through the 1112×460 INNER frame, expressed as percentages of
   the 1240×580 outer (bleed) box. The box's fixed aspect keeps them stable.

   ROW_TOP and the other two are not the same kind of number, and the phone is
   where the difference bites. ROW_TOP is a fraction of the way up the frame,
   so it survives any box shape. LABEL_LEFT and SPINE_X encode the landed bar's
   HALF-WIDTH as a percentage of the box WIDTH (50% + 0.3357 × height/width),
   so they are only correct while the box keeps the 1240/580 aspect — and the
   phone rule above deliberately does not. That is fine, and it is why the two
   changes are one change: below 40rem globals.css stops using LABEL_LEFT
   entirely (the rows become a legend under the diagram at left: 50%) and hides
   the spine. Anyone retuning the phone box must keep those two facts together. */
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
        /* PHONE GEOMETRY (< 40rem). The mark's pixel size is set by the box's
           HEIGHT alone — the camera's fov is vertical, so the horizontal frame
           never touches the scale — and the box's height is derived from its
           width through a 2.14 letterbox aspect. On a 393pt phone that made the
           box 421x197 and the mark ~112px, one third of the desktop's 330px,
           sitting at the vertical centre of the copy column: the chamfer
           rim-lights crossed "own machine." and sat behind all three lines of
           the subhead. It read as a collision, not a backdrop.

           So below 40rem the box takes a definite height instead of inheriting
           one from the aspect, and moves up. h-[min(23.5rem,46svh)]: the 46svh
           term keeps the box from outgrowing the screen on a tall phone, and
           the 23.5rem cap keeps it from outgrowing the LAYOUT — the exploded
           bars reach ±1.86u while the camera arc pushes ±0.55u sideways
           (ARC_X, slab-choreo.ts), which needs a box aspect of at least ~0.95
           to stay in frame; 421/376 = 1.12 leaves 18% of margin. Going portrait
           would start sliding the bars out of frame mid-explode.
           -translate-y-[calc(50%+8rem)] then puts the mark's crown above the
           h1's first line, which is the composition REST_OFFSET_Y already
           describes in stack-mark.tsx and which the phone could not deliver.

           sm: restores today's exact strings, so nothing at or above 640px
           moves. */
        className="pointer-events-none absolute left-1/2 top-1/2 z-0 aspect-auto h-[min(23.5rem,46svh)] w-[min(1240px,107vw)] -translate-x-1/2 -translate-y-[calc(50%+8rem)] sm:aspect-[1240/580] sm:h-auto sm:-translate-y-[calc(50%+2.5rem)]"
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
