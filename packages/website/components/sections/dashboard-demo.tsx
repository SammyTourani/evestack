"use client";

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import {
  baseSessions,
  baseStats,
  liveSessions,
  type DemoSession,
  type SessionStatus,
} from "@/lib/demo-data";

/* Faux evestack dashboard for the "one command" section. SSR renders the
   SETTLED final state of every tab (no-JS / reduced-motion truth); with
   motion allowed it becomes a self-driving product tour:
   - Sessions: rows stream in once; the three live rows are PERMANENT table
     members that convert IN PLACE — staggered flips to "running", each
     ticking on its own clock (2–3 running at once), completions landing at
     different moments, settle, replay. The table never changes size.
   - Chat: a real back-and-forth plays out — user asks, the agent THINKS
     (blue pulse), then streams its answer word by word. Every number in the
     script traces to lib/demo-data.ts.
   - Integrations: GitHub / OpenAI / Slack visibly connect, one by one.
   Tabs auto-rotate on a dwell timer until the user clicks one (then the
   tour stops driving forever). Panel heights GLIDE between tabs — no layout
   jumps into the copy beside the demo. Hover pauses everything. */

const ROW_GRID =
  "grid grid-cols-[minmax(0,1fr)_88px_44px_136px_60px_64px_72px_64px] items-center gap-x-3 px-4";
const NUM_CELL = "text-right font-mono text-mono-13 tabular-nums";
/* CHAT FIRST (2026-08-11, Sammy's call). The panel opened on Sessions, which
   is a table: correct, dense, and the least legible way to answer "what is
   this thing?" for someone meeting it for the first time. Chat is a
   conversation with an agent, which is the product in one glance, so it opens
   the section and the scripted exchange is the first motion a visitor sees.

   Order is the tab order AND the rotation order, since both read from TABS. */
const TABS = ["Chat", "Sessions", "Integrations"] as const;
type Tab = (typeof TABS)[number];

const INTEGRATIONS = [
  { name: "GitHub", slug: "github", detail: "evestack · webhooks + checks" },
  { name: "OpenAI", slug: "openai", detail: "openai/gpt-5-mini · key sk-…4f2a" },
  { name: "Slack", slug: "slack", detail: "#agent-runs · notifications" },
] as const;

/* Facts: 41.0s/13 tools = baseSessions[0]; deploy email 3 turns/5 tools/
   18.2s/$0.0034 = liveSessions[0]. */
const CHAT = [
  { role: "user" as const, text: "Which sessions failed in the last hour?" },
  {
    role: "assistant" as const,
    text: "None. Every session completed cleanly. The longest ran 41.0s with 13 tool calls.",
  },
  { role: "user" as const, text: "What did the deploy email session cost?" },
  {
    role: "assistant" as const,
    text: "Deploy summary email ran 3 turns with 5 tool calls in 18.2s, costing $0.0034 in model spend. Infrastructure: $0.00.",
  },
];
const CHAT_WORDS = CHAT.map((m) => m.text.split(" "));

type LiveRow = {
  /** DISPLAY values — a pre-flip row keeps showing its last run's totals */
  tokensIn: number;
  tokensOut: number;
  cost: number;
  status: SessionStatus;
  flash: boolean;
  /** false until the row flips in the current pass: the tiles exclude it
      so they can re-earn its numbers monotonically as it ticks back up */
  counted: boolean;
};

/* Schedule for one live pass, ms from pass start — one entry per
   liveSessions row. The SAME three rows convert in place: flips stagger
   ~0.9s apart and the count-up durations deliberately differ so the
   ticking never looks synchronized; at peak all three are "running" at
   once and the completions land at three different moments. */
const LIVE_PLAN = [
  { at: 0, count: 2600 },
  { at: 900, count: 3800 },
  { at: 1800, count: 4600 },
];
const HOLD_MS = 350; // flip beat: the numbers sit at 0 before ticking starts
const FLASH_MS = 300; // row highlight at flip-to-running AND at completion
const LIVE_N = Math.min(LIVE_PLAN.length, liveSessions.length);
/* a pass is "active" until the last row's completion flash fades */
const PASS_ACTIVE =
  Math.max(...LIVE_PLAN.slice(0, LIVE_N).map((p) => p.at + HOLD_MS + p.count)) + FLASH_MS;

/* Settled feed = SSR / reduced-motion truth: every live row completed at
   full values. rowsAt(PASS_ACTIVE) lands on exactly this frame, so the
   settle never jumps — and between passes the table IS this frame. */
