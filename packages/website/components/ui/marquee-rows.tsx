import { cn } from "@/lib/utils";

interface Item {
  name: string;
  slug?: string;
  /** vectorlogo.zone files carry internal padding — render taller to match */
  pad?: boolean;
}

/* Stripe-style wordmark marquee: one slow, seam-proof row of REAL brand
   logotypes, each in its own typeface (Stripe's own hero carousel renders
   ~34px inline SVG wordmarks the same way). Light theme shows full brand
   color; dark theme runs grayscale+invert — knockout details survive and
   every mark lands as silver-on-black (the Vercel customer-strip look).
   The same group renders 4× and each copy animates by exactly its own
   width + one gap, so the hand-off is invisible at any viewport. Hover
   pauses; reduced motion shows a static row. Zero JS. */
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
            className="flex shrink-0 animate-marquee items-center gap-[var(--marquee-gap)] group-hover:[animation-play-state:paused] motion-reduce:animate-none"
            style={{ animationDuration: "110s" }}
          >
            {items.map((item) =>
              item.slug ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={item.name}
                  src={`/logos/wordmarks/${item.slug}.svg`}
                  alt={item.name}
                  loading="lazy"
                  className={cn(
                    "w-auto shrink-0 dark:[filter:grayscale(1)_invert(1)_brightness(1.35)]",
                    item.pad ? "h-11" : "h-7",
                  )}
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
