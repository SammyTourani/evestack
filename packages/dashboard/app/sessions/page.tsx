import { Suspense } from "react";

import { DatabaseError } from "@/app/db-error";
import { FleetBanner } from "@/app/fleet-banner";
import { CONTROL, FOCUS_RING } from "@/components/ui/style";
import { agentUrlForHumans } from "@/lib/agent-client";
import { describeDbError, query } from "@/lib/db";
import { refreshFacts } from "@/lib/facts";
import {
  type SessionCursor,
  type SessionRow,
  listSessions,
  nextSessionCursor,
  parseSessionCursor,
} from "@/lib/queries";

import { DEFAULT_PAGE_SIZE, PAGE_SIZES, type SessionListRow, sessionOutcome } from "./rollup";
import { SessionsTable } from "./sessions-client";

export const dynamic = "force-dynamic";

/**
 * The sessions list: the ability to find a run.
 *
 * ── Where the columns come from, and why it is two queries ───────────────────
 *
 * `listSessions` owns paging. It is keyset, not OFFSET, and it was measured at
 * 0.9 ms / 613 buffers on a page of this size — so this page asks it for a page
 * and never reimplements the walk. What it does not carry is anything derived:
 * a session run's attributes are three keys (`$eve.type`, `$eve.title`,
 * `$eve.trigger`), so outcome, provider, environment, run type, tool calls and
 * the priced/unpriced distinction are all one join away.
 *
 * That join is `evestack.fact_turn`, which W2 built exactly for it, and
 * everything measured on this page comes from there — including tokens and
 * cost, which `listSessions` also returns. Reading those from the run
 * attributes instead would be a second cost model beside the fact table's, free
 * to disagree with every chart, and it cannot tell an unpriced model from a
 * free one: `costUsd()` returns 0 for both, and `$0.00` under a column called
 * `cost` is the exact lie `fact_turn.priced` exists to prevent.
 *
 * ── Filters are client-side, over the page ───────────────────────────────────
 *
 * The facet chips, the search box and the sort are `DataTable`'s, computed over
 * the rows the server sent. That is stated on the page rather than implied,
 * because a facet count over 250 of 100,000 sessions that presents itself as a
 * fleet-wide count is the same class of mistake as an unpriced zero. Filtering
 * in SQL instead would mean a second query beside `listSessions` — one that
 * would have to re-derive its keyset walk with a WHERE clause in it — which is
 * a bigger, more duplicative change than this page is worth today.
 */

/* -------------------------------------------------------------------------- */
/* the fact rollup                                                             */
/* -------------------------------------------------------------------------- */

interface FactRollup {
  readonly outcomes: string[];
  readonly models: string[];
  readonly providers: string[];
  readonly environments: string[];
  readonly runTypes: string[];
  readonly turns: number;
  readonly workMs: number | null;
  readonly timedTurns: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly costUsd: number | null;
  readonly pricedTurns: number;
  readonly unpricedTurns: number;
  readonly toolsCalled: number | null;
  readonly spanTurns: number;
}

/** `null` and `undefined` through, everything else as a finite number. */
const num = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const count = (value: unknown): number => num(value) ?? 0;

const text = (value: unknown): string[] => (Array.isArray(value) ? (value as string[]) : []);

/**
 * One row per session, for the sessions on this page only.
 *
 * `= ANY($1)` rather than a join back to the keyset query: the page is already
 * in hand, and a hundred-odd ids as one parameter is an index lookup on
 * `fact_turn`'s session column with no second walk of `workflow_runs`.
 *
 * Every SUM here skips NULLs, which is the behaviour the fact table was
 * designed around and the reason the counts travel beside the sums:
 * `sum(cost_usd)` over a session that ran one priced and one unpriced model is
 * a real number covering half the session, and only `unpriced_turns` says so.
 */
