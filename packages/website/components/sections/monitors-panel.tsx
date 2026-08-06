"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { CountUp } from "@/components/ui/count-up";
import { baseSessions, liveSessions } from "@/lib/demo-data";
import { observability } from "@/lib/copy";

/* The observability artwork is a REAL app screen (the Linear-homepage move):
   sidebar nav, breadcrumb toolbar, environment + time-range pickers, dense
   thin charts, a sessions table with pagination — the Vercel Observability
   mold, in evestack's tokens. Every number still derives from
   lib/demo-data.ts: the runs chart plots the 8 sessions as spikes at their
   real relative start times, percentiles are computed, the duration chart's
   peak is the genuine 41.0s essay run (crosshair tooltip kept). Color is
   demoted to accents — thin blue series, tiny status dots. SSR = settled
   truth; arms client-side, plays once in view.

   TWO THINGS ARE GONE FROM THIS ARTWORK RATHER THAN ADDED TO THE DASHBOARD,
   for the same reason the comparison table lost its Passport row and the
   tracing card lost "the span tree is the product": a picture of a screen is a
   claim about that screen.

     - "Timeout 0%", beside the Error rate. lib/monitors.ts computes a failure
       rate from two signals it is careful to keep separate — turns carrying an
       error_code, and finished turns that never reached a provider — and
       nothing anywhere derives a TIMEOUT rate. eve does not distinguish one in
       error_code, so the number could only have been invented, and that module's
       own header is about not flattering these figures. Error % stayed; it is
       real.
     - The per-row activity sparkline. No page in the dashboard draws a
       sparkline, and the six-point series here was synthesised out of token
       counts and tool tallies (`s.tokensOut % 37`) — shaped like data, derived
       from nothing.

   If either is wanted, the honest order is the one cfbff14 used for the
   percentiles above: build it in packages/dashboard first, then draw it here. */

const SESSIONS = [
  baseSessions[4], // race test            3.4s   ~5h ago
  baseSessions[3], // say ok               2.1s   ~3h ago
  baseSessions[2], // bash sandbox        12.8s   ~1h ago
  baseSessions[1], // subagent delegate   28.4s   ~14m ago
  baseSessions[0], // 1500-word essay     41.0s   ~2m ago
  liveSessions[0], // deploy email        18.2s   just now
  liveSessions[1], // error-log summary   14.6s   just now
  liveSessions[2], // release notes       16.9s   just now
];

const durations = SESSIONS.map((s) => s.durationS);
const sorted = [...durations].sort((a, b) => a - b);
const pctl = (p: number) => {
  const i = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(i);
  return sorted[lo] + (sorted[Math.min(lo + 1, sorted.length - 1)] - sorted[lo]) * (i - lo);
};
const CHIPS = [
  { label: "p50", value: pctl(50), dot: "bg-gray-500" },
  { label: "p75", value: pctl(75), dot: "bg-blue-700" },
  { label: "p95", value: pctl(95), dot: "bg-warn" },
  { label: "p99", value: pctl(99), dot: "bg-err" },
];

/* ── runs chart: 8 runs as spikes at their real offsets in a 12h window ── */
const RW = 520;
const RH = 148;
const RL = 26; // left gutter for y labels
const RT = 14;
const RB = 22;
const rBase = RH - RB;
const rY = (c: number) => rBase - (c * (rBase - RT)) / 2;
/* fraction of the 12h window (0 = 12h ago, 1 = now) → spike count */
const SPIKES: [number, number][] = [
  [0.583, 1], // −5h  race test
  [0.75, 1], //  −3h  say ok
  [0.917, 1], // −1h  bash
  [0.9806, 1], // −14m subagent
  [0.9917, 1], // −6m? essay ramp-up
  [0.9965, 2], // just-now cluster (deploy + logs)
  [1, 1], //           release notes
];
const rX = (f: number) => RL + f * (RW - RL - 8);
const RUNS_PATH = (() => {
  let d = `M ${RL} ${rBase}`;
  for (const [f, c] of SPIKES) {
    const x = rX(f);
    d += ` L ${(x - 1).toFixed(1)} ${rBase} L ${(x - 1).toFixed(1)} ${rY(c)} L ${(x + 1).toFixed(1)} ${rY(c)} L ${(x + 1).toFixed(1)} ${rBase}`;
  }
  return `${d} L ${RW - 8} ${rBase}`;
})();

