import { readBudgetPolicy } from "@/lib/budget-policy";
import { isMissingTable, query } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Why a session stopped, and how close every user is to their daily cap.
 *
 * The event stream cannot answer the first question. `turn.cancelled` says a
 * turn ended and `turn.failed` says one failed; neither says a budget did it,
 * because eve gives an authored hook no way to name the reason on the stream.
 * So `@evestack/budget` writes the reason to `evestack.budget_events`, and this
 * is where you read it.
 *
 * Reads recorded spend and saved policy independently of the live agent.
 * A saved limit is labelled with its source and agent observations; it is not
 * presented as proof of current enforcement by an arbitrary attached agent.
 *
 * `?sessionId=` scopes the stop list and adds that session's running totals.
 */

interface UsageRow {
  cost_usd: string;
  input_tokens: string;
  output_tokens: string;
  cache_read_tokens: string;
  steps: number;
  unpriced_steps: number;
}

export async function GET(request: Request) {
  const sessionId = new URL(request.url).searchParams.get("sessionId");
  if (sessionId && sessionId.length > 300)
    return Response.json(
      { ok: false, error: "Session id is too long." },
      { status: 400 },
    );

  try {
    const { limits, configuration } = await readBudgetPolicy();
    const timeZone = limits.timeZone;
    const day = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());

    const [principals, events, stops, sessionRows] = await Promise.all([
      query<{ principal_id: string | null } & UsageRow>(
        `SELECT principal_id, cost_usd, input_tokens, output_tokens, cache_read_tokens, steps, unpriced_steps
           FROM evestack.budget_usage
          WHERE scope = 'principal-day' AND day = $1::date
          ORDER BY cost_usd DESC
          LIMIT 200`,
        [day],
      ),
      query(
        `SELECT id, session_id, turn_id, principal_id, scope, limit_usd, spent_usd, action, detail, created_at
           FROM evestack.budget_events
          WHERE $1::text IS NULL OR session_id = $1
          ORDER BY created_at DESC
          LIMIT 50`,
        [sessionId],
      ),
      /* The sessionId filter is the same shape as the budget_events query directly
         above, and its absence here was the bug. `?sessionId=X` returned other
         sessions' stop rows, and because the LIMIT is global it could omit X's own
         row entirely once 50 newer stops existed elsewhere — which is precisely the
         row you open this endpoint to find: "was this session stopped, and why". */
      query(
        `SELECT scope, scope_key, session_id, reason, limit_usd, spent_usd, created_at
           FROM evestack.budget_stops
          WHERE $1::text IS NULL OR session_id = $1
          ORDER BY created_at DESC
          LIMIT 50`,
        [sessionId],
      ),
      sessionId
        ? query<UsageRow & { principal_id: string | null }>(
            `SELECT principal_id, cost_usd, input_tokens, output_tokens, cache_read_tokens, steps, unpriced_steps
               FROM evestack.budget_usage
              WHERE scope = 'session' AND scope_key = $1`,
            [sessionId],
          )
        : Promise.resolve([]),
    ]);

    const usage = (row: UsageRow) => ({
      costUsd: Number(row.cost_usd),
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
      cacheReadTokens: Number(row.cache_read_tokens),
      steps: Number(row.steps),
      unpricedSteps: Number(row.unpriced_steps),
    });

    const first = sessionRows[0];

    return Response.json({
      ok: true,
      day,
      limits,
      configuration,
      ...(first
        ? {
            session: {
              id: sessionId,
              principalId: first.principal_id ?? "unknown",
              ...usage(first),
            },
          }
        : {}),
      principals: principals.map((row) => ({
        principalId: row.principal_id ?? "unknown",
        ...usage(row),
      })),
      stops,
      events,
    });
  } catch (error) {
    /*
     * The tables only exist once the budget hook has run once. A dashboard
     * pointed at an agent that never enabled it should say so, not 500.
     *
     * WHICH IS NOT THE SAME AS SAYING 200. The test was `detail.includes
     * ("evestack.budget")`, a substring of the message, so `permission denied
     * for table budget_usage` and a half-applied migration both produced the
     * reassuring "No budget data yet" sentence AT HTTP 200 — and a monitor
     * polling this route for a non-2xx read a healthy endpoint while the spend
     * caps were genuinely unreadable. pg tells us precisely which case this is:
     * 42P01 is undefined_table and nothing else is.
     *
     * The status stays 200 for the genuinely-absent case, because that is a
     * real answer to a real question ("no budget data exists"), and becomes 503
     * for everything else, because that is not an answer at all.
     */
    const detail = error instanceof Error ? error.message : String(error);
    // `isMissingTable` is lib/db.ts's own SQLSTATE test and the only honest one
    // here: query() rethrows as DatabaseUnavailableError, so `error.code` is
    // gone by the time this runs and only the formatted message survives.
    const missing = isMissingTable(error) && detail.includes("evestack.budget");
    return Response.json(
      {
        ok: false,
        error: missing
          ? "No budget data yet. The evestack.budget_* tables are created the first time @evestack/budget records a step."
          : detail,
      },
      { status: missing ? 200 : 503 },
    );
  }
}
