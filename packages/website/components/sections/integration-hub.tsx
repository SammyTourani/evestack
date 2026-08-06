"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { cn } from "@/lib/utils";
import { withBase } from "@/lib/asset";
import { integrations } from "@/lib/copy";

/* The integrations centerpiece: equal-size tool tiles beam into the ▚ agent
   node at dead center. Two motion layers, both endless while in view:
   - ambient: every beam carries a quiet stream of inbound pulses (staggered
     SMIL, one per tool — every tool talks to the agent, forever)
   - calls: an infinite loop of real Composio actions (names verbatim from
     evestack-composio's source) — request pulse rides OUT to the tool,
     result pulse rides BACK, the node pings, the labeled call lands.
   Hovering a tile lights its beam. Reduced motion: static beams, settled
   label. SSR renders the settled call (no-JS truth). */

type HubApp = { name: string; slug: string };

interface Beam {
  slug: string;
  d: string;
  end: { x: number; y: number };
}

const { left: LEFT, right: RIGHT, calls: CALLS } = integrations.hub;
const SETTLED = CALLS[CALLS.length - 1];

/* Pointer-reactive dot grid (Warp/Browserbase family): dots repel and
   brighten inside a Gaussian falloff around the cursor, then spring home.
   Canvas draws the same 24px grid as the CSS fallback; the fallback stays
   for no-JS / reduced-motion / touch. rAF runs only while the pointer is
   inside or dots are still settling. */
function DotField({
  rootRef,
  onLive,
}: {
  rootRef: RefObject<HTMLDivElement | null>;
  onLive: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    const root = rootRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!root || !canvas || !ctx) return;

    const GAP = 24;
    const MAX_PUSH = 10;
    const SIGMA2 = 90 * 90; // Gaussian falloff radius²
    type Dot = { x: number; y: number; ox: number; oy: number; b: number };
    let dots: Dot[] = [];
    let W = 0;
    let H = 0;
    let dpr = 1;
    let raf = 0;
    let active = false;
    let settled = true;
    let last = 0;
    const mouse = { x: -9999, y: -9999 };
    let baseColor = "rgb(255 255 255 / 0.13)";
    let glowColor = "#878787";

    const readColors = () => {
      const cs = getComputedStyle(root);
      baseColor = cs.getPropertyValue("--ds-border-subtle").trim() || baseColor;
      glowColor = cs.getPropertyValue("--ds-gray-600").trim() || glowColor;
    };

    const size = () => {
      const r = root.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      W = r.width;
      H = r.height;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      dots = [];
      for (let y = GAP; y < H; y += GAP)
        for (let x = GAP; x < W; x += GAP) dots.push({ x, y, ox: 0, oy: 0, b: 0 });
    };

    const draw = (dt: number) => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const k = Math.min(1, dt * 9);
      settled = true;
      for (const d of dots) {
        const dx = d.x - mouse.x;
        const dy = d.y - mouse.y;
        const dist2 = dx * dx + dy * dy;
        const f = active ? Math.exp(-dist2 / SIGMA2) : 0;
        const dist = Math.sqrt(dist2) || 1;
        d.ox += ((dx / dist) * f * MAX_PUSH - d.ox) * k;
        d.oy += ((dy / dist) * f * MAX_PUSH - d.oy) * k;
        d.b += (f - d.b) * k;
        if (Math.abs(d.ox) + Math.abs(d.oy) + d.b > 0.02) settled = false;
        ctx.beginPath();
        ctx.arc(d.x + d.ox, d.y + d.oy, 1 + d.b * 0.9, 0, 6.2832);
        ctx.fillStyle = d.b > 0.05 ? glowColor : baseColor;
        ctx.globalAlpha = d.b > 0.05 ? 0.3 + d.b * 0.7 : 1;
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };

    const step = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      draw(dt);
      if (active || !settled) raf = requestAnimationFrame(step);
      else raf = 0;
    };
    const kick = () => {
      if (!raf) {
        last = performance.now();
        raf = requestAnimationFrame(step);
      }
    };

    readColors();
    size();
    draw(1);
    onLive(); // canvas now owns the grid — hide the CSS fallback

    const ac = new AbortController();
    root.addEventListener(
      "pointerenter",
      () => {
        readColors(); // theme may have flipped since last hover
        active = true;
        kick();
      },
      { signal: ac.signal },
    );
    root.addEventListener(
      "pointermove",
      (e) => {
        const r = root.getBoundingClientRect();
        mouse.x = e.clientX - r.left;
        mouse.y = e.clientY - r.top;
      },
      { signal: ac.signal },
    );
    root.addEventListener(
      "pointerleave",
      () => {
        active = false;
        mouse.x = -9999;
        mouse.y = -9999;
        kick(); // let the dots spring home, then the loop parks itself
      },
      { signal: ac.signal },
    );
    const ro = new ResizeObserver(() => {
      size();
      draw(1);
    });
    ro.observe(root);
    return () => {
      ac.abort();
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none absolute inset-0 h-full w-full [mask-image:radial-gradient(ellipse_at_center,black_25%,transparent_72%)]"
    />
  );
}