async function factsBySession(ids: readonly string[]): Promise<Map<string, FactRollup>> {
  if (ids.length === 0) return new Map();
  const rows = await query<Record<string, unknown>>(
    `
    SELECT session_id,
           count(*)                                            AS turns,
           array_agg(DISTINCT outcome)                         AS outcomes,
           array_remove(array_agg(DISTINCT model), NULL)       AS models,
           array_remove(array_agg(DISTINCT provider), NULL)    AS providers,
           array_remove(array_agg(DISTINCT environment), NULL) AS environments,
           array_agg(DISTINCT run_type)                        AS run_types,
           sum(duration_ms)                                    AS work_ms,
           count(duration_ms)                                  AS timed_turns,
           sum(input_tokens)                                   AS input_tokens,
           sum(output_tokens)                                  AS output_tokens,
           sum(cache_read_tokens)                              AS cache_read_tokens,
           sum(cache_write_tokens)                             AS cache_write_tokens,
           sum(cost_usd)                                       AS cost_usd,
           count(*) FILTER (WHERE priced)                      AS priced_turns,
           count(*) FILTER (WHERE NOT priced)                  AS unpriced_turns,
           sum(tools_called)                                   AS tools_called,
           -- Turns that could contribute a tool count at all, which is the
           -- denominator the cell states. NULL means "no span reached us",
           -- never "no tool was called".
           count(tools_called)                                 AS span_turns
      FROM evestack.fact_turn
     WHERE session_id = ANY($1::text[])
     GROUP BY session_id
    `,
    [[...ids]],
  );

  return new Map(
    rows.map((r) => [
      String(r.session_id),
      {
        outcomes: text(r.outcomes),
        models: text(r.models),
        providers: text(r.providers),
        environments: text(r.environments),
        runTypes: text(r.run_types),
        turns: count(r.turns),
        workMs: num(r.work_ms),
        timedTurns: count(r.timed_turns),
        inputTokens: count(r.input_tokens),
        outputTokens: count(r.output_tokens),
        cacheReadTokens: count(r.cache_read_tokens),
        cacheWriteTokens: count(r.cache_write_tokens),
        costUsd: num(r.cost_usd),
        pricedTurns: count(r.priced_turns),
        unpricedTurns: count(r.unpriced_turns),
        toolsCalled: num(r.tools_called),
        spanTurns: count(r.span_turns),
      },
    ]),
  );
}

/** Turns before the subagents they spawned, so the cell reads "turn, subagent". */
const RUN_TYPE_ORDER = ["turn", "subagent"];

function joinValues(values: readonly string[] | undefined): string | null {
  if (!values || values.length === 0) return null;
  return [...values].sort().join(", ");
}

function toRow(session: SessionRow, fact: FactRollup | undefined): SessionListRow {
  return {
    id: session.id,
    title: session.title,
    trigger: session.trigger,
    createdAt: session.createdAt,
    outcome: fact ? sessionOutcome(fact.outcomes) : null,
    model: joinValues(fact?.models),
    provider: joinValues(fact?.providers),
    environment: joinValues(fact?.environments),
    runType:
      fact === undefined || fact.runTypes.length === 0
        ? null
        : [...fact.runTypes]
            .sort((a, b) => RUN_TYPE_ORDER.indexOf(a) - RUN_TYPE_ORDER.indexOf(b))
            .join(", "),
    turns: fact?.turns ?? 0,
    workMs: fact?.workMs ?? null,
    timedTurns: fact?.timedTurns ?? 0,
    inputTokens: fact?.inputTokens ?? 0,
    outputTokens: fact?.outputTokens ?? 0,
    cacheReadTokens: fact?.cacheReadTokens ?? 0,
    cacheWriteTokens: fact?.cacheWriteTokens ?? 0,
    costUsd: fact?.costUsd ?? null,
    pricedTurns: fact?.pricedTurns ?? 0,
    unpricedTurns: fact?.unpricedTurns ?? 0,
    toolsCalled: fact?.toolsCalled ?? null,
    spanTurns: fact?.spanTurns ?? 0,
  };
}

/* -------------------------------------------------------------------------- */
/* the page                                                                    */
/* -------------------------------------------------------------------------- */

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

