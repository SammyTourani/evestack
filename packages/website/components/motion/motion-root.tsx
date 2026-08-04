"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { ReactLenis } from "lenis/react";

/* Thin shell: Lenis provider + reduced-motion gate. The entire GSAP
   orchestrator (choreography.tsx) is a post-hydration lazy chunk so the
   critical bundle stays lean.

   IMPORTANT: Lenis smoothing must NEVER be armed without a raf driver —
   with smoothWheel on, Lenis preventDefaults wheel events and only moves
   the page inside lenis.raf(), and the only raf driver (gsap.ticker) lives
   in the lazy chunk. smoothWheel therefore stays false until Choreography
   reports it is mounted and driving; native scroll rules until then, and
   forever if the chunk never arrives. */

const Choreography = dynamic(() => import("./choreography"), {
  ssr: false,
  loading: () => null,
});

export function MotionRoot({ children }: { children: React.ReactNode }) {
  const [reduced, setReduced] = useState<boolean | null>(null);
  const [choreoReady, setChoreoReady] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  /* Tree shape is IDENTICAL in every mode (no remount flash) — in root mode
     ReactLenis renders children unwrapped. */
  return (
    <ReactLenis
      root
      options={{
        autoRaf: false,
        lerp: 0.1,
        anchors: true,
        smoothWheel: reduced === false && choreoReady,
      }}
    >
      {reduced === false ? <Choreography onReady={() => setChoreoReady(true)} /> : null}
      {children}
    </ReactLenis>
  );
}
