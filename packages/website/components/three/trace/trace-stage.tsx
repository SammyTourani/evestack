"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { canRunHeroScene } from "../shared/fallback-gate";

const TraceCanvas = dynamic(() => import("./trace-canvas"), { ssr: false, loading: () => null });

/* Decorative particle background for the observability section.
   Lazy: chunk requested 800px before arrival; the shared three vendor
   chunk is already cached from the hero. No fallback needed — the DOM
   span tree beside it carries the content. */
export function TraceStage() {
  const ref = useRef<HTMLDivElement>(null);
  const [mount, setMount] = useState(false);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || !canRunHeroScene()) return;
    const approach = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setMount(true);
          approach.disconnect();
        }
      },
      { rootMargin: "800px" },
    );
    approach.observe(el);
    return () => approach.disconnect();
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el || !mount) return;
    const io = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), {
      rootMargin: "120px",
    });
    io.observe(el);
    return () => io.disconnect();
  }, [mount]);

  return (
    <div
      ref={ref}
      aria-hidden
      className="pointer-events-none absolute inset-0 opacity-90"
      style={{
        maskImage:
          "radial-gradient(ellipse 75% 80% at 50% 50%, black 55%, transparent 100%)",
      }}
    >
      {mount ? <TraceCanvas inView={inView} /> : null}
    </div>
  );
}