/** An unknown or unlisted size falls back rather than 400s — it is a URL. */
function readLimit(raw: string): number {
  const asked = Number(raw);
  return (PAGE_SIZES as readonly number[]).includes(asked) ? asked : DEFAULT_PAGE_SIZE;
}

/**
 * `outcome` rides along, or paging out of a filtered view silently unfilters it.
 *
 * The facet chips themselves are client state and do not survive a navigation —
 * that is pre-existing and fine, because the reader set them and can see them
 * go. A deep link is different: the filter came from the URL, so the URL is
 * what has to carry it to page two.
 */
function href(limit: number, cursor: string, outcome?: string): string {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set("cursor", cursor);
  if (outcome) params.set("outcome", outcome);
  return `/sessions?${params}`;
}

/**
 * The outcomes `fact_turn` can actually hold — `sql/facts.sql:189`'s CHECK
 * constraint, in the same order.
 *
 * The list is here rather than imported because the constraint is SQL: this is
 * a copy, and contract/runtime probe 07 is what keeps the two honest.
 */
const OUTCOMES = new Set([
  "ok",
  "failed",
  "no_model_call",
  "cancelled",
  "budget_stopped",
  "wedged",
  "running",
]);

/**
 * `?outcome=` → an opening facet, or nothing.
 *
 * Validated rather than passed through. An unrecognised value would select a
 * facet no row can match, and an empty table under a filter chip the reader
 * did not set reads as "no sessions", which is the wrong answer to a typo.
 *
 * This exists because `lib/alerts.ts` links here as `/sessions?outcome=wedged`
 * and the page read only `limit` and `cursor` — so the alert that found eight
 * wedged turns dropped you on an unfiltered first page and let you find them.
 */
function readOutcome(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  return OUTCOMES.has(raw) ? raw : undefined;
}

const NUMBER = new Intl.NumberFormat("en-US");

