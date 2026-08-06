import { getTotals, listSessions } from "@/lib/queries";

export const dynamic = "force-dynamic";

/**
 * GET /api/health/detail — the health check that says something.
 *
 * This is the body /api/health used to return: totals plus the five most recent
 * sessions, with ids, turn counts, tokens, cost and models. Useful to a monitor
 * that knows how much the agent has been spending; useful to a stranger for
 * exactly the same reason, which is why it now sits in the session tier while
 * the bare liveness probe stays public.
 *
 * The error message is included here and omitted from /api/health on purpose:
 * pg reports the host, port and database name it failed to reach, and that is
 * the first thing you want when the dashboard cannot see Postgres — behind a
 * credential.
 */
export async function GET(): Promise<Response> {
  const headers = { "cache-control": "no-store" };

  try {
    const totals = await getTotals();
    const sessions = await listSessions(5);
    return Response.json(
      {
        ok: true,
        database: "connected",
        totals,
        recentSessions: sessions.map((s) => ({
          id: s.id,
          status: s.status,
          turns: s.turnCount,
          tokens: s.inputTokens + s.outputTokens,
          costUsd: s.costUsd,
          models: s.models,
        })),
      },
      { headers },
    );
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 503, headers },
    );
  }
}
