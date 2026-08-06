/**
 * The sessions list's row shape, and the two rules in it that are easy to get
 * quietly wrong: which outcome a session takes from its turns, and how a row
 * becomes a CSV field.
 *
 * ── Why this is a third file rather than living in one of the other two ──────
 *
 * It cannot live in `sessions-client.tsx`. Once a Server Component imports a
 * `"use client"` module, *every* export of that module is a client reference,
 * not the value — so `page.tsx`, which builds these rows on the server, could
 * not call a function that lived there.
 *
 * It cannot live in `page.tsx` either. That file imports `./db-error` and
 * `./fleet-banner`, which import through the `@/` alias, and
 * `test/register-ts-resolve.mjs` resolves relative specifiers only — a bare
 * `@/…` goes to node_modules and fails. Anything reachable from `page.tsx` is
 * therefore unreachable from a unit test.
 *
 * This module imports one type and nothing else, so the server, the client and
 * `test/sessions-list.test.mjs` can all read it. Same reason
 * `components/ui/format.ts` spells its imports relatively.
 */
import type { Outcome } from "../../components/ui/badge";

/**
 * One session, rolled up.
 *
 * Identity, the title and the trigger come from the session run itself
 * (`lib/queries.ts#listSessions`); everything measured comes from
 * `evestack.fact_turn`, so the numbers on this page and the numbers on every
 * chart are the same arithmetic. The alternative — summing `$eve.*` tags here
 * as the old page did — is a second cost model that can disagree with the fact
 * table, and it has no way to tell an unpriced model from a free one.
 */
export interface SessionListRow {
  readonly id: string;
  readonly title: string | null;
  readonly trigger: string | null;
  /** ISO 8601 with a `Z`. Rendered through `lib/time.ts`, never `toLocale*`. */
  readonly createdAt: string;
  /**
   * The worst outcome among this session's turns — see `sessionOutcome`. Null
   * when no turn has been recorded yet, which is a session too young to judge,
   * not a healthy one.
   */
  readonly outcome: Outcome | null;
  /**
   * Every distinct value across the session's turns, joined with ", ", or null
   * when the session recorded none.
   *
   * Joined rather than reduced to the busiest one, because the faceted filter
   * compares a cell to a checkbox and a session that used two models has to
   * survive that comparison. Filing it under one of the two would hide it from
   * a filter on the other — a filter that silently drops rows is worse than a
   * facet list with a compound entry in it. In practice they are single-valued:
   * on the seeded month, 0 of 700 sessions used more than one model, provider,
   * environment or trigger.
   */
  readonly model: string | null;
  readonly provider: string | null;
  readonly environment: string | null;
  readonly runType: string | null;
  readonly turns: number;
  /**
   * Sum of the session's turn durations, and deliberately NOT its wall clock.
   *
   * `lib/monitors.ts` already made this call and the reasoning carries: a
   * session run stays open while a human keeps the tab open, so its
   * created→completed span measures the human, not the agent.
   */
  readonly workMs: number | null;
  /** Turns that had a duration to contribute. `workMs` is a sum over these. */
  readonly timedTurns: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  /**
   * Spend over the turns that ran a PRICED model. Null when none did.
   *
   * `fact_turn.cost_usd` is NULL for a turn whose model has no configured rate,
   * so this sum silently omits them — which is why `pricedTurns` and
   * `unpricedTurns` travel with it. Without those two, `0` means both "ollama,
   * which really is free" and "we have no idea".
   */
  readonly costUsd: number | null;
  readonly pricedTurns: number;
  readonly unpricedTurns: number;
  /**
   * Tool invocations counted from spans, over `spanTurns` of `turns`. Null when
   * no turn in the session exported any, which is the common case: spans are
   * opt-in and cover ~370 of 1,922 seeded turns.
   */
  readonly toolsCalled: number | null;
  readonly spanTurns: number;
}

/**
 * Rows the server fetches per page, and the default.
 *
 * The default doubles as `DataTable`'s `virtualizeAfter`, which is what keeps
 * the common case honest: at or below it every row is rendered on the server,
 * so the first paint IS the list. Above it the virtualizer takes over and the
 * server sends an empty `<tbody>` for hydration to fill — the trade
 * `components/ui/table.tsx` documents, and the only reason 10,000 sessions do
 * not arrive as a 10,000-row HTML document.
 */
