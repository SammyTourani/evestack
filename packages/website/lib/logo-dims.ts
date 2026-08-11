import { readFileSync } from "node:fs";
import path from "node:path";

/* Intrinsic dimensions for each wordmark, read out of the SVG AT BUILD TIME.

   These are not decoration. The marquee animates each group by `-100%` of its
   own width, and WebKit resolves a percentage transform ONCE when the
   animation starts and never re-resolves it when the element's box changes
   (Chrome and Firefox do re-resolve). The wordmarks are `loading="lazy"`, so
   on Safari the sequence was: animation starts while the images are still
   unloaded and every group is too narrow -> images land and the groups widen
   -> the translate distance stays pinned to the old narrow width -> the
   groups stop handing off by exactly their own width and a gap opens on the
   left while the right keeps scrolling.

   Emitting real `width`/`height` attributes makes the UA derive
   `aspect-ratio` from them, so `height: 1.75rem; width: auto` reserves the
   correct width BEFORE a single byte of the SVG arrives. Group widths are
   then stable from first layout, the percentage resolves correctly whenever
   it is resolved, and lazy loading is preserved.

   Read from the file rather than hardcoded so a regenerated logo
   (scripts/gen-logos.mjs) can never silently drift from the number we ship. */

const WORDMARK_DIR = path.join(process.cwd(), "public", "logos", "wordmarks");

export interface LogoDims {
  readonly width: number;
  readonly height: number;
}

/** Intrinsic size from `viewBox`, falling back to the `width`/`height` pair
    the vectorlogo.zone files carry instead. Throws at build time rather than
    shipping an image with no reserved width. */
export function wordmarkDims(slug: string): LogoDims {
  const svg = readFileSync(path.join(WORDMARK_DIR, `${slug}.svg`), "utf8");
  const open = /<svg[^>]*>/.exec(svg)?.[0] ?? "";

  const viewBox = /viewBox="([^"]+)"/.exec(open)?.[1];
  if (viewBox) {
    const [, , w, h] = viewBox.trim().split(/[\s,]+/).map(Number);
    if (w > 0 && h > 0) return { width: w, height: h };
  }

  const w = Number(/\swidth="([\d.]+)"/.exec(open)?.[1]);
  const h = Number(/\sheight="([\d.]+)"/.exec(open)?.[1]);
  if (w > 0 && h > 0) return { width: w, height: h };

  throw new Error(
    `wordmark ${slug}.svg has no usable viewBox or width/height. The marquee ` +
      `cannot reserve its width, which reopens the Safari seam gap.`,
  );
}
