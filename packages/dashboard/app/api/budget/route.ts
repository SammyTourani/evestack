import { query } from "@/lib/db";

/** The three the hook enforces; anything else is treated as "fail" there. */
const BUDGET_MODES = new Set(["fail", "cancel", "observe"]);

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

/**
 * The zone the hook cuts the day on, which is not always the one configured.
 *
 * `Intl.DateTimeFormat` throws `RangeError` on a zone it does not know, and a
 * trailing space or an offset like `GMT+2` is enough — so the raw variable used
 * to 500 this route. `validTimeZone` in packages/evestack-budget/src/config.ts
 * warns and falls back to UTC instead, and this has to make the same choice for
 * the same reason the mode below is validated rather than echoed: reporting a
 * zone nothing is cutting on, or erroring on a value the hook shrugged at, both
 * break the one promise this endpoint makes — that the row it reads is the row
 * the hook writes. Same rule rather than same code, because this app is
 * deliberately not a dependency of that package.
 */
function resolveTimeZone(raw: string | undefined): string {
  const trimmed = raw?.trim();
  if (!trimmed) return "UTC";
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: trimmed });
    return trimmed;
  } catch {
    return "UTC";
  }
}

export async function GET(request: Request) {
  const sessionId = new URL(request.url).searchParams.get("sessionId");
  const timeZone = resolveTimeZone(process.env.EVESTACK_BUDGET_TIMEZONE);
  const disabled =
    process.env.EVESTACK_BUDGET_DISABLED === "1" || process.env.EVESTACK_BUDGET_DISABLED === "true";

  try {
    // Inside the try, not above it. This is the same zone the hook cuts the daily
    // window on, so the row this page reads is the row the hook is writing — but
    // `Intl` throws on a zone it rejects, and computing it before the try turned
    // that into a 500 instead of the `{ ok: false }` body the catch below exists
    // to produce. `resolveTimeZone` means the environment can no longer reach
    // that throw; being inside the try means nothing else can either.
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
        // Validated, not echoed. The hook that actually enforces this falls back to
        // "fail" for anything outside these three (envMode in
        // packages/evestack-budget/src/config.ts), so passing the raw variable
        // through meant a typo like EVESTACK_BUDGET_MODE=observ reported a mode
        // nothing was enforcing. The dashboard is not a dependency of that package,
        // so this is the same list rather than the same code — if that list ever
        // grows, this is the second place to change.
        mode: BUDGET_MODES.has(process.env.EVESTACK_BUDGET_MODE ?? "")
          ? (process.env.EVESTACK_BUDGET_MODE as string)
          : "fail",
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