function Tile({ app, active, hovered, onHover }: {
  app: HubApp;
  active: boolean;
  hovered: boolean;
  onHover: (slug: string | null) => void;
}) {
  return (
    <div
      data-hub-app={app.slug}
      title={app.name}
      aria-label={app.name}
      onMouseEnter={() => onHover(app.slug)}
      onMouseLeave={() => onHover(null)}
      className={cn(
        "flex h-14 w-14 items-center justify-center rounded-xl border bg-background-100 transition-[border-color,box-shadow] duration-300 md:h-16 md:w-16",
        active || hovered
          ? "border-border-default shadow-[0_0_0_1px_var(--ds-border-subtle)]"
          : "border-border-subtle",
      )}
    >
      <span aria-hidden className="logo-tile h-9 w-9 shrink-0 rounded-lg md:h-10 md:w-10">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={withBase(`/logos/${app.slug}.svg`)} alt="" className="h-[62%] w-[62%]" loading="lazy" />
      </span>
    </div>
  );
}

export function IntegrationHub() {
  const rootRef = useRef<HTMLDivElement>(null);
  const pulseRefs = useRef(new Map<string, SVGAnimationElement[]>());
  const [beams, setBeams] = useState<Beam[]>([]);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [reduced, setReduced] = useState(false);
  const [agentEnd, setAgentEnd] = useState<{ x: number; y: number } | null>(null);
  const [call, setCall] = useState<(typeof CALLS)[number]>(SETTLED);
  const [callKey, setCallKey] = useState(0); // retriggers ping + label pop
  const [activeApp, setActiveApp] = useState<string | null>(null);
  const [hoverApp, setHoverApp] = useState<string | null>(null);
  const [dotsLive, setDotsLive] = useState(false);

  /* measure tile→agent beams (same technique as the architecture diagram) */
  useEffect(() => {
    setReduced(window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    const root = rootRef.current;
    if (!root) return;

    const measure = () => {
      const crect = root.getBoundingClientRect();
      setSize({ w: crect.width, h: crect.height });
      const agent = root.querySelector<HTMLElement>("[data-hub-agent]");
      if (!agent) return;
      const a = agent.getBoundingClientRect();
      const aL = { x: a.left - crect.left, y: a.top - crect.top + a.height / 2 };
      const aR = { x: a.right - crect.left, y: a.top - crect.top + a.height / 2 };
      setAgentEnd({ x: aL.x + a.width / 2, y: aL.y });

      const next: Beam[] = [];
      const spread = [-15, -5, 5, 15];
      const mk = (apps: readonly HubApp[], side: "left" | "right") => {
        apps.forEach((app, i) => {
          const el = root.querySelector<HTMLElement>(`[data-hub-app='${app.slug}']`);
          if (!el) return;
          const r = el.getBoundingClientRect();
          const from =
            side === "left"
              ? { x: r.right - crect.left, y: r.top - crect.top + r.height / 2 }
              : { x: r.left - crect.left, y: r.top - crect.top + r.height / 2 };
          const to =
            side === "left"
              ? { x: aL.x, y: aL.y + spread[i] }
              : { x: aR.x, y: aR.y + spread[i] };
          const bend = Math.max(28, Math.abs(to.x - from.x) * 0.42);
          const dir = to.x > from.x ? 1 : -1;
          const d = `M ${from.x} ${from.y} C ${from.x + bend * dir} ${from.y}, ${to.x - bend * dir} ${to.y}, ${to.x} ${to.y}`;
          next.push({ slug: app.slug, d, end: to });
        });
      };
      mk(LEFT, "left");
      mk(RIGHT, "right");
      setBeams(next);
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    document.fonts?.ready.then(measure).catch(() => {});
    return () => ro.disconnect();
  }, []);

  /* the endless call loop — request out, result back, label lands.
     Runs only while the hub is in view; every tool also hums ambient
     traffic via the indefinite SMIL pulses below. */
  useEffect(() => {
    if (reduced || !beams.length) return;
    const root = rootRef.current;
    if (!root) return;
    let stopped = false;
    let inView = false;
    const timers: number[] = [];
    const wait = (ms: number) =>
      new Promise<void>((res) => timers.push(window.setTimeout(res, ms)));
    const fire = (slug: string, dir: "out" | "in") =>
      pulseRefs.current.get(`${slug}:${dir}`)?.forEach((el) => el.beginElement());

    const loop = async () => {
      let i = 0;
      while (!stopped) {
        if (!inView) {
          await wait(400);
          continue;
        }
        const c = CALLS[i % CALLS.length];
        i++;
        setActiveApp(c.app);
        fire(c.app, "out"); // request: agent → tool
        await wait(560);
        if (stopped) return;
        fire(c.app, "in"); // result: tool → agent
        await wait(560);
        if (stopped) return;
        setCall(c);
        setCallKey((k) => k + 1);
        await wait(1500);
        setActiveApp(null);
        await wait(320);
      }
    };

    const io = new IntersectionObserver(
      ([entry]) => {
        inView = entry.isIntersecting;
      },
      { threshold: 0.25 },
    );
    io.observe(root);
    loop();
    return () => {
      stopped = true;
      io.disconnect();
      timers.forEach(clearTimeout);
    };
  }, [reduced, beams.length]);

  const registerPulse = (key: string) => (el: SVGAnimationElement | null) => {
    if (!el) return;
    const list = pulseRefs.current.get(key) ?? [];
    if (!list.includes(el)) pulseRefs.current.set(key, [...list, el]);
  };

  return (
    <div
      ref={rootRef}
      className="relative overflow-hidden rounded-xl border border-border-default bg-background-200 px-5 py-12 md:px-12 md:py-16"
    >
      {/* graph-paper backdrop, faded at the edges — CSS at rest, canvas
         (pointer-reactive) once DotField takes over */}
      <div
        aria-hidden
        className={cn(
          "absolute inset-0 [background-image:radial-gradient(var(--ds-border-subtle)_1px,transparent_1px)] [background-size:24px_24px] [mask-image:radial-gradient(ellipse_at_center,black_25%,transparent_72%)]",
          dotsLive && "hidden",
        )}
      />
      <DotField rootRef={rootRef} onLive={() => setDotsLive(true)} />

      <p className="sr-only">
        Connected tools: {[...LEFT, ...RIGHT].map((a) => a.name).join(", ")}. The agent
        executes Composio tool calls such as {CALLS.map((c) => c.action).join(", ")}.
      </p>

      {/* the landed call — settled state is SSR'd (no-JS truth) */}
      <div
        key={callKey}
        aria-hidden
        className={cn(
          "pointer-events-none absolute left-1/2 top-5 flex -translate-x-1/2 items-center gap-2 whitespace-nowrap font-mono text-[10px] md:text-label-12",
          callKey > 0 && "animate-[hub-label-in_0.35s_cubic-bezier(0.16,1,0.3,1)]",
        )}
      >
        <span className="logo-tile h-4 w-4 rounded-[4px]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={withBase(`/logos/${call.app}.svg`)} alt="" className="h-[62%] w-[62%]" />
        </span>
        <span className="text-gray-1000">{call.action}</span>
        <span className="text-ok">✓ {call.ms}ms</span>
      </div>

      {/* 1fr | auto | 1fr — the agent node is at dead center by construction */}
      <div className="relative grid grid-cols-[1fr_auto_1fr] items-center">
        <div className="flex flex-col items-start gap-4">
          {LEFT.map((app) => (
            <Tile key={app.slug} app={app} active={activeApp === app.slug} hovered={hoverApp === app.slug} onHover={setHoverApp} />
          ))}
        </div>
        <div
          data-hub-agent
          className="relative z-10 flex flex-col items-center gap-1 rounded-xl border border-border-default bg-background-100 px-6 py-5 shadow-[0_0_24px_-8px_var(--ds-border-strong)]"
        >
          <span aria-hidden className="text-heading-24 leading-none text-blue-700">▚</span>
          <span className="font-mono text-mono-13 text-gray-1000">agent</span>
          <span className="font-mono text-label-12 text-gray-700">:2000</span>
        </div>
        <div className="flex flex-col items-end gap-4">
          {RIGHT.map((app) => (
            <Tile key={app.slug} app={app} active={activeApp === app.slug} hovered={hoverApp === app.slug} onHover={setHoverApp} />
          ))}
        </div>
      </div>

      {beams.length ? (
        <svg
          aria-hidden
          className="pointer-events-none absolute inset-0 h-full w-full"
          viewBox={`0 0 ${size.w} ${size.h}`}
          fill="none"
        >
          {beams.map((beam, i) => {
            const lit = hoverApp === beam.slug || activeApp === beam.slug;
            return (
              <g key={beam.slug + beam.end.y}>
                <path
                  d={beam.d}
                  stroke={lit ? "var(--ds-gray-600)" : "var(--ds-border-subtle)"}
                  strokeWidth="1"
                  style={{ transition: "stroke 0.3s ease" }}
                />
                <circle cx={beam.end.x} cy={beam.end.y} r="2" fill="var(--ds-gray-500)" />
                {!reduced ? (
                  <>
                    {/* ambient hum: every tool streams to the agent, forever */}
                    <circle r="1.75" fill="var(--ds-gray-600)" opacity="0">
                      <animateMotion
                        begin={`${i * 0.55}s`}
                        dur={`${3.2 + (i % 4) * 0.45}s`}
                        repeatCount="indefinite"
                        path={beam.d}
                        keyPoints="0;1"
                        keyTimes="0;1"
                        calcMode="linear"
                      />
                      <animate
                        attributeName="opacity"
                        begin={`${i * 0.55}s`}
                        dur={`${3.2 + (i % 4) * 0.45}s`}
                        repeatCount="indefinite"
                        values="0;0.55;0.55;0"
                        keyTimes="0;0.12;0.85;1"
                      />
                    </circle>
                    {/* request pulse — parked until the loop fires it (agent → tool) */}
                    <circle r="2.5" fill="var(--ds-gray-800)" opacity="0">
                      <animateMotion
                        ref={registerPulse(`${beam.slug}:out`)}
                        begin="indefinite"
                        dur="0.55s"
                        path={beam.d}
                        keyPoints="1;0"
                        keyTimes="0;1"
                        calcMode="spline"
                        keySplines="0.4 0 0.2 1"
                      />
                      <animate
                        ref={registerPulse(`${beam.slug}:out`)}
                        attributeName="opacity"
                        begin="indefinite"
                        dur="0.55s"
                        values="0;0.9;0.9;0"
                        keyTimes="0;0.12;0.8;1"
                      />
                    </circle>
                    {/* result pulse — tool → agent */}
                    <circle r="2.5" fill="var(--ds-blue-700)" opacity="0">
                      <animateMotion
                        ref={registerPulse(`${beam.slug}:in`)}
                        begin="indefinite"
                        dur="0.55s"
                        path={beam.d}
                        keyPoints="0;1"
                        keyTimes="0;1"
                        calcMode="spline"
                        keySplines="0.4 0 0.2 1"
                      />
                      <animate
                        ref={registerPulse(`${beam.slug}:in`)}
                        attributeName="opacity"
                        begin="indefinite"
                        dur="0.55s"
                        values="0;0.95;0.95;0"
                        keyTimes="0;0.12;0.8;1"
                      />
                    </circle>
                  </>
                ) : null}
              </g>
            );
          })}
          {agentEnd && !reduced ? (
            <circle
              key={callKey}
              className="hub-ping"
              data-live={callKey > 0 || undefined}
              cx={agentEnd.x}
              cy={agentEnd.y}
              r="40"
              stroke="var(--ds-gray-600)"
              strokeWidth="1"
            />
          ) : null}
        </svg>
      ) : null}
    </div>
  );
}