export const PAGE_SIZES = [100, 250, 1_000, 10_000] as const;
export const DEFAULT_PAGE_SIZE = 250;

/**
 * How bad each outcome is, lowest first. A total map over `Outcome` rather than
 * an array, for the reason `components/ui/badge.tsx` gives about its own map: a
 * value added to `sql/facts.sql`'s CHECK and to `OUTCOMES` but not to this is
 * then a type error here, at the only point it is still cheap to fix.
 *
 * The order is "what would make someone open this row". Wedged first because
 * nothing is going to finish it without a person. `budget_stopped` sits below
 * the two failures because it is the guardrail working, not the agent breaking.
 * `running` outranks `ok` so a session with one turn still in flight does not
 * advertise itself as finished.
 */
const SEVERITY: Readonly<Record<Outcome, number>> = {
  wedged: 0,
  failed: 1,
  no_model_call: 2,
  budget_stopped: 3,
  cancelled: 4,
  running: 5,
  ok: 6,
};

/**
 * A session's outcome is the worst of its turns'.
 *
 * The unknown-value guard is not decoration. These strings arrive from a SQL
 * CHECK constraint that TypeScript cannot see, and an unrecognised one would
 * reach `OutcomeBadge`, miss its lookup table and throw while destructuring —
 * a blank page for what is a vocabulary drift. Skipping it renders an em dash
 * instead, and `test/sessions-list.test.mjs` fails the moment the two
 * vocabularies stop matching, which is where that drift should surface.
 */
export function sessionOutcome(outcomes: readonly string[]): Outcome | null {
  let worst: Outcome | null = null;
  for (const value of outcomes) {
    if (!Object.hasOwn(SEVERITY, value)) continue;
    const candidate = value as Outcome;
    if (worst === null || SEVERITY[candidate] < SEVERITY[worst]) worst = candidate;
  }
  return worst;
}

/**
 * The export's columns, in order: header, and how to read it off a row.
 *
 * Values, not the strings on screen. A CSV opened in a spreadsheet is going to
 * be sorted, summed and pivoted, and `12.4s`, `1.2M` and `3h ago` are all
 * hostile to that. The one formatting rule the table has that survives here is
 * the one about lying: an unpriced session's `cost_usd` is EMPTY, never 0, and
 * `unpriced_turns` next to it says why. Same for `tools_called`, which is empty
 * rather than 0 when no turn exported a span — `turns_with_spans` is the
 * denominator that makes the difference readable.
 */
const CSV_COLUMNS: readonly (readonly [string, (row: SessionListRow) => string | number | null])[] =
  [
    ["session_id", (r) => r.id],
    ["title", (r) => r.title],
    ["outcome", (r) => r.outcome],
    ["trigger", (r) => r.trigger],
    ["models", (r) => r.model],
    ["providers", (r) => r.provider],
    ["environments", (r) => r.environment],
    ["run_types", (r) => r.runType],
    ["turns", (r) => r.turns],
    ["turn_duration_ms", (r) => r.workMs],
    ["turns_timed", (r) => r.timedTurns],
    ["input_tokens", (r) => r.inputTokens],
    ["output_tokens", (r) => r.outputTokens],
    ["cache_read_tokens", (r) => r.cacheReadTokens],
    ["cache_write_tokens", (r) => r.cacheWriteTokens],
    ["cost_usd", (r) => r.costUsd],
    ["priced_turns", (r) => r.pricedTurns],
    ["unpriced_turns", (r) => r.unpricedTurns],
    ["tools_called", (r) => r.toolsCalled],
    ["turns_with_spans", (r) => r.spanTurns],
    ["created_at", (r) => r.createdAt],
  ];

/**
 * RFC 4180: quote only when the field would otherwise break the format, and
 * escape a quote by doubling it.
 *
 * A session title is a user's first message, so it contains commas, quotes and
 * newlines routinely — this is the common path, not the edge.
 */
function csvField(value: string | number | null): string {
  if (value === null) return "";
  const text = String(value);
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

/** The rows as an RFC 4180 document. CRLF, because that is what the RFC says. */
export function toCsv(rows: readonly SessionListRow[]): string {
  const lines = [CSV_COLUMNS.map(([header]) => header).join(",")];
  for (const row of rows) {
    lines.push(CSV_COLUMNS.map(([, read]) => csvField(read(row))).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}
