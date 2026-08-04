import { getTotals, listSessions } from "@/lib/queries";

export const dynamic = "force-dynamic";

/**
 * Liveness plus a real read. A dashboard that boots but cannot reach the
 * database is worse than one that fails loudly, so this endpoint actually
 * queries rather than returning a static ok.
 */
export async function GET() {
  try {
    const totals = await getTotals();
    const sessions = await listSessions(5);
    return Response.json({
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
    });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 503 },
    );
  }
}
