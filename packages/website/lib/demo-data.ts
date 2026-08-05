/* Typed data for the dashboard demo (components/sections/dashboard-demo.tsx).
   Session rows are lifted from a real local evestack instance so the demo
   reads like the actual product. One line per session, spreadsheet-style. */

export type SessionStatus = "running" | "completed";

export interface DemoSession {
  id: string;
  title: string;
  status: SessionStatus;
  turns: number;
  model: string;
  tokensIn: number;
  tokensOut: number;
  /** model spend in USD */
  cost: number;
  /** pre-formatted relative timestamp */
  started: string;
  durationS: number;
  /** cached input tokens */
  cached: number;
  /** tool calls */
  tools: number;
}

/** A session that "arrives" during one animation cycle; status is animated. */
export type LiveDemoSession = Omit<DemoSession, "status">;

/** Stat-tile rollup WITHOUT the three live rows (30 prior sessions).
    spend renders "$0.05" while a pass re-earns it and settles at "$0.06". */
export const baseStats = { sessions: 30, turns: 112, tokensIn: 148_210, tokensOut: 46_920, spend: 0.0545 };

const done = "completed" as const;
const m5 = "openai/gpt-5-mini";
const m4o = "openai/gpt-4o-mini";

// prettier-ignore
export const baseSessions: DemoSession[] = [
  { id: "wrun_01KZ6BJVMJ23…", title: "Write a detailed 1500-word essay about the history of database indexing.", status: done, turns: 1, model: m5, tokensIn: 5123, tokensOut: 3704, cost: 0.0077, started: "2m ago", durationS: 41.0, cached: 4608, tools: 13 },
  { id: "wrun_01KZ6B9TQF7X…", title: "Use your agent tool to delegate this subtask to a subagent…", status: done, turns: 2, model: m5, tokensIn: 15_489, tokensOut: 437, cost: 0.0021, started: "14m ago", durationS: 28.4, cached: 12_032, tools: 6 },
  { id: "wrun_01KZ5YHW2ND4…", title: "Run this bash command in your sandbox: echo chat-ui-works", status: done, turns: 1, model: m5, tokensIn: 3120, tokensOut: 96, cost: 0.0009, started: "1h ago", durationS: 12.8, cached: 2048, tools: 2 },
  { id: "wrun_01KZ5X0RKPA9…", title: "say ok", status: done, turns: 1, model: m4o, tokensIn: 5102, tokensOut: 4, cost: 0, started: "3h ago", durationS: 2.1, cached: 4860, tools: 0 },
  { id: "wrun_01KZ5WQJ8M3E…", title: "race test", status: done, turns: 3, model: m4o, tokensIn: 2210, tokensOut: 18, cost: 0, started: "5h ago", durationS: 3.4, cached: 1792, tools: 0 },
];

/** The live loop's three PERMANENT rows (hard cap 3 — more would stretch
    the dashboard): each pass they flip back to "running" IN PLACE with
    staggered starts, tick up concurrently, and complete at their own
    moments. The demo settles with all three completed (the SSR truth). */
// prettier-ignore
export const liveSessions: LiveDemoSession[] = [
  { id: "wrun_01KZ7A2FQ9RC…", title: "Deploy summary email to the team", turns: 3, model: m5, tokensIn: 12_847, tokensOut: 2164, cost: 0.0034, started: "just now", durationS: 18.2, cached: 9216, tools: 5 },
  { id: "wrun_01KZ7C8XVT5M…", title: "Summarize yesterday's error logs", turns: 2, model: m5, tokensIn: 9412, tokensOut: 1876, cost: 0.0027, started: "just now", durationS: 14.6, cached: 7424, tools: 4 },
  { id: "wrun_01KZ7E1KJW0B…", title: "Draft release notes for v0.4.0", turns: 2, model: m5, tokensIn: 11_038, tokensOut: 2493, cost: 0.0031, started: "just now", durationS: 16.9, cached: 8448, tools: 3 },
];
