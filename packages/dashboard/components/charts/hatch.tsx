"use client";

/**
 * Six fill textures, one per palette slot.
 *
 * A line can carry a dash pattern; an area or a bar cannot, so a stacked chart
 * with five bands is the one place in this directory where hue would end up
 * doing the work alone. `globals.css` measured the worst adjacent pair at ΔE
 * 8.4 under protanopia — a pass, and not a comfortable one — and wrote down
 * that "whatever draws these owes every series a direct label or a legend
 * entry". A texture is the second channel that makes the legend entry
 * findable: a reader who cannot separate slots 3 and 4 by colour can separate
 * dots from crosshatch at a glance.
 *
 * Each pattern hard-codes its own `var(--chart-N)` because `currentColor`
 * inside a `<pattern>` resolves against the element that *defines* the
 * pattern, not the element that references it — so one parameterised pattern
 * is not available, and six is exactly as many as the palette allows anyway.
 *
 * The ids are per instance rather than constant. An `id` is document-scoped
 * even inside an `<svg>`, and a page with four charts and a dozen legend
 * swatches would otherwise declare `#evestack-hatch-1` sixteen times and every
 * `url(#…)` in the document would resolve to whichever one rendered first.
 * That happens to paint correctly here, because the sixteen definitions are
 * identical — which is exactly why it would survive review and then break the
 * first time one chart wanted a different ramp.
 */

import { useId } from "react";

import { slotStyle, SLOT_COUNT } from "./lib/palette";

/** Geometry per slot, in the same fixed order as the colours. */
const GEOMETRY: readonly ((color: string) => React.ReactNode)[] = [
  // 1 — solid. The first series is the one a reader looks at first and it
  // should be the cleanest mark on the chart.
  (color) => <rect width="8" height="8" fill={color} />,
  // 2 — forward diagonal
  (color) => (
    <>
      <rect width="8" height="8" fill={color} opacity="0.45" />
      <path d="M-2 2 L2 -2 M0 8 L8 0 M6 10 L10 6" stroke={color} strokeWidth="2" />
    </>
  ),
  // 3 — dots
  (color) => (
    <>
      <rect width="8" height="8" fill={color} opacity="0.35" />
      <circle cx="2" cy="2" r="1.6" fill={color} />
      <circle cx="6" cy="6" r="1.6" fill={color} />
    </>
  ),
  // 4 — back diagonal
  (color) => (
    <>
      <rect width="8" height="8" fill={color} opacity="0.45" />
      <path d="M-2 6 L2 10 M0 0 L8 8 M6 -2 L10 2" stroke={color} strokeWidth="2" />
    </>
  ),
  // 5 — horizontal rules
  (color) => (
    <>
      <rect width="8" height="8" fill={color} opacity="0.4" />
      <path d="M0 2 H8 M0 6 H8" stroke={color} strokeWidth="1.8" />
    </>
  ),
  // 6 — crosshatch
  (color) => (
    <>
      <rect width="8" height="8" fill={color} opacity="0.3" />
      <path d="M0 0 L8 8 M8 0 L0 8" stroke={color} strokeWidth="1.4" />
    </>
  ),
];

export interface Hatch {
  /** Goes inside the `<svg>` that references it. Recharts accepts it as a child. */
  readonly defs: React.ReactNode;
  /** The `fill` for slot `index`. */
  readonly fill: (index: number) => string;
}

/**
 * The textures for one chart or one swatch, with ids nothing else can claim.
 * Both halves come from the same hook so a caller cannot render the defs and
 * then reference a different id, or reference an id it never defined.
 */
export function useHatch(): Hatch {
  const prefix = useId();
  return {
    defs: (
      <defs>
        {Array.from({ length: SLOT_COUNT }, (_, i) => (
          <pattern
            key={i}
            id={`${prefix}hatch-${i + 1}`}
            width="8"
            height="8"
            patternUnits="userSpaceOnUse"
          >
            {GEOMETRY[i]?.(slotStyle(i).color)}
          </pattern>
        ))}
      </defs>
    ),
    fill: (index) => `url(#${prefix}hatch-${index + 1})`,
  };
}