/* ── duration chart (crosshair kept) ── */
const DW = 520;
const DH = 148;
const DPX = 12;
const DPY = 16;
const MAXD = Math.max(...durations);
const PTS = SESSIONS.map((s, i) => ({
  x: DPX + (i * (DW - 2 * DPX)) / (SESSIONS.length - 1),
  y: DH - DPY - (s.durationS / MAXD) * (DH - 2 * DPY),
  s,
}));
const LINE = PTS.map((p, i) => `${i ? "L" : "M"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
const AREA = `${LINE} L ${PTS[PTS.length - 1].x} ${DH - 6} L ${PTS[0].x} ${DH - 6} Z`;
const SPIKE = PTS.reduce((a, b) => (b.s.durationS > a.s.durationS ? b : a));
const P95Y = DH - DPY - (pctl(95) / MAXD) * (DH - 2 * DPY);

/* table rows: the four biggest sessions */
const ROWS = [baseSessions[0], baseSessions[1], liveSessions[0], liveSessions[2]];
const fmtInt = (n: number) => n.toLocaleString("en-US");
const fmtS = (n: number) => `${n.toFixed(1)}s`;

const NAV = [
  { name: "Overview", icon: "M2 2.5h4.5V7H2zM9.5 2.5H14V7H9.5zM2 9h4.5v4.5H2zM9.5 9H14v4.5H9.5z" },
  { name: "Sessions", icon: "M2.5 4h11M2.5 8h11M2.5 12h6.5" },
  { name: "Chat", icon: "M2.5 3h11v7H8l-3 3v-3H2.5z" },
  { name: "Integrations", icon: "M5.5 2v3M10.5 2v3M4 5h8v3.2a4 4 0 01-8 0zM8 12.2V14" },
];
const OBS_NAV = [
  { name: "Monitors", icon: "M2.5 12a5.5 5.5 0 0111 0M8 12l2.6-4", active: true },
  { name: "Traces", icon: "M2.5 3.5h9M4.5 8h8M6.5 12.5h5.5" },
];

function NavItem({ name, icon, active }: { name: string; icon: string; active?: boolean }) {
  return (
    <div
      className={cn(
        "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-copy-14",
        active ? "bg-gray-100 text-gray-1000" : "text-gray-700",
      )}
    >
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
        <path d={icon} />
      </svg>
      {name}
    </div>
  );
}

function PickerChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-border-subtle px-2.5 py-1 font-mono text-label-12 text-gray-900">
      {children}
      <svg viewBox="0 0 8 6" className="h-1.5 w-2 text-gray-600" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden>
        <path d="M1 1.5L4 4.5L7 1.5" />
      </svg>
    </span>
  );
}

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
    const x = ((e.clientX - r.left) / r.width) * DW;
    let best = 0;
    PTS.forEach((p, i) => {
      if (Math.abs(p.x - x) < Math.abs(PTS[best].x - x)) best = i;
    });
    setTip(best);
  };

  return (
    <div
      ref={rootRef}
      className="mon flex overflow-hidden rounded-xl border border-border-default bg-background-200 text-left"
      data-armed={armed || undefined}
      data-live={live || undefined}
      data-drawn={live || undefined}
    >
      {/* ── sidebar ── */}
      <div className="hidden w-44 shrink-0 flex-col gap-4 border-r border-border-subtle p-3 lg:flex">
        <p className="flex items-center gap-2 px-2 pt-1 font-mono text-mono-13 text-gray-1000">
          <span aria-hidden className="text-blue-700">▚</span>
          evestack
        </p>
        <div className="flex flex-col gap-0.5">
          {NAV.map((n) => (
            <NavItem key={n.name} {...n} />
          ))}
        </div>
        <div className="flex flex-col gap-0.5">
          <p className="px-2.5 pb-1 font-mono text-label-12 uppercase text-gray-600">
            Observability
          </p>
          {OBS_NAV.map((n) => (
            <NavItem key={n.name} {...n} />
          ))}
        </div>
      </div>

      {/* ── main ── */}
      <div className="min-w-0 flex-1">
        {/* toolbar */}
        <div className="flex h-12 items-center gap-3 border-b border-border-subtle px-4">
          <p className="truncate text-copy-14">
            <span className="text-gray-700">Observability</span>
            <span className="mx-1.5 text-gray-500">/</span>
            <span className="text-gray-1000">Monitors</span>
          </p>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <PickerChip>Production</PickerChip>
            <span className="hidden md:inline-flex">
              <PickerChip>Last 12 hours</PickerChip>
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-ok/40 px-2 py-0.5 font-mono text-label-12 text-ok">
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-ok" />
              self-hosted
            </span>
          </div>
        </div>

        {/* charts */}
        <div className="grid grid-cols-1 gap-px border-b border-border-subtle bg-border-subtle xl:grid-cols-2">
          <div data-anim="fade" className="bg-background-100 p-4">
            <div className="flex items-baseline justify-between gap-3">
              <p className="font-mono text-label-12 uppercase text-gray-700">Runs</p>
              <p className="flex items-center gap-3 font-mono text-label-12 text-gray-700">
                <span className="flex items-center gap-1.5">
                  <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-err" />
                  Error 0%
                </span>

              </p>
            </div>
            <p className="mt-0.5 font-mono text-heading-20 tabular-nums text-gray-1000">
              <CountUp value={SESSIONS.length} delay={0.15} />
            </p>
            <svg viewBox={`0 0 ${RW} ${RH}`} className="mt-1 h-auto w-full" aria-hidden>
              {[1, 2].map((c) => (
                <g key={c}>
                  <line x1={RL} x2={RW - 8} y1={rY(c)} y2={rY(c)} stroke="var(--ds-border-subtle)" strokeDasharray="3 5" />
                  <text x={RL - 8} y={rY(c) + 3} textAnchor="end" className="fill-gray-600" style={{ font: "10px var(--font-mono)" }}>
                    {c}
                  </text>
                </g>
              ))}
              <text x={RL - 8} y={rBase + 3} textAnchor="end" className="fill-gray-600" style={{ font: "10px var(--font-mono)" }}>
                0
              </text>
              {/* error series: flat zero */}
              <line x1={RL} x2={RW - 8} y1={rBase} y2={rBase} stroke="var(--ds-warn)" strokeWidth="1" opacity="0.55" />
              {[0.62, 0.78, 0.9].map((f) => (
                <circle key={f} cx={rX(f)} cy={rBase} r="1.5" fill="var(--ds-warn)" opacity="0.8" />
              ))}
              <path
                d={RUNS_PATH}
                pathLength={1}
                className={cn(armed && "beam-draw")}
                style={{ "--beam-delay": "0.25s" } as React.CSSProperties}
                stroke="var(--ds-blue-700)"
                strokeWidth="1.25"
                fill="none"
              />
              <text x={RL} y={RH - 6} className="fill-gray-600" style={{ font: "10px var(--font-mono)" }}>
                12h ago
              </text>
              <text x={RW - 8} y={RH - 6} textAnchor="end" className="fill-gray-600" style={{ font: "10px var(--font-mono)" }}>
                just now
              </text>
            </svg>
          </div>

          <div data-anim="fade" style={{ "--d": "0.1s" } as React.CSSProperties} className="relative bg-background-100 p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <p className="font-mono text-label-12 uppercase text-gray-700">Session duration</p>
              <p className="flex items-center gap-3 font-mono text-label-12 text-gray-900">
                {CHIPS.map((c) => (
                  <span key={c.label} className="flex items-center gap-1.5 whitespace-nowrap">
                    <span aria-hidden className={cn("h-1.5 w-1.5 rounded-full", c.dot)} />
                    <span className="text-gray-700">{c.label}</span>
                    <span className="tabular-nums text-gray-1000">{fmtS(c.value)}</span>
                  </span>
                ))}
              </p>
            </div>
            <p className="mt-0.5 font-mono text-heading-20 tabular-nums text-gray-1000">
              {fmtS(MAXD)}
              <span className="ml-1.5 font-mono text-label-12 uppercase text-gray-600">peak</span>
            </p>
            <div className="relative mt-1">
              <svg
                viewBox={`0 0 ${DW} ${DH}`}
                className="h-auto w-full"
                onPointerMove={onChartMove}
                onPointerLeave={() => setTip(null)}
              >
                <line
                  x1={DPX}
                  x2={DW - DPX}
                  y1={P95Y}
                  y2={P95Y}
                  stroke="var(--ds-warn)"
                  strokeWidth="1"
                  strokeDasharray="2 4"
                  opacity="0.6"
                />
                <text x={DW - DPX} y={P95Y - 4} textAnchor="end" className="fill-gray-600" style={{ font: "10px var(--font-mono)" }}>
                  p95
                </text>
                <path d={AREA} fill="url(#mon-area)" data-anim="fade" style={{ "--d": "0.9s" } as React.CSSProperties} />
                <path
                  d={LINE}
                  pathLength={1}
                  className={cn(armed && "beam-draw")}
                  style={{ "--beam-delay": "0.35s" } as React.CSSProperties}
                  stroke="var(--ds-blue-700)"
                  strokeWidth="1.25"
                  fill="none"
                  strokeLinejoin="round"
                />
                <circle
                  cx={SPIKE.x}
                  cy={SPIKE.y}
                  r="2.5"
                  fill="var(--ds-warn)"
                  data-anim="pop"
                  style={{ "--d": "1.3s" } as React.CSSProperties}
                />
                {tip !== null ? (
                  <g>
                    <line x1={PTS[tip].x} x2={PTS[tip].x} y1={8} y2={DH - 8} stroke="var(--ds-border-strong)" strokeDasharray="2 3" />
                    <circle cx={PTS[tip].x} cy={PTS[tip].y} r="2.5" fill="var(--ds-blue-700)" />
                  </g>
                ) : null}
                <defs>
                  <linearGradient id="mon-area" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--ds-blue-700)" stopOpacity="0.14" />
                    <stop offset="100%" stopColor="var(--ds-blue-700)" stopOpacity="0" />
                  </linearGradient>
                </defs>
              </svg>
              {tip !== null ? (
                <div
                  className="pointer-events-none absolute z-10 -translate-x-1/2 whitespace-nowrap rounded-md border border-border-default bg-background-200 px-2.5 py-1.5 font-mono text-label-12 shadow-lg"
                  style={{
                    left: `${(PTS[tip].x / DW) * 100}%`,
                    top: `${Math.max(2, (PTS[tip].y / DH) * 100 - 20)}%`,
                  }}
                >
                  <span className="tabular-nums text-gray-1000">{fmtS(PTS[tip].s.durationS)}</span>{" "}
                  <span className="text-gray-700">
                    · {PTS[tip].s.title.length > 24 ? `${PTS[tip].s.title.slice(0, 24)}…` : PTS[tip].s.title}
                  </span>
                </div>
              ) : null}
            </div>
          </div>
        </div>

        {/* search */}
        <div data-anim="fade" style={{ "--d": "0.2s" } as React.CSSProperties} className="border-b border-border-subtle bg-background-100 px-4 py-3">
          <div aria-hidden className="flex items-center gap-2.5 rounded-md border border-border-subtle px-3 py-1.5">
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 text-gray-600" fill="none" stroke="currentColor" strokeWidth="1.3">
              <circle cx="7" cy="7" r="4.5" />
              <path d="M10.5 10.5L14 14" />
            </svg>
            <span className="text-copy-14 text-gray-600">Search sessions…</span>
            <span className="ml-auto rounded border border-border-subtle px-1.5 font-mono text-label-12 text-gray-600">/</span>
          </div>
        </div>

        {/* sessions table */}
        <div className="bg-background-100">
          <div className="grid grid-cols-[minmax(0,1fr)_100px_72px_64px] items-center gap-x-4 border-b border-border-subtle px-4 py-2.5 md:grid-cols-[minmax(0,1fr)_100px_72px_64px_24px]">
            <p className="font-mono text-label-12 uppercase text-gray-700">Session</p>
            <p className="text-right font-mono text-label-12 uppercase text-gray-700">Tokens</p>
            <p className="text-right font-mono text-label-12 uppercase text-gray-700">Duration</p>
            <p className="text-right font-mono text-label-12 uppercase text-gray-700">Cost</p>
            <span className="hidden md:block" />
          </div>
          {ROWS.map((s, i) => (
            <div
              key={s.id}
              data-anim="fade"
              style={{ "--d": `${0.3 + i * 0.08}s` } as React.CSSProperties}
              className="grid grid-cols-[minmax(0,1fr)_100px_72px_64px] items-center gap-x-4 border-b border-border-subtle px-4 py-2.5 transition-colors hover:bg-gray-100/40 md:grid-cols-[minmax(0,1fr)_100px_72px_64px_24px]"
            >
              <p className="flex min-w-0 items-center gap-2.5">
                <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-ok" />
                <span className="truncate text-copy-14 text-gray-1000">{s.title}</span>
              </p>
              <p className="text-right font-mono text-mono-13 tabular-nums text-gray-900">
                {fmtInt(s.tokensIn + s.tokensOut)}
              </p>
              <p className="text-right font-mono text-mono-13 tabular-nums text-gray-900">{fmtS(s.durationS)}</p>
              <p className="text-right font-mono text-mono-13 tabular-nums text-gray-900">
                {s.cost === 0 ? "$0.00" : `$${s.cost.toFixed(4)}`}
              </p>
              <svg viewBox="0 0 8 12" className="hidden h-3 w-2 justify-self-end text-gray-600 md:block" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
                <path d="M1.5 1.5L6.5 6L1.5 10.5" />
              </svg>
            </div>
          ))}
          <div className="flex items-center justify-between px-4 py-2.5">
            <span className="inline-flex items-center gap-1.5 font-mono text-label-12 text-gray-700">
              Show 10
              <svg viewBox="0 0 8 6" className="h-1.5 w-2 text-gray-600" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden>
                <path d="M1 1.5L4 4.5L7 1.5" />
              </svg>
            </span>
            <span className="flex items-center gap-3 font-mono text-label-12 text-gray-700">
              1 of 1
              <span className="flex gap-1" aria-hidden>
                <span className="flex h-5 w-5 items-center justify-center rounded border border-border-subtle text-gray-600">‹</span>
                <span className="flex h-5 w-5 items-center justify-center rounded border border-border-subtle text-gray-600">›</span>
              </span>
            </span>
          </div>
        </div>
      </div>

      <p className="sr-only">
        evestack observability: 8 runs in the last 12 hours, 0 errors. Median session
        duration {fmtS(pctl(50))}, p95 {fmtS(pctl(95))}, peak {fmtS(MAXD)} (the 1500-word
        essay session). Span tree: {observability.spanTree.map((sp) => sp.name).join(" → ")}.
      </p>
    </div>
  );
}
