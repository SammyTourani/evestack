"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import {
  baseSessions,
  baseStats,
  liveSessions,
  type DemoSession,
  type SessionStatus,
} from "@/lib/demo-data";

/* Faux evestack dashboard for the "one command" section. SSR renders the
   SETTLED final state (no-JS / reduced-motion truth); with motion allowed it
   resets on mount and plays a hard-capped 3-cycle "live product" loop on
   first scroll-into-view (WCAG 2.2.2 — no infinite motion). Plain rAF state
   machine, zero animation deps. Loop pauses while hovered. */

const ROW_GRID =
  "grid grid-cols-[minmax(0,1fr)_88px_44px_136px_60px_64px_72px_64px] items-center gap-x-3 px-4";
const NUM_CELL = "text-right font-mono text-mono-13 tabular-nums";
const TABS = ["Sessions", "Chat", "Integrations"] as const;
type Tab = (typeof TABS)[number];

const INTEGRATIONS = [
  { name: "GitHub", detail: "evestack · webhooks + checks" },
  { name: "OpenAI", detail: "openai/gpt-5-mini · key sk-…4f2a" },
  { name: "Slack", detail: "#agent-runs · notifications" },
];

type LiveState = {
  index: number;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  status: SessionStatus;
  flash: boolean;
  shown: boolean;
};

const lastLive = liveSessions[liveSessions.length - 1];
const settledLive: LiveState = {
  index: liveSessions.length - 1,
  tokensIn: lastLive.tokensIn,
  tokensOut: lastLive.tokensOut,
  cost: lastLive.cost,
  status: "completed",
  flash: false,
  shown: true,
};

