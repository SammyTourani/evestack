"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { useTheme } from "next-themes";
import { HeroPoster } from "./hero-poster";
import { canRunHeroScene } from "../shared/fallback-gate";

/* Owns the fallback ladder, mount gating, and poster crossfade.
   The dynamic() call MUST live in a Client Component (Next 16 hard-errors
   on ssr:false in Server Components). The poster renders immediately and
   stays mounted forever underneath — a lost context simply reveals it. */

const HeroCanvas = dynamic(() => import("./hero-canvas"), {
  ssr: false,
  loading: () => null,
});

export function HeroStage() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [eligible, setEligible] = useState(false);
  const [mount, setMount] = useState(false);
  const [inView, setInView] = useState(true);
  const [ready, setReady] = useState(false);
  const { resolvedTheme } = useTheme();
  const theme: "dark" | "light" = resolvedTheme === "light" ? "light" : "dark";

  /* Rungs 1-3 of the ladder — before the chunk is even requested. */
  useEffect(() => {
    if (canRunHeroScene()) setEligible(true);
  }, []);

  /* Mount gating: post-hydration idle + hero visible → request the chunk. */
  useEffect(() => {
    if (!eligible) return;
    const ric = window.requestIdleCallback as typeof window.requestIdleCallback | undefined;
    if (ric) {
      const handle = ric(() => setMount(true));
      return () => window.cancelIdleCallback(handle);
    }
    const handle = window.setTimeout(() => setMount(true), 350);
    return () => window.clearTimeout(handle);
  }, [eligible]);

  /* frameloop gate: pause rendering entirely when the hero scrolls away. */
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), {
      rootMargin: "120px",
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div ref={wrapRef} className="relative h-full w-full">
      {/* Poster: pre-canvas frame + permanent fallback floor */}
      <div
        aria-hidden
        className="absolute inset-0 transition-opacity duration-700 ease-linear"
        style={{ opacity: ready ? 0 : 1 }}
      >
        <HeroPoster />
      </div>
      {mount ? (
        <div
          className="absolute inset-0 transition-opacity duration-700 ease-linear"
          style={{ opacity: ready ? 1 : 0 }}
        >
          <HeroCanvas
            theme={theme}
            inView={inView}
            onReady={() => setReady(true)}
            onFailed={() => {
              setReady(false);
              setMount(false);
              setEligible(false);
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
