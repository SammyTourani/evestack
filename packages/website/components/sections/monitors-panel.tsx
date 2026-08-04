"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { CountUp } from "@/components/ui/count-up";
import { baseSessions, liveSessions } from "@/lib/demo-data";
import { observability } from "@/lib/copy";

/* Datadog-grade monitors panel, built from the SAME dataset the dashboard
   demo shows (lib/demo-data.ts) — percentiles are computed, not typed, and
   the latency spike in the chart is the real 41.0s essay run. SSR renders
   the settled state (no-JS / reduced-motion truth); with motion allowed the
   panel arms on mount and plays one staged pass when scrolled into view
   (Axiom's waterfall recipe: bars scaleX 0→1, 0.5s ease-out, ~50ms/row).
   The line chart is interactive — pointer crosshair + session tooltip. */

/* chronological, oldest → newest (matches the dashboard's "started" column) */
const SESSIONS = [
  baseSessions[4], // race test            3.4s
  baseSessions[3], // say ok               2.1s
  baseSessions[2], // bash sandbox        12.8s
  baseSessions[1], // subagent delegate   28.4s
  baseSessions[0], // 1500-word essay     41.0s  ← the spike
  liveSessions[0], // deploy email        18.2s
  liveSessions[1], // error-log summary   14.6s
  liveSessions[2], // release notes       16.9s
];

const durations = SESSIONS.map((s) => s.durationS);
const sorted = [...durations].sort((a, b) => a - b);
const pct = (p: number) => {
  const i = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(i);
  return sorted[lo] + (sorted[Math.min(lo + 1, sorted.length - 1)] - sorted[lo]) * (i - lo);
};
const P = [
  { label: "p50", value: pct(50), cls: "text-gray-1000" },
  { label: "p75", value: pct(75), cls: "text-blue-700" },
  { label: "p95", value: pct(95), cls: "text-warn" },
  { label: "p99", value: pct(99), cls: "text-err" },
];