const settledRows: LiveRow[] = liveSessions.slice(0, LIVE_N).map(
  (s): LiveRow => ({
    tokensIn: s.tokensIn,
    tokensOut: s.tokensOut,
    cost: s.cost,
    status: "completed",
    flash: false,
    counted: true,
  }),
);

/* The whole feed as a pure function of the pass clock — one elapsed time in,
   every row's flip/count-up/completion out. Freezing the clock (hover, or
   the demo scrolled off screen) therefore freezes ALL ticking at once. */
const rowsAt = (now: number): LiveRow[] =>
  liveSessions.slice(0, LIVE_N).map((src, i): LiveRow => {
    const p = LIVE_PLAN[i];
    if (now < p.at) return settledRows[i]; // still showing its last run
    const t = Math.min(Math.max((now - p.at - HOLD_MS) / p.count, 0), 1);
    const e = 1 - Math.pow(1 - t, 3); // cubic out, on this row's own clock
    return {
      tokensIn: Math.round(src.tokensIn * e),
      tokensOut: Math.round(src.tokensOut * e),
      cost: src.cost * e,
      status: t >= 1 ? "completed" : "running",
      flash:
        now < p.at + FLASH_MS || // the flip beat: "a new run just started"
        (t >= 1 && now < p.at + HOLD_MS + p.count + FLASH_MS),
      counted: true,
    };
  });

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

/* Rows are ALWAYS painted. There used to be a `shown` prop that faded them in
   one at a time; because a row keeps its height and border while hidden, a
   visitor scrolling past saw a table of empty ruled lines. The live loop
   converts these rows in place, which is motion enough — the data itself must
   never be something you wait for. */
