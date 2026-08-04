"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { integrations } from "@/lib/copy";

/* The integrations centerpiece: tool tiles beam into the ▚ agent node, and
   the hub periodically FIRES a real Composio action (names verbatim from
   evestack-composio's source) — pulse rides the beam, the node pings, the
   call label lands. Finite: two rounds through the call list, then settles
   on the last call (which is also the SSR state — no-JS truth). Ambient
   SMIL pulses carry the "always connected" story, like the architecture
   diagram. Hovering a tile lights its beam. */

type HubApp = { name: string; slug: string };

interface Beam {
  slug: string;
  d: string;
  end: { x: number; y: number };
}

const { left: LEFT, right: RIGHT, calls: CALLS } = integrations.hub;
const APPS: HubApp[] = [...LEFT, ...RIGHT];
const SETTLED = CALLS[CALLS.length - 1];

function Tile({ app, side, active, hovered, onHover }: {
  app: HubApp;
  side: "left" | "right";
  active: boolean;
  hovered: boolean;
  onHover: (slug: string | null) => void;
}) {
  return (
    <div
      data-hub-app={app.slug}
      onMouseEnter={() => onHover(app.slug)}
      onMouseLeave={() => onHover(null)}
      className={cn(
        "flex items-center gap-2.5 rounded-lg border bg-background-100 p-2 transition-[border-color,box-shadow] duration-300 md:px-3",
        side === "right" && "flex-row-reverse md:flex-row",
        active || hovered
          ? "border-border-default shadow-[0_0_0_1px_var(--ds-border-subtle)]"
          : "border-border-subtle",
      )}
    >
      <span aria-hidden className="logo-tile h-7 w-7 shrink-0 rounded-[6px]">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={`/logos/${app.slug}.svg`} alt="" className="h-[62%] w-[62%]" loading="lazy" />
      </span>
      <span className="hidden whitespace-nowrap font-mono text-mono-13 text-gray-900 md:inline">
        {app.name}
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

  /* the firing sequence — two rounds, then settle (finite; WCAG 2.2.2) */
  useEffect(() => {
    if (reduced || !beams.length) return;
    const root = rootRef.current;
    if (!root) return;
    let stopped = false;
    const timers: number[] = [];
    const wait = (ms: number) => new Promise<void>((res) => timers.push(window.setTimeout(res, ms)));

    const run = async () => {
      for (let round = 0; round < 2 && !stopped; round++) {
        for (const c of CALLS) {
          if (stopped) return;
          setActiveApp(c.app);
          pulseRefs.current.get(c.app)?.forEach((el) => el.beginElement());
          await wait(620); // pulse arrival
          if (stopped) return;
          setCall(c);
          setCallKey((k) => k + 1);
          await wait(1500);
        }
      }
      setActiveApp(null);
    };

    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        io.disconnect();
        run();
      },
      { threshold: 0.3 },
    );
    io.observe(root);
    return () => {
      stopped = true;
      io.disconnect();
      timers.forEach(clearTimeout);
    };
  }, [reduced, beams.length]);

  const registerPulse = (slug: string) => (el: SVGAnimationElement | null) => {
    if (!el) return;
    const list = pulseRefs.current.get(slug) ?? [];
    if (!list.includes(el)) pulseRefs.current.set(slug, [...list, el]);
  };

  return (
    <div
      ref={rootRef}
      className="relative overflow-hidden rounded-xl border border-border-default bg-background-200 px-4 py-10 md:px-10 md:py-14"
    >
      {/* the landed call — settled state is SSR'd (no-JS truth) */}
      <p className="sr-only">
        The agent executes Composio tool calls such as {CALLS.map((c) => c.action).join(", ")}.
      </p>
      <div
        key={callKey}
        aria-hidden
        className={cn(
          "pointer-events-none absolute left-1/2 top-4 flex -translate-x-1/2 items-center gap-2 whitespace-nowrap font-mono text-[10px] md:text-label-12",
          callKey > 0 && "animate-[hub-label-in_0.35s_cubic-bezier(0.16,1,0.3,1)]",
        )}
      >
        <span className="text-gray-1000">{call.action}</span>
        <span className="text-ok">✓ {call.ms}ms</span>
      </div>

      <div className="grid grid-cols-[auto_minmax(48px,1fr)_auto_minmax(48px,1fr)_auto] items-center">
        <div className="flex flex-col gap-3">
          {LEFT.map((app) => (
            <Tile key={app.slug} app={app} side="left" active={activeApp === app.slug} hovered={hoverApp === app.slug} onHover={setHoverApp} />
          ))}
        </div>
        <div />
        <div
          data-hub-agent
          className="relative z-10 flex flex-col items-center gap-1 rounded-xl border border-border-default bg-background-100 px-5 py-4 shadow-[0_0_24px_-8px_var(--ds-border-strong)]"
        >
          <span aria-hidden className="text-heading-24 leading-none text-blue-700">▚</span>
          <span className="font-mono text-mono-13 text-gray-1000">agent</span>
          <span className="font-mono text-label-12 text-gray-700">:2000</span>
        </div>
        <div />
        <div className="flex flex-col gap-3">
          {RIGHT.map((app) => (
            <Tile key={app.slug} app={app} side="right" active={activeApp === app.slug} hovered={hoverApp === app.slug} onHover={setHoverApp} />
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
          {beams.map((beam) => {
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
                  /* call pulse — parked until the driver fires it */
                  <circle r="2.5" fill="var(--ds-blue-700)" opacity="0">
                    <animateMotion
                      ref={registerPulse(beam.slug)}
                      begin="indefinite"
                      dur="0.6s"
                      path={beam.d}
                      keyPoints="0;1"
                      keyTimes="0;1"
                      calcMode="spline"
                      keySplines="0.4 0 0.2 1"
                    />
                    <animate
                      ref={registerPulse(beam.slug)}
                      attributeName="opacity"
                      begin="indefinite"
                      dur="0.6s"
                      values="0;0.95;0.95;0"
                      keyTimes="0;0.12;0.8;1"
                    />
                  </circle>
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
              r="34"
              stroke="var(--ds-gray-600)"
              strokeWidth="1"
            />
          ) : null}
        </svg>
      ) : null}
    </div>
  );
}