/* line chart geometry (viewBox space) */
const W = 560;
const H = 180;
const PX = 10;
const PY = 18;
const MAXD = Math.max(...durations);
const PTS = SESSIONS.map((s, i) => ({
  x: PX + (i * (W - 2 * PX)) / (SESSIONS.length - 1),
  y: H - PY - (s.durationS / MAXD) * (H - 2 * PY),
  s,
}));
const LINE = PTS.map((p, i) => `${i ? "L" : "M"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
const AREA = `${LINE} L ${PTS[PTS.length - 1].x} ${H} L ${PTS[0].x} ${H} Z`;
const SPIKE = PTS.reduce((a, b) => (b.s.durationS > a.s.durationS ? b : a));

/* span waterfall — the verified FINDINGS.md tree over the 41.0s essay turn.
   Sub-span offsets are illustrative; the total is the session's real 41.0s. */
const WATERFALL = [
  { name: "agent.session", depth: 0, a: 0, b: 100, color: "var(--ds-gray-500)" },
  { name: "agent.turn", depth: 1, a: 1, b: 99, color: "var(--ds-blue-700)" },
  { name: "agent.step", depth: 2, a: 2.5, b: 97, color: "var(--ds-blue-700)" },
  { name: "ai.streamText", depth: 3, a: 4, b: 96, color: "var(--ds-ok)" },
  { name: "ai.streamText.doStream", depth: 4, a: 5, b: 95.5, color: "var(--ds-ok)" },
  { name: "agent.turn.terminal", depth: 2, a: 97, b: 100, color: "var(--ds-warn)" },
];

/* log stream — every line traces to FINDINGS.md or the demo dataset */
const LOGS = [
  { text: "GET /eve/v1/health", tag: "200 ok", tone: "text-ok" },
  { text: "run_created · wrun_01KZ6BJVMJ23…", tag: "essay run", tone: "text-gray-700" },
  { text: "ai.streamText · doStream", tag: "streaming", tone: "text-blue-700" },
  { text: "step_completed · 13 tool calls", tag: "41.0s", tone: "text-warn" },
  { text: "session completed · $0.0077 model spend", tag: "✓", tone: "text-ok" },
  { text: "[world-postgres] Re-enqueued 2 active run(s) on startup", tag: "restart", tone: "text-gray-700" },
];

const fmtS = (n: number) => `${n.toFixed(1)}s`;

export function MonitorsPanel() {
  const rootRef = useRef<HTMLDivElement>(null);
  const [armed, setArmed] = useState(false);
  const [live, setLive] = useState(false);
  const [tip, setTip] = useState<number | null>(null);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const root = rootRef.current;
    if (!root) return;
    setArmed(true);
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        io.disconnect();
        setLive(true);
      },
      { rootMargin: "0px 0px -25% 0px" },
    );
    io.observe(root);
    return () => io.disconnect();
  }, []);

  const onChartMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W;
    let best = 0;
    PTS.forEach((p, i) => {
      if (Math.abs(p.x - x) < Math.abs(PTS[best].x - x)) best = i;
    });
    setTip(best);
  };

  return (
    <div
      ref={rootRef}
      className="mon overflow-hidden rounded-xl border border-border-default bg-background-200"
      data-armed={armed || undefined}
      data-live={live || undefined}
      data-drawn={live || undefined}
    >
      {/* window chrome */}
      <div className="flex h-11 items-center gap-3 border-b border-border-subtle px-4">
        <p className="flex shrink-0 items-center gap-2 font-mono text-mono-13 text-gray-1000">
          <span aria-hidden className="text-blue-700">▚</span>
          evestack
        </p>
        <span className="text-copy-14 text-gray-700">Monitors</span>
        <span className="ml-auto inline-flex items-center gap-2 rounded-full border border-ok/40 px-2 py-0.5 font-mono text-label-12 text-ok">
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-ok" />
          self-hosted
        </span>
      </div>

      <div className="grid grid-cols-1 gap-px bg-border-subtle lg:grid-cols-12">
        {/* percentile tiles — computed from the demo dataset */}
        {P.map((p, i) => (
          <div
            key={p.label}
            data-anim="fade"
            style={{ "--d": `${i * 0.07}s` } as React.CSSProperties}
            className="flex flex-col gap-1 bg-background-100 p-5 lg:col-span-2"
          >
            <p className="font-mono text-label-12 uppercase text-gray-700">
              {p.label} duration
            </p>
            <p className={cn("font-mono text-heading-24 tabular-nums", p.cls)}>
              <CountUp value={p.value} suffix="s" decimals={1} delay={0.1 + i * 0.08} />
            </p>
          </div>
        ))}
        <div
          data-anim="fade"
          style={{ "--d": "0.28s" } as React.CSSProperties}
          className="flex flex-col gap-1 bg-background-100 p-5 lg:col-span-4"
        >
          <p className="font-mono text-label-12 uppercase text-gray-700">success · last 8 runs</p>
          <div className="flex items-center gap-3">
            <p className="font-mono text-heading-24 tabular-nums text-ok">8/8</p>
            <div className="flex items-end gap-1" aria-hidden>
              {SESSIONS.map((s, i) => (
                <span
                  key={i}
                  data-anim="bar-y"
                  style={{ "--d": `${0.3 + i * 0.05}s` } as React.CSSProperties}
                  className="h-5 w-1.5 origin-bottom rounded-[2px] bg-ok/80"
                />
              ))}
            </div>
          </div>
        </div>

        {/* latency chart — interactive crosshair; the spike is the real 41.0s essay run */}
        <div className="relative flex flex-col gap-3 bg-background-100 p-5 lg:col-span-7">
          <div className="flex items-baseline justify-between">
            <p className="font-mono text-label-12 uppercase text-gray-700">
              session duration · last 8 runs
            </p>
            <p className="font-mono text-label-12 text-gray-600">demo dataset · seconds</p>
          </div>
          <div className="relative">
            <svg
              viewBox={`0 0 ${W} ${H}`}
              className="h-auto w-full"
              onPointerMove={onChartMove}
              onPointerLeave={() => setTip(null)}
            >
              {/* grid rules */}
              {[0.25, 0.5, 0.75].map((f) => (
                <line
                  key={f}
                  x1={PX}
                  x2={W - PX}
                  y1={PY + (H - 2 * PY) * f}
                  y2={PY + (H - 2 * PY) * f}
                  stroke="var(--ds-border-subtle)"
                  strokeDasharray="3 5"
                />
              ))}
              <path
                d={AREA}
                fill="url(#mon-area)"
                data-anim="fade"
                style={{ "--d": "1s" } as React.CSSProperties}
              />
              <path
                d={LINE}
                pathLength={1}
                className={cn(armed && "beam-draw")}
                style={{ "--beam-delay": "0.2s" } as React.CSSProperties}
                stroke="var(--ds-blue-700)"
                strokeWidth="1.5"
                fill="none"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              {/* the real spike */}
              <circle
                cx={SPIKE.x}
                cy={SPIKE.y}
                r="3.5"
                fill="var(--ds-warn)"
                data-anim="pop"
                style={{ "--d": "1.4s" } as React.CSSProperties}
              />
              {tip !== null ? (
                <g>
                  <line
                    x1={PTS[tip].x}
                    x2={PTS[tip].x}
                    y1={PY - 6}
                    y2={H - PY + 6}
                    stroke="var(--ds-border-strong)"
                    strokeDasharray="2 3"
                  />
                  <circle cx={PTS[tip].x} cy={PTS[tip].y} r="3" fill="var(--ds-blue-700)" />
                </g>
              ) : null}
              <defs>
                <linearGradient id="mon-area" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--ds-blue-700)" stopOpacity="0.22" />
                  <stop offset="100%" stopColor="var(--ds-blue-700)" stopOpacity="0" />
                </linearGradient>
              </defs>
            </svg>
            {/* spike annotation */}
            <p
              data-anim="pop"
              style={
                {
                  "--d": "1.5s",
                  left: `${(SPIKE.x / W) * 100}%`,
                  top: `${(SPIKE.y / H) * 100}%`,
                } as React.CSSProperties
              }
              className="pointer-events-none absolute -translate-x-[104%] -translate-y-1/2 whitespace-nowrap font-mono text-label-12 text-warn"
            >
              41.0s · 13 tool calls
            </p>
            {tip !== null ? (
              <div
                className="pointer-events-none absolute z-10 -translate-x-1/2 rounded-md border border-border-default bg-background-200 px-2.5 py-1.5 font-mono text-label-12 shadow-lg"
                style={{
                  left: `${(PTS[tip].x / W) * 100}%`,
                  top: `${(PTS[tip].y / H) * 100 - 16}%`,
                }}
              >
                <span className="text-gray-1000">{fmtS(PTS[tip].s.durationS)}</span>{" "}
                <span className="text-gray-700">
                  · {PTS[tip].s.title.length > 26 ? `${PTS[tip].s.title.slice(0, 26)}…` : PTS[tip].s.title}
                </span>
              </div>
            ) : null}
          </div>
        </div>

        {/* span waterfall — Axiom recipe over the verified FINDINGS.md tree */}
        <div className="flex flex-col gap-3 bg-background-100 p-5 lg:col-span-5">
          <div className="flex items-baseline justify-between">
            <p className="font-mono text-label-12 uppercase text-gray-700">span waterfall · one turn</p>
            <p className="font-mono text-label-12 text-gray-600">41.0s total</p>
          </div>
          <div className="flex flex-col gap-2">
            {WATERFALL.map((row, i) => (
              <div
                key={row.name}
                data-anim="fade"
                style={{ "--d": `${0.35 + i * 0.06}s` } as React.CSSProperties}
                className="flex items-center gap-2"
              >
                <p
                  className="w-[46%] truncate font-mono text-label-12 text-gray-900"
                  style={{ paddingLeft: row.depth * 10 }}
                >
                  {row.name}
                </p>
                <div className="relative h-2 flex-1">
                  <span
                    data-anim="bar-x"
                    style={
                      {
                        "--d": `${0.45 + i * 0.06}s`,
                        left: `${row.a}%`,
                        width: `${row.b - row.a}%`,
                        background: row.color,
                      } as React.CSSProperties
                    }
                    className="absolute top-0 h-full origin-left rounded-[2px] opacity-90"
                  />
                </div>
              </div>
            ))}
          </div>
          <div className="mt-1 flex justify-between font-mono text-label-12 text-gray-600" aria-hidden>
            <span>0</span>
            <span>10s</span>
            <span>20s</span>
            <span>30s</span>
            <span>41.0s</span>
          </div>
        </div>

        {/* tokens per session */}
        <div className="flex flex-col gap-3 bg-background-100 p-5 lg:col-span-5">
          <div className="flex items-baseline justify-between">
            <p className="font-mono text-label-12 uppercase text-gray-700">tokens in / out</p>
            <p className="font-mono text-label-12 text-gray-600">per session</p>
          </div>
          <div className="flex h-24 items-end gap-2" role="img" aria-label="Tokens per session, input and output bars">
            {SESSIONS.map((s, i) => {
              const maxIn = Math.max(...SESSIONS.map((x) => x.tokensIn));
              return (
                <div key={s.id} className="flex h-full flex-1 items-end justify-center gap-0.5">
                  <span
                    data-anim="bar-y"
                    style={
                      {
                        "--d": `${0.5 + i * 0.05}s`,
                        height: `${Math.max(6, (s.tokensIn / maxIn) * 100)}%`,
                      } as React.CSSProperties
                    }
                    className="w-2.5 origin-bottom rounded-t-[2px] bg-blue-700/80"
                  />
                  <span
                    data-anim="bar-y"
                    style={
                      {
                        "--d": `${0.55 + i * 0.05}s`,
                        height: `${Math.max(4, (s.tokensOut / maxIn) * 100)}%`,
                      } as React.CSSProperties
                    }
                    className="w-2.5 origin-bottom rounded-t-[2px] bg-ok/70"
                  />
                </div>
              );
            })}
          </div>
        </div>

        {/* log stream */}
        <div className="flex flex-col gap-1.5 bg-background-100 p-5 lg:col-span-7">
          <p className="mb-1 font-mono text-label-12 uppercase text-gray-700">live tail</p>
          {LOGS.map((log, i) => (
            <p
              key={log.text}
              data-anim="fade"
              style={{ "--d": `${0.6 + i * 0.12}s` } as React.CSSProperties}
              className="flex items-baseline gap-2 truncate font-mono text-mono-13 text-gray-900"
            >
              <span className="truncate">{log.text}</span>
              <span className={cn("shrink-0 font-mono text-label-12", log.tone)}>{log.tag}</span>
            </p>
          ))}
        </div>
      </div>
      <p className="sr-only">
        Monitors computed from the demo dataset: median session duration {fmtS(pct(50))}, p95{" "}
        {fmtS(pct(95))}, 8 of 8 sessions completed. Span tree:{" "}
        {observability.spanTree.map((s) => s.name).join(" → ")}.
      </p>
    </div>
  );
}
