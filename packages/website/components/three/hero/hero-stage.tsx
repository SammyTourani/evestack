"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { useTheme } from "next-themes";
import { HeroPoster } from "./hero-poster";
import { canRunHeroScene } from "../shared/fallback-gate";

/* Owns the fallback ladder, mount gating, and poster fallback.
   The dynamic() call MUST live in a Client Component (Next 16 hard-errors
   on ssr:false in Server Components). Narrative: capable visitors see an
   EMPTY stage, then the slabs assemble in — the poster never pre-paints
   (a stale flat frame before the 3D was a jarring first impression). It
   stays mounted at opacity 0 as the permanent fallback floor: no-JS
   (noscript style), reduced motion / weak device / no WebGL (ladder), or
   a lost context simply reveal it. */

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
  const [posterVisible, setPosterVisible] = useState(false);
  const { resolvedTheme } = useTheme();
  const theme: "dark" | "light" = resolvedTheme === "light" ? "light" : "dark";

  /* Rungs 1-3 of the ladder — before the chunk is even requested. A machine
     that can't run the scene gets the poster; a capable one gets the empty
     stage until the assemble entrance. */
  useEffect(() => {
    if (canRunHeroScene()) setEligible(true);
    else setPosterVisible(true);
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
      {/* Poster: fallback floor only — hidden for capable visitors so the
          first thing they ever see is the slabs assembling in. no-JS gets
          it via the noscript style below. */}
      <noscript>
        <style>{`[data-hero-poster]{opacity:1 !important}`}</style>
      </noscript>
      <div
        data-hero-poster
        aria-hidden
        className="absolute inset-0 transition-opacity duration-500 ease-linear"
        style={{ opacity: posterVisible && !ready ? 1 : 0 }}
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
              setPosterVisible(true);
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
