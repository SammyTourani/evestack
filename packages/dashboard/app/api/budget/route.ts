import { query } from "@/lib/db";

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
 * Deliberately raw SQL rather than importing `@evestack/budget`. This app is
 * containerized from an isolated build context (`context: ./packages/dashboard`
 * plus a plain `npm install`), so a `workspace:*` dependency fails the image
 * build outright — `npm error EUNSUPPORTEDPROTOCOL`. The four `evestack.budget_*`
 * tables are the contract between the two halves; four SELECTs cost less than
 * restructuring the container build.
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

function parseCap(raw: string | undefined, fallback: number): number | false {
  if (raw === undefined || raw.trim() === "") return fallback;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "false" || trimmed === "off" || trimmed === "none") return false;
  const value = Number(trimmed.replace(/^\$/, ""));
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export async function GET(request: Request) {
  const sessionId = new URL(request.url).searchParams.get("sessionId");
  const timeZone = process.env.EVESTACK_BUDGET_TIMEZONE ?? "UTC";
  const disabled =
    process.env.EVESTACK_BUDGET_DISABLED === "1" || process.env.EVESTACK_BUDGET_DISABLED === "true";

  // Same zone the hook cuts the daily window on, so the row this page reads is
  // the row the hook is writing.
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

  try {
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
      query(
        `SELECT scope, scope_key, session_id, reason, limit_usd, spent_usd, created_at
           FROM evestack.budget_stops
          ORDER BY created_at DESC
          LIMIT 50`,
      ),
      sessionId
        ? query<UsageRow>(
            `SELECT cost_usd, input_tokens, output_tokens, cache_read_tokens, steps, unpriced_steps
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
      limits: {
        sessionUsd: disabled ? false : parseCap(process.env.EVESTACK_BUDGET_SESSION_USD, 2),
        dailyUsd: disabled ? false : parseCap(process.env.EVESTACK_BUDGET_DAILY_USD, 10),
        mode: process.env.EVESTACK_BUDGET_MODE ?? "fail",
        timeZone,
      },
      ...(first ? { session: { id: sessionId, ...usage(first) } } : {}),
      principals: principals.map((row) => ({
        principalId: row.principal_id ?? "unknown",
        ...usage(row),
      })),
      stops,
      events,
    });
  } catch (error) {
    // The tables only exist once the budget hook has run once. A dashboard
    // pointed at an agent that never enabled it should say so, not 500.
    const detail = error instanceof Error ? error.message : String(error);
    const missing = detail.includes("evestack.budget");
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
