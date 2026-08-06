import { wordmarkDims } from "@/lib/logo-dims";

interface Item {
  name: string;
  slug?: string;
  /** vectorlogo.zone files carry internal padding — render taller to match */
  pad?: boolean;
}

/** Row height in px for each kind of mark. Padded (vectorlogo.zone) files
    carry whitespace inside the SVG, so they run taller to look the same. */
const ROW_H = { plain: 28, pad: 44 } as const;

/** The exact box this mark occupies, in pixels, both as HTML attributes and
    as inline style. Both matter: the attributes give the UA an aspect ratio
    before any bytes arrive, the style pins the used width so it cannot shift
    by a pixel when the SVG resolves. A group whose width moves after the
    animation starts is precisely what tears the row on WebKit. */
function renderedBox(slug: string, pad?: boolean) {
  const height = pad ? ROW_H.pad : ROW_H.plain;
  const intrinsic = wordmarkDims(slug);
  const width = Math.round((height * intrinsic.width) / intrinsic.height);
  return { width, height, style: { width, height } };
}

/* Stripe-style wordmark marquee: one slow, seam-proof row of REAL brand
   logotypes, each in its own typeface (Stripe's own hero carousel renders
   ~34px inline SVG wordmarks the same way). Light theme shows full brand
   color; dark theme runs grayscale+invert — knockout details survive and
   every mark lands as silver-on-black (the Vercel customer-strip look).
   The same group renders 4× and each copy animates by exactly its own
   width + one gap, so the hand-off is invisible at any viewport. Reduced
   motion shows a static row. Zero JS.

   Three things here are load-bearing and easy to undo by accident:

   - Every image gets an EXPLICIT pixel width, computed at build time from
     the SVG's own aspect ratio. Not `w-auto`: a group sized by its images
     changes width when they arrive, and WebKit resolves the keyframe's
     `-100%` exactly once and never re-resolves it (Chrome does). A group
     that resizes mid-animation stops handing off by its own width and tears
     a visible gap in the row. Fixed widths make the track identical whether
     the images have loaded or not.

   - Nothing here is lazy. Three of the four groups sit outside the viewport
     horizontally, and WebKit never fires their lazy-load intersection, so
     they stayed permanently blank and scrolled a hole through the row. They
     are four copies of the same 20 URLs, so eager costs one cached fetch
     each; `fetchpriority="low"` keeps them behind everything that matters.

   - The row never pauses. It is ambient, not a control, so hover does
     nothing. A marquee that stops under the cursor reads as a hang. */
export function LogoMarquee({ items }: { items: readonly Item[] }) {
  return (
    <div
      className="relative overflow-hidden"
      style={{
        maskImage:
          "linear-gradient(to right, transparent, black 10%, black 90%, transparent)",
        WebkitMaskImage:
          "linear-gradient(to right, transparent, black 10%, black 90%, transparent)",
      }}
    >
      <ul
        aria-label="Supported integrations"
        className="group flex w-max gap-[var(--marquee-gap)] [--marquee-gap:4.5rem]"
      >
        {[0, 1, 2, 3].map((dup) => (
          <li
            key={dup}
            aria-hidden={dup > 0}
            className="flex shrink-0 animate-marquee items-center gap-[var(--marquee-gap)] motion-reduce:animate-none"
            style={{ animationDuration: "110s" }}
          >
            {items.map((item) =>
              item.slug ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={item.name}
                  src={`/logos/wordmarks/${item.slug}.svg`}
                  alt={item.name}
                  decoding="async"
                  fetchPriority="low"
                  {...renderedBox(item.slug, item.pad)}
                  className="shrink-0 dark:[filter:grayscale(1)_invert(1)_brightness(1.35)]"
                />
              ) : (
                <span
                  key={item.name}
                  className="whitespace-nowrap font-mono text-mono-13 text-gray-700"
                >
                  {item.name}
                </span>
              ),
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