const fmtInt = (n: number) => n.toLocaleString("en-US");
const fmtTokens = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}K` : fmtInt(n));
const fmtCost = (n: number) => (n === 0 ? "$0.00" : `$${n.toFixed(4)}`);

function Tile({ label, value, ok }: { label: string; value: string; ok?: boolean }) {
  return (
    <div className="bg-background-100 p-4">
      <p className="font-mono text-label-12 uppercase text-gray-700">{label}</p>
      <p className={cn("mt-1 font-mono text-heading-24 tabular-nums", ok ? "text-ok" : "text-gray-1000")}>
        {value}
      </p>
    </div>
  );
}

function StatusPill({ status }: { status: SessionStatus }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded-full border px-2 font-mono text-label-12",
        status === "running" ? "border-blue-700/40 text-blue-700" : "border-ok/40 text-ok",
      )}
    >
      {status}
    </span>
  );
}

function SessionRow({
  s,
  shown,
  flash,
  expanded,
  onToggle,
  panelId,
}: {
  s: DemoSession;
  shown: boolean;
  flash: boolean;
  expanded: boolean;
  onToggle: () => void;
  panelId: string;
}) {
  return (
    <div className="border-t border-border-subtle">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={panelId}
        tabIndex={shown ? 0 : -1}
        onClick={onToggle}
        className={cn(
          ROW_GRID,
          "h-10 w-full text-left transition-[background-color,opacity,transform] duration-300 hover:bg-gray-100 motion-reduce:transition-none",
          shown ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0",
          flash && "bg-gray-100",
        )}
      >
        <span className="truncate text-copy-14 text-gray-1000">{s.title}</span>
        <StatusPill status={s.status} />
        <span className={cn(NUM_CELL, "text-gray-900")}>{s.turns}</span>
        <span className="truncate font-mono text-mono-13 text-gray-700">{s.model}</span>
        <span className={cn(NUM_CELL, "text-gray-900")}>{fmtInt(s.tokensIn)}</span>
        <span className={cn(NUM_CELL, "text-gray-900")}>{fmtInt(s.tokensOut)}</span>
        <span className={cn(NUM_CELL, "text-gray-900")}>{fmtCost(s.cost)}</span>
        <span className="text-right font-mono text-mono-13 text-gray-700">{s.started}</span>
      </button>
      <div
        id={panelId}
        aria-hidden={!expanded}
        className={cn(
          "grid transition-[grid-template-rows] duration-300 motion-reduce:transition-none",
          expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="flex flex-col gap-1 border-t border-border-subtle bg-background-200 px-4 py-3 font-mono text-mono-13">
            <p className="text-gray-700">{s.id}</p>
            {Array.from({ length: s.turns }, (_, i) => (
              <p key={i} className="text-gray-900">
                <span className="text-gray-600">#{i + 1} TURN</span>{" "}
                <span className={s.status === "running" ? "text-blue-700" : "text-ok"}>
                  [{s.status}]
                </span>{" "}
                {s.model}
              </p>
            ))}
            <p className="tabular-nums text-gray-700">
              DURATION {s.durationS.toFixed(1)}s · IN {fmtInt(s.tokensIn)} · OUT{" "}
              {fmtInt(s.tokensOut)} · CACHED {fmtInt(s.cached)} · TOOLS {s.tools} · COST{" "}
              {fmtCost(s.cost)}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

export function DashboardDemo() {
  const uid = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(false);
  const stopRef = useRef(false);
  const rafRef = useRef(0);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [tab, setTab] = useState<Tab>("Sessions");
  const [revealed, setRevealed] = useState(baseSessions.length);
  const [live, setLive] = useState<LiveState | null>(settledLive);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    stopRef.current = false;

    /* Pause-aware timer: `ms` only elapses while the demo is not hovered. */
    const timer = (ms: number, onFrame: ((t: number) => void) | null, onDone: () => void) => {
      let last = performance.now();
      let elapsed = 0;
      const step = (now: number) => {
        if (stopRef.current) return;
        if (!pausedRef.current) elapsed += now - last;
        last = now;
        const t = Math.min(elapsed / ms, 1);
        onFrame?.(t);
        if (t < 1) rafRef.current = requestAnimationFrame(step);
        else onDone();
      };
      rafRef.current = requestAnimationFrame(step);
    };

    const cycle = (k: number) => {
      const target = liveSessions[k];
      const count = () =>
        timer(
          2500,
          (t) => {
            const e = 1 - Math.pow(1 - t, 3); // cubic out
            setLive((l) => l && {
              ...l,
              tokensIn: Math.round(target.tokensIn * e),
              tokensOut: Math.round(target.tokensOut * e),
              cost: target.cost * e,
            });
          },
          () => {
            setLive((l) => l && { ...l, status: "completed", flash: true });
            timer(300, null, () => {
              setLive((l) => l && { ...l, flash: false });
              if (k + 1 >= liveSessions.length) return; // hard cap: settle forever
              timer(2500, null, () => {
                setLive((l) => l && { ...l, shown: false });
                timer(240, null, () => cycle(k + 1));
              });
            });
          },
        );
      setLive({ index: k, tokensIn: 0, tokensOut: 0, cost: 0, status: "running", flash: false, shown: false });
      timer(50, null, () => {
        setLive((l) => l && { ...l, shown: true }); // slide in at the top
        timer(350, null, count);
      });
    };

    const play = () => {
      let n = 0;
      const next = () => {
        setRevealed(++n);
        if (n < baseSessions.length) timer(90, null, next);
        else timer(700, null, () => cycle(0));
      };
      next();
    };

    setRevealed(0); // reset the SSR'd settled state, then stream in
    setLive(null);
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        io.disconnect();
        timer(150, null, play);
      },
      { threshold: 0.35 },
    );
    io.observe(root);
    return () => {
      stopRef.current = true;
      io.disconnect();
      cancelAnimationFrame(rafRef.current);
    };
  }, []);

  /* Tiles = base rollup + fully-folded prior cycles + the ticking live row. */
  const stats = useMemo(() => {
    const s = { ...baseStats };
    if (live) {
      for (let i = 0; i < live.index; i++) {
        const p = liveSessions[i];
        s.turns += p.turns;
        s.tokensIn += p.tokensIn;
        s.tokensOut += p.tokensOut;
        s.spend += p.cost;
      }
      s.sessions += live.index + 1;
      s.turns += liveSessions[live.index].turns;
      s.tokensIn += live.tokensIn;
      s.tokensOut += live.tokensOut;
      s.spend += live.cost;
    }
    return s;
  }, [live]);

  const liveRow: DemoSession | null = live
    ? {
        ...liveSessions[live.index],
        status: live.status,
        tokensIn: live.tokensIn,
        tokensOut: live.tokensOut,
        cost: live.cost,
      }
    : null;
  const toggle = (id: string) => setExpanded((cur) => (cur === id ? null : id));

  return (
    <div
      ref={rootRef}
      onMouseEnter={() => (pausedRef.current = true)}
      onMouseLeave={() => (pausedRef.current = false)}
      className="overflow-hidden rounded-xl border border-border-default bg-background-200"
    >
      <div className="flex h-11 items-center gap-4 border-b border-border-subtle px-4">
        <p className="flex shrink-0 items-center gap-2 font-mono text-mono-13 text-gray-1000">
          <span aria-hidden className="text-blue-700">▚</span>
          evestack
        </p>
        <div role="tablist" aria-label="Dashboard views" className="flex h-full items-center">
          {TABS.map((t, i) => (
            <button
              key={t}
              ref={(el) => {
                tabRefs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`${uid}-tab-${t}`}
              aria-selected={tab === t}
              aria-controls={`${uid}-panel-${t}`}
              tabIndex={tab === t ? 0 : -1}
              onClick={() => setTab(t)}
              onKeyDown={(e) => {
                if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
                e.preventDefault();
                const j = (i + (e.key === "ArrowRight" ? 1 : -1) + TABS.length) % TABS.length;
                setTab(TABS[j]);
                tabRefs.current[j]?.focus();
              }}
              className={cn(
                "flex h-full items-center border-b-2 px-2 text-copy-14 transition-colors",
                tab === t
                  ? "border-gray-1000 text-gray-1000"
                  : "border-transparent text-gray-700 hover:text-gray-900",
              )}
            >
              {t}
            </button>
          ))}
        </div>
        <span className="ml-auto hidden shrink-0 items-center rounded-full border border-ok/40 px-2 py-0.5 font-mono text-label-12 text-ok sm:inline-flex">
          self-hosted
        </span>
      </div>

      <div role="tabpanel" id={`${uid}-panel-Sessions`} aria-labelledby={`${uid}-tab-Sessions`} hidden={tab !== "Sessions"}>
        <div tabIndex={0} role="region" aria-label="Demo dashboard sessions" className="overflow-x-auto">
          <div className="min-w-[760px] bg-background-100">
            <div className="grid grid-cols-5 gap-px border-b border-border-subtle bg-border-subtle">
              <Tile label="Sessions" value={fmtInt(stats.sessions)} />
              <Tile label="Turns" value={fmtInt(stats.turns)} />
              <Tile label="Tokens in/out" value={`${fmtTokens(stats.tokensIn)}/${fmtTokens(stats.tokensOut)}`} />
              <Tile label="Model spend" value={`$${stats.spend.toFixed(2)}`} />
              <Tile label="Infrastructure" value="$0.00" ok />
            </div>
            <div className={cn(ROW_GRID, "h-9 font-mono text-label-12 uppercase text-gray-700")}>
              <span>Session</span>
              <span>Status</span>
              <span className="text-right">Turns</span>
              <span>Model</span>
              <span className="text-right">In</span>
              <span className="text-right">Out</span>
              <span className="text-right">Cost</span>
              <span className="text-right">Started</span>
            </div>
            {liveRow && live ? (
              /* grid-rows trick so arriving/leaving pushes the table smoothly */
              <div
                className={cn(
                  "grid transition-[grid-template-rows] duration-300 motion-reduce:transition-none",
                  live.shown ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
                )}
              >
                <div className="min-h-0 overflow-hidden">
                  <SessionRow
                    s={liveRow}
                    shown={live.shown}
                    flash={live.flash}
                    expanded={expanded === liveRow.id}
                    onToggle={() => toggle(liveRow.id)}
                    panelId={`${uid}-row-live`}
                  />
                </div>
              </div>
            ) : null}
            {baseSessions.map((s, i) => (
              <SessionRow
                key={s.id}
                s={s}
                shown={i < revealed}
                flash={false}
                expanded={expanded === s.id}
                onToggle={() => toggle(s.id)}
                panelId={`${uid}-row-${i}`}
              />
            ))}
          </div>
        </div>
      </div>

      <div role="tabpanel" id={`${uid}-panel-Chat`} aria-labelledby={`${uid}-tab-Chat`} tabIndex={0} hidden={tab !== "Chat"}>
        <div className="flex min-h-[280px] flex-col justify-end gap-3 p-4">
          <p className="ml-auto max-w-[75%] rounded-lg rounded-br-sm bg-gray-100 px-3 py-2 text-copy-14 text-gray-1000">
            Which sessions failed in the last hour?
          </p>
          <p className="mr-auto max-w-[75%] rounded-lg rounded-bl-sm border border-border-subtle bg-background-100 px-3 py-2 text-copy-14 text-gray-900">
            None — every session completed cleanly. The longest ran 41.0s with 13 tool calls.
          </p>
          <p aria-hidden className="mt-2 flex items-center justify-between rounded-lg border border-border-default bg-background-100 px-3 py-2.5">
            <span className="text-copy-14 text-gray-600">Message your agent…</span>
            <span className="rounded border border-border-subtle px-1.5 font-mono text-label-12 text-gray-600">⏎</span>
          </p>
        </div>
      </div>

      <div role="tabpanel" id={`${uid}-panel-Integrations`} aria-labelledby={`${uid}-tab-Integrations`} tabIndex={0} hidden={tab !== "Integrations"}>
        <div className="flex min-h-[280px] flex-col gap-2 p-4">
          {INTEGRATIONS.map(({ name, detail }) => (
            <div key={name} className="flex items-center justify-between gap-3 rounded-lg border border-border-subtle bg-background-100 px-4 py-3">
              <div className="min-w-0">
                <p className="text-copy-14 text-gray-1000">{name}</p>
                <p className="truncate font-mono text-mono-13 text-gray-700">{detail}</p>
              </div>
              <span className="flex shrink-0 items-center gap-2 font-mono text-label-12 text-ok">
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-ok" />
                connected
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default DashboardDemo;
