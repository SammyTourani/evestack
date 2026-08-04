"use client";

import { useEffect, useRef } from "react";

/* SSRs the FINAL value (no-JS = truth). On first in-view, counts up via rAF.
   Zero-CLS recipe (Browserbase/Neon consensus): an invisible span reserves
   the final width, an absolute aria-hidden span animates over it, and the
   integer part is zero-padded to the final digit count so glyphs never
   reflow. IO once + disconnect = the count never rewinds on scroll-back. */
export function CountUp({
  value,
  prefix = "",
  suffix = "",
  decimals = 0,
  delay = 0,
  className,
}: {
  value: number;
  prefix?: string;
  suffix?: string;
  decimals?: number;
  /** seconds — lets a row of tiles stagger without an orchestrator */
  delay?: number;
  className?: string;
}) {
  const animRef = useRef<HTMLSpanElement>(null);
  const intDigits = Math.max(1, Math.trunc(Math.abs(value)).toString().length);
  const format = (v: number) => {
    const [int, frac] = v.toFixed(decimals).split(".");
    const padded = int.padStart(intDigits, "0");
    return `${prefix}${padded}${frac ? `.${frac}` : ""}${suffix}`;
  };
  const final = format(value);

  useEffect(() => {
    const el = animRef.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let raf = 0;
    let timeout = 0;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        io.disconnect();
        const run = () => {
          const start = performance.now();
          const duration = 600;
          const tick = (now: number) => {
            const t = Math.min((now - start) / duration, 1);
            const eased = 1 - Math.pow(2, -10 * t); // expo.out
            el.textContent = format(value * (t === 1 ? 1 : eased));
            if (t < 1) raf = requestAnimationFrame(tick);
          };
          el.textContent = format(0);
          raf = requestAnimationFrame(tick);
        };
        timeout = window.setTimeout(run, delay * 1000);
      },
      { rootMargin: "-20% 0px -20% 0px" },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
      clearTimeout(timeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, prefix, suffix, decimals, delay]);

  return (
    <span
      aria-label={final}
      className={`relative inline-block ${className ?? ""}`}
      style={{ fontVariantNumeric: "tabular-nums" }}
    >
      {/* width reserver — the layout never learns the count is animating */}
      <span aria-hidden className="invisible">
        {final}
      </span>
      <span ref={animRef} aria-hidden className="absolute inset-0">
        {final}
      </span>
    </span>
  );
}