export default async function SessionsListPage(props: PageProps<"/sessions">) {
  const params = await props.searchParams;
  const limit = readLimit(first(params.limit));
  const rawCursor = first(params.cursor);
  const outcome = readOutcome(first(params.outcome));

  let cursor: SessionCursor | null = null;
  if (rawCursor) {
    try {
      cursor = parseSessionCursor(rawCursor);
    } catch {
      // `parseSessionCursor` throws rather than silently restarting, because a
      // cursor that quietly means "page one" duplicates rows a reader already
      // scrolled past. Only a hand-edited URL gets here, and it gets a sentence
      // about the URL rather than the database error page it would otherwise
      // fall through to.
      return (
        <>
          <h1>Sessions</h1>
          <div className="empty">
            <h2>That page link is not a valid position</h2>
            <p className="dim">
              The <code>cursor</code> in this URL is not one this page issued.
            </p>
            <p>
              <a className={`text-accent hover:underline ${FOCUS_RING}`} href={href(limit, "", outcome)}>
                Start from the newest session
              </a>
            </p>
          </div>
        </>
      );
    }
  }

  let sessions: SessionRow[];
  try {
    sessions = await listSessions(limit, cursor);
  } catch (error) {
    return (
      <>
        <h1>Sessions</h1>
        <DatabaseError error={error} />
      </>
    );
  }

  // Degraded, not fatal. The fact tables live in the `evestack` schema and are
  // rebuildable, so a role without CREATE there — a perfectly reasonable way to
  // point this at someone else's Postgres — loses the derived columns and keeps
  // the list. Every fact-derived cell then renders an em dash, which is the
  // honest reading of "we could not compute it".
  let facts = new Map<string, FactRollup>();
  let factsError: string | null = null;
  try {
    await refreshFacts();
    facts = await factsBySession(sessions.map((s) => s.id));
  } catch (error) {
    factsError = describeDbError(error);
  }

  const rows = sessions.map((s) => toRow(s, facts.get(s.id)));
  const next = nextSessionCursor(sessions, limit);
  const now = Date.now();

  return (
    <>
      <h1>Sessions</h1>
      <p className="page-sub">
        Every agent run on this machine, read straight from your own Postgres. Sorting, filtering,
        search and export work over the {NUMBER.format(rows.length)} session
        {rows.length === 1 ? "" : "s"} loaded on this page.
      </p>

      {/* Renders nothing when nothing is wrong — see fleet-banner.tsx.

          Behind a Suspense boundary because it is the only thing on this page
          that talks to the agent, and it must never be the reason the list is
          slow. Measured before this boundary existed: /sessions took 15.2s
          while every other page was under 320ms, because the banner probes the
          agent once per candidate session and each probe ran to its timeout.
          Streaming it means the table paints from Postgres alone and the
          banner arrives when the agent answers — or never, which costs the
          reader nothing.

          No skeleton. The banner renders nothing at all when the fleet is
          healthy, so a placeholder would announce a problem that usually is
          not there and then shift the layout when it resolves to empty. */}
      <Suspense fallback={null}>
        <FleetBanner />
      </Suspense>

      {factsError === null ? null : (
        <p className="mb-3 text-small text-warn">
          Outcome, cost, tool calls and the model columns come from the fact tables, which could not
          be refreshed: {factsError}. The list below is the session rows alone.
        </p>
      )}

      {rows.length === 0 ? (
        cursor === null ? (
          <NoSessions />
        ) : (
          <div className="empty">
            <h2>No more sessions</h2>
            <p className="dim">This page is past the last session in the list.</p>
            <p>
              <a className={`text-accent hover:underline ${FOCUS_RING}`} href={href(limit, "", outcome)}>
                Back to the newest
              </a>
            </p>
          </div>
        )
      ) : (
        <>
          <SessionsTable rows={rows} now={now} outcome={outcome} />
          <nav aria-label="Pagination" className="mt-3 flex flex-wrap items-center gap-3 text-small">
            <span className="text-text-faint">rows per page</span>
            {PAGE_SIZES.map((size) =>
              size === limit ? (
                <span key={size} aria-current="true" className="text-text tabular-nums">
                  {NUMBER.format(size)}
                </span>
              ) : (
                <a
                  key={size}
                  href={href(size, rawCursor, outcome)}
                  className={`rounded-sm text-accent tabular-nums hover:underline ${FOCUS_RING}`}
                >
                  {NUMBER.format(size)}
                </a>
              ),
            )}
            <span className="grow" />
            {cursor === null ? null : (
              <a href={href(limit, "", outcome)} className={CONTROL}>
                ← Newest
              </a>
            )}
            {next === null ? (
              <span className="text-text-faint">End of the list</span>
            ) : (
              <a href={href(limit, next, outcome)} className={CONTROL}>
                Older {NUMBER.format(limit)} →
              </a>
            )}
          </nav>
          {rows.some((row) => row.unpricedTurns > 0) ? (
            <p className="mt-3 text-small text-text-faint">
              Some of these sessions ran a model with no configured rate, so their cost reads{" "}
              <span className="text-warn">Unpriced</span> rather than a dollar amount. Set{" "}
              <code className="font-mono">EVESTACK_PRICING</code> to price them.
            </p>
          ) : null}
        </>
      )}
    </>
  );
}

/**
 * A database with no runs in it. Kept verbatim from the page this route
 * replaces, including `agentUrlForHumans()` — the container's configured host
 * is `host.docker.internal`, which does not resolve in the terminal this text
 * asks you to paste into.
 */
function NoSessions() {
  return (
    <div className="empty">
      <h2>No sessions yet</h2>
      <p>Your agent has not run. Start one and it appears here.</p>
      <p>
        <a className={`text-accent hover:underline ${FOCUS_RING}`} href="/chat">
          Open Chat
        </a>{" "}
        and send your agent a message.
      </p>
      <p className="faint">Or from a terminal:</p>
      <p className="faint mono">
        curl -X POST {agentUrlForHumans()}/eve/v1/session -H &apos;content-type:
        application/json&apos; -d &apos;{"{"}&quot;message&quot;:&quot;hello&quot;{"}"}&apos;
      </p>
    </div>
  );
}