function SessionRow({
  s,
  flash,
  expanded,
  onToggle,
  panelId,
}: {
  s: DemoSession;
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
        onClick={onToggle}
        className={cn(
          ROW_GRID,
          "h-10 w-full text-left transition-colors duration-300 hover:bg-gray-100 motion-reduce:transition-none",
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

function ChatBubble({ role, children }: { role: "user" | "assistant"; children: React.ReactNode }) {
  return role === "user" ? (
    <p className="ml-auto max-w-[75%] rounded-lg rounded-br-sm bg-gray-100 px-3 py-2 text-copy-14 text-gray-1000">
      {children}
    </p>
  ) : (
    <div className="mr-auto flex max-w-[80%] items-start gap-2.5">
      <span
        aria-hidden
        className="mt-1.5 shrink-0 font-mono text-copy-14 leading-none text-blue-700"
      >
        ▚
      </span>
      <p className="rounded-lg rounded-bl-sm border border-border-subtle bg-background-100 px-3 py-2 text-copy-14 text-gray-900">
        {children}
      </p>
    </div>
  );
}

export function DashboardDemo() {
  const uid = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(false);
  const stopRef = useRef(false);
  const rafRef = useRef(0);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const panelRefs = useRef<Partial<Record<Tab, HTMLDivElement | null>>>({});
  const tabRef = useRef<Tab>("Sessions");
  const autoOffRef = useRef(false); // user clicked a tab → the tour stops driving
  const inViewRef = useRef(false);
  /* Distinct from inViewRef, and needed because that one is a ref: React does
     not re-run an effect when a ref flips. This is the "has this panel ever
     been on screen" latch that the Chat script waits on.

     It exists because Chat became the DEFAULT tab. Its script used to run only
     when you clicked or rotated onto Chat, by which point you were certainly
     looking at it. As the opening tab it would instead start at page load,
     play through while the section sat several screens below the fold, and be
     sitting on its settled final state by the time anyone scrolled down. The
     first thing a visitor sees would be the end of a conversation. */
  const [everSeen, setEverSeen] = useState(false);
  const [reduced, setReduced] = useState(false);
  const [tab, setTab] = useState<Tab>("Chat");
  const [indicator, setIndicator] = useState<{ x: number; w: number } | null>(null);
  const [panelH, setPanelH] = useState<number | null>(null);
  const [rows, setRows] = useState<LiveRow[]>(settledRows);
  const [expanded, setExpanded] = useState<string | null>(null);
  /* chat: shown = fully rendered messages; streamWords > 0 = message
     CHAT[shown] is streaming. Settled (SSR) = everything visible. */
  const [chat, setChat] = useState({ shown: CHAT.length, thinking: false, streamWords: 0 });
  /* integrations: 0 = pending, 1 = connecting, 2 = connected (SSR: all 2) */
  const [conn, setConn] = useState<number[]>([2, 2, 2]);

  useEffect(() => {
    tabRef.current = tab;
  }, [tab]);
  useEffect(() => {
    setReduced(window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }, []);

  /* Timer factory. pauseAware timers only elapse while the demo is not
     hovered — right for the sessions loop and the tab-rotation dwell.
     The chat/integrations activation scripts must NOT be pause-aware:
     the user's cursor is inside the window the moment they click a tab,
     and a hover-frozen script leaves the panel blank (observed bug). */
  const makeTimer =
    (stopped: { v: boolean }, rafBox: { id: number }, pauseAware = true) =>
    (ms: number, onFrame: ((t: number) => void) | null, onDone: () => void) => {
      let last = performance.now();
      let elapsed = 0;
      const step = (now: number) => {
        if (stopped.v) return;
        if (!pauseAware || !pausedRef.current) elapsed += now - last;
        last = now;
        const t = Math.min(elapsed / ms, 1);
        onFrame?.(t);
        if (t < 1) rafBox.id = requestAnimationFrame(step);
        else onDone();
      };
      rafBox.id = requestAnimationFrame(step);
    };

  /* ── Sessions live loop: ENDLESS passes over the SAME three rows. Each
     pass converts them in place — staggered flips to "running" (numbers
     reset behind a flash beat), concurrent count-ups on their own clocks,
     completions at their own moments — then settles and replays. The table
     never grows or shrinks. Time only elapses while the demo is on screen
     AND unhovered — scroll away and it waits; scroll back and it is always
     moving. ── */
  useEffect(() => {
    const root = rootRef.current;
    if (!root || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    stopRef.current = false;

    const FIRST_TOTAL = 700 + PASS_ACTIVE;
    const prog = { elapsed: 0, total: FIRST_TOTAL };

    const timer = (ms: number, onFrame: ((t: number) => void) | null, onDone: () => void) => {
      let last = performance.now();
      let elapsed = 0;
      const step = (now: number) => {
        if (stopRef.current) return;
        if (!pausedRef.current && inViewRef.current) {
          const d = now - last;
          elapsed += d;
          prog.elapsed += d;
          const bar = barRef.current;
          if (bar) bar.style.transform = `scaleX(${Math.min(prog.elapsed / prog.total, 1)})`;
        }
        last = now;
        const t = Math.min(elapsed / ms, 1);
        onFrame?.(t);
        if (t < 1) rafRef.current = requestAnimationFrame(step);
        else onDone();
      };
      rafRef.current = requestAnimationFrame(step);
    };

    /* ONE clock drives a whole pass: rowsAt() derives every row's state
       from the same elapsed time, so overlapping lifecycles can never
       drift and the progress hairline never double-counts. */
    const pass = () => {
      timer(
        PASS_ACTIVE,
        (t) => setRows(rowsAt(t * PASS_ACTIVE)),
        () => {
          // pass complete: the feed now equals the settled/SSR frame.
          // Breathe, then the SAME rows flip back to running one by one —
          // the demo is ALWAYS alive whenever it's on screen, and the
          // table never changes size.
          const bar = barRef.current;
          if (bar) {
            bar.style.transform = "scaleX(1)";
            bar.style.opacity = "0";
          }
          timer(5000, null, () => {
            prog.elapsed = 0;
            prog.total = PASS_ACTIVE;
            if (bar) {
              bar.style.transform = "scaleX(0)";
              bar.style.opacity = "1";
            }
            pass();
          });
        },
      );
    };

    /* The table is fully painted from SSR and stays that way. This only waits
       a beat before the live loop starts converting rows in place.

       The threshold is deliberately low. It used to be 0.35, and `timer` only
       advances while inViewRef is true (0.3) — so while the panel was entering
       the viewport, neither fired, the staggered reveal stalled part-way, and
       the table sat there as a set of empty ruled lines. Nothing about the
       DATA depends on this observer any more, but the same trap would stall
       the animation, so keep both thresholds small: `threshold` is a fraction
       of the ELEMENT, and this panel can be taller than the viewport. */
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        io.disconnect();
        if (barRef.current) barRef.current.style.opacity = "1";
        timer(700, null, pass);
      },
      { threshold: 0.1 },
    );
    io.observe(root);
    return () => {
      stopRef.current = true;
      io.disconnect();
      cancelAnimationFrame(rafRef.current);
    };
  }, []);

  /* ── Auto-rotate the tabs until the user takes over ──────────────── */
  useEffect(() => {
    if (reduced) return;
    const root = rootRef.current;
    if (!root) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        inViewRef.current = entry.isIntersecting;
        if (entry.isIntersecting) setEverSeen(true);
      },
      /* Small on purpose: a fraction of the ELEMENT, which is often taller
         than the viewport. At 0.3 the demo's clocks stayed frozen while it
         was scrolling into view. */
      { threshold: 0.1 },
    );
    io.observe(root);
    const stopped = { v: false };
    const rafBox = { id: 0 };
    const timer = makeTimer(stopped, rafBox);
    const wait = (ms: number) => new Promise<void>((res) => timer(ms, null, res));
    /* Chat leads, so it also needs the longest dwell: its script has to finish
       playing before the rotation moves on, or the first thing a visitor sees
       is a conversation cut off mid-sentence. */
    const DWELL: Record<Tab, number> = { Chat: 15000, Sessions: 12000, Integrations: 9000 };

    (async () => {
      await wait(2500); // let the sessions stream get going first
      while (!stopped.v && !autoOffRef.current) {
        let t = 0;
        const dwell = DWELL[tabRef.current];
        while (!stopped.v && t < dwell) {
          await wait(250);
          if (autoOffRef.current) return;
          if (inViewRef.current) t += 250; // dwell only counts while watched
        }
        if (stopped.v || autoOffRef.current) return;
        setTab(TABS[(TABS.indexOf(tabRef.current) + 1) % TABS.length]);
      }
    })();
    return () => {
      stopped.v = true;
      io.disconnect();
      cancelAnimationFrame(rafBox.id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduced]);

  /* ── Chat: play the conversation on every activation. useLayoutEffect:
     the reset must land BEFORE paint, or the settled conversation flashes
     for one frame when the tab opens (user-reported on Integrations). ── */
  useLayoutEffect(() => {
    if (reduced || tab !== "Chat" || !everSeen) return;
    const stopped = { v: false };
    const rafBox = { id: 0 };
    const timer = makeTimer(stopped, rafBox, false); // never hover-frozen
    const wait = (ms: number) => new Promise<void>((res) => timer(ms, null, res));
    const stream = (idx: number) =>
      new Promise<void>((res) => {
        const words = CHAT_WORDS[idx].length;
        setChat({ shown: idx, thinking: false, streamWords: 1 });
        timer(
          words * 68,
          (t) => setChat((c) => ({ ...c, streamWords: Math.max(1, Math.ceil(t * words)) })),
          () => {
            setChat({ shown: idx + 1, thinking: false, streamWords: 0 });
            res();
          },
        );
      });

    (async () => {
      // open with the first question already on screen — never a blank panel
      setChat({ shown: 1, thinking: false, streamWords: 0 });
      await wait(650);
      setChat((c) => ({ ...c, thinking: true })); // the agent thinks (blue)
      await wait(1700);
      await stream(1);
      await wait(1200);
      setChat({ shown: 3, thinking: false, streamWords: 0 }); // second question
      await wait(600);
      setChat((c) => ({ ...c, thinking: true }));
      await wait(1400);
      await stream(3);
    })();
    return () => {
      stopped.v = true;
      cancelAnimationFrame(rafBox.id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, reduced, everSeen]);

  /* ── Integrations: connect live on every activation. useLayoutEffect —
     pre-paint reset, so the settled "connected" rows never flash. ── */
  useLayoutEffect(() => {
    if (reduced || tab !== "Integrations") return;
    const stopped = { v: false };
    const rafBox = { id: 0 };
    const timer = makeTimer(stopped, rafBox, false); // never hover-frozen
    const wait = (ms: number) => new Promise<void>((res) => timer(ms, null, res));
    const mark = (i: number, phase: number) =>
      setConn((c) => c.map((p, j) => (j === i ? phase : p)));

    (async () => {
      // first row starts connecting immediately — never a blank panel
      setConn([1, 0, 0]);
      await wait(800);
      mark(1, 1); // OpenAI connecting…
      await wait(400);
      mark(0, 2); // GitHub ✓
      await wait(500);
      mark(2, 1); // Slack connecting…
      await wait(500);
      mark(1, 2); // OpenAI ✓
      await wait(800);
      mark(2, 2); // Slack ✓
    })();
    return () => {
      stopped.v = true;
      cancelAnimationFrame(rafBox.id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, reduced]);

  /* ── Sliding tab indicator ───────────────────────────────────────── */
  useEffect(() => {
    const el = tabRefs.current[TABS.indexOf(tab)];
    if (!el) return;
    setIndicator({ x: el.offsetLeft, w: el.offsetWidth });
  }, [tab]);

  /* ── Panel height glide: the copy beside the demo never jumps ────── */
  useEffect(() => {
    const el = panelRefs.current[tab];
    if (!el) return;
    const measure = () => setPanelH(el.offsetHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [tab]);

  /* Tiles = base rollup + the permanent live rows. The session count never
     moves — no rows are ever added. Token/spend tiles follow each row's
     own count-up: a row's contribution resets only at the instant it flips
     (`counted` gates the pre-flip rows), so within a pass the totals only
     ever rise and every settle lands exactly on the SSR values. Turns fold
     in whole at the flip (a turn count isn't a ticking meter). */
  const stats = useMemo(() => {
    const s = { ...baseStats, sessions: baseStats.sessions + LIVE_N };
    rows.forEach((r, i) => {
      if (!r.counted) return;
      s.turns += liveSessions[i].turns;
      s.tokensIn += r.tokensIn;
      s.tokensOut += r.tokensOut;
      s.spend += r.cost;
    });
    return s;
  }, [rows]);

  const toggle = (id: string) => setExpanded((cur) => (cur === id ? null : id));
  const pickTab = (t: Tab) => {
    autoOffRef.current = true; // the user is driving now
    setTab(t);
  };

  return (
    <div
      ref={rootRef}
      onMouseEnter={() => (pausedRef.current = true)}
      onMouseLeave={() => (pausedRef.current = false)}
      className="relative overflow-hidden rounded-xl border border-border-default bg-background-200"
    >
      <div
        ref={barRef}
        aria-hidden
        className="demo-progress pointer-events-none absolute inset-x-0 top-0 z-10 h-px origin-left opacity-0"
        style={{ transform: "scaleX(0)" }}
      />
      <div className="flex h-11 items-center gap-4 border-b border-border-subtle px-4">
        <p className="flex shrink-0 items-center gap-2 font-mono text-mono-13 text-gray-1000">
          <span aria-hidden className="text-blue-700">▚</span>
          evestack
        </p>
        <div role="tablist" aria-label="Dashboard views" className="relative flex h-full items-center">
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
              onClick={() => pickTab(t)}
              onKeyDown={(e) => {
                if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
                e.preventDefault();
                const j = (i + (e.key === "ArrowRight" ? 1 : -1) + TABS.length) % TABS.length;
                pickTab(TABS[j]);
                tabRefs.current[j]?.focus();
              }}
              className={cn(
                "flex h-full items-center px-2 text-copy-14 transition-colors",
                tab === t ? "text-gray-1000" : "text-gray-700 hover:text-gray-900",
              )}
            >
              {t}
            </button>
          ))}
          {/* sliding underline */}
          <span
            aria-hidden
            className="absolute bottom-0 h-0.5 bg-gray-1000 transition-[transform,width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
            style={
              indicator
                ? { width: indicator.w, transform: `translateX(${indicator.x}px)` }
                : { width: 0 }
            }
          />
        </div>
        <span className="ml-auto hidden shrink-0 items-center rounded-full border border-ok/40 px-2 py-0.5 font-mono text-label-12 text-ok sm:inline-flex">
          self-hosted
        </span>
      </div>

      {/* height glides between panels — the section copy never jumps */}
      <div
        style={{ height: panelH ?? undefined }}
        className="overflow-hidden transition-[height] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
      >
        <div
          role="tabpanel"
          id={`${uid}-panel-Sessions`}
          aria-labelledby={`${uid}-tab-Sessions`}
          hidden={tab !== "Sessions"}
          ref={(el) => {
            panelRefs.current.Sessions = el;
          }}
        >
          <div data-panel-anim>
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
                {/* the three live rows are ordinary, permanent table rows —
                    passes only repaint their pill/numbers, never the layout */}
                {rows.map((r, i) => {
                  const src = liveSessions[i];
                  const s: DemoSession = {
                    ...src,
                    status: r.status,
                    tokensIn: r.tokensIn,
                    tokensOut: r.tokensOut,
                    cost: r.cost,
                  };
                  return (
                    <SessionRow
                      key={src.id}
                      s={s}
                      flash={r.flash}
                      expanded={expanded === src.id}
                      onToggle={() => toggle(src.id)}
                      panelId={`${uid}-row-live-${i}`}
                    />
                  );
                })}
                {baseSessions.map((s, i) => (
                  <SessionRow
                    key={s.id}
                    s={s}
                    flash={false}
                    expanded={expanded === s.id}
                    onToggle={() => toggle(s.id)}
                    panelId={`${uid}-row-${i}`}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>

        <div
          role="tabpanel"
          id={`${uid}-panel-Chat`}
          aria-labelledby={`${uid}-tab-Chat`}
          tabIndex={0}
          hidden={tab !== "Chat"}
          ref={(el) => {
            panelRefs.current.Chat = el;
          }}
        >
          <div data-panel-anim className="flex min-h-[300px] flex-col justify-end gap-3 p-4">
            {/* the streaming bubble IS the final bubble (same key) — it fills
                in place instead of being swapped out, so nothing jumps */}
            {CHAT.slice(0, chat.streamWords > 0 ? chat.shown + 1 : chat.shown).map((m, i) => {
              const streaming = chat.streamWords > 0 && i === chat.shown;
              return (
                <div key={i} className="chat-row">
                  <div>
                    <ChatBubble role={m.role}>
                      {streaming ? CHAT_WORDS[i].slice(0, chat.streamWords).join(" ") : m.text}
                      {streaming ? (
                        <span
                          aria-hidden
                          className="ml-0.5 inline-block h-[0.95em] w-[2px] translate-y-[0.15em] bg-blue-700"
                        />
                      ) : null}
                    </ChatBubble>
                  </div>
                </div>
              );
            })}
            {chat.thinking ? (
              <div className="chat-row" aria-hidden>
                <div>
                  <div className="mr-auto flex items-center gap-2.5">
                    <span className="mt-0.5 shrink-0 font-mono text-copy-14 leading-none text-blue-700">▚</span>
                    <span className="flex items-center gap-1.5 rounded-lg rounded-bl-sm border border-border-subtle bg-background-100 px-3 py-2.5">
                      {[0, 1, 2].map((d) => (
                        <span
                          key={d}
                          className="chat-dot h-1.5 w-1.5 rounded-full bg-blue-700 shadow-[0_0_6px_var(--ds-blue-700)]"
                          style={{ animationDelay: `${d * 0.18}s` }}
                        />
                      ))}
                    </span>
                  </div>
                </div>
              </div>
            ) : null}
            <p aria-hidden className="mt-2 flex items-center justify-between rounded-lg border border-border-default bg-background-100 px-3 py-2.5">
              <span className="text-copy-14 text-gray-600">Message your agent…</span>
              <span className="rounded border border-border-subtle px-1.5 font-mono text-label-12 text-gray-600">⏎</span>
            </p>
          </div>
        </div>

        <div
          role="tabpanel"
          id={`${uid}-panel-Integrations`}
          aria-labelledby={`${uid}-tab-Integrations`}
          tabIndex={0}
          hidden={tab !== "Integrations"}
          ref={(el) => {
            panelRefs.current.Integrations = el;
          }}
        >
          <div data-panel-anim className="flex min-h-[300px] flex-col justify-center gap-2 p-4">
            {INTEGRATIONS.map(({ name, slug, detail }, i) => {
              const phase = conn[i];
              return (
                <div
                  key={name}
                  className={cn(
                    "flex items-center justify-between gap-3 rounded-lg border bg-background-100 px-4 py-3 transition-[opacity,transform,border-color] duration-400 motion-reduce:transition-none",
                    phase === 0 ? "translate-y-2 opacity-0" : "translate-y-0 opacity-100",
                    phase === 2 ? "border-border-subtle" : "border-border-default",
                  )}
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <span aria-hidden className="logo-tile h-8 w-8 shrink-0 rounded-lg">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={`/logos/${slug}.svg`} alt="" className="h-[62%] w-[62%]" loading="lazy" />
                    </span>
                    <div className="min-w-0">
                      <p className="text-copy-14 text-gray-1000">{name}</p>
                      <p className="truncate font-mono text-mono-13 text-gray-700">{detail}</p>
                    </div>
                  </div>
                  {phase === 2 ? (
                    <span
                      key="connected"
                      className="flex shrink-0 animate-[connect-pop_0.35s_cubic-bezier(0.175,0.885,0.32,1.275)] items-center gap-2 font-mono text-label-12 text-ok motion-reduce:animate-none"
                    >
                      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-ok" />
                      connected
                    </span>
                  ) : (
                    <span
                      key="connecting"
                      className="flex shrink-0 items-center gap-2 font-mono text-label-12 text-warn"
                    >
                      <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-warn motion-reduce:animate-none" />
                      connecting…
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

export default DashboardDemo;
