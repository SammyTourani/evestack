import { UNCONFIGURED_MESSAGE, authConfigured } from "@/lib/auth";
import { query } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * GET /api/health — liveness, and nothing else.
 *
 * The only unauthenticated route in the dashboard, because Docker's HEALTHCHECK
 * has no credential to offer (see the Dockerfile). It therefore says as little
 * as a useful health check can: is this process up, and can it reach Postgres.
 *
 * It used to answer with `getTotals()` and the five most recent sessions —
 * session ids, turn counts, token counts, cost in dollars and model names — to
 * anyone who could reach the port. That is exactly the operational detail the
 * rest of the dashboard is now protecting, so it moved to /api/health/detail,
 * behind the session gate.
 *
 * Still a real query rather than a static `ok`, for the original reason: a
 * dashboard that boots but cannot reach the database is worse than one that
 * fails loudly. `SELECT 1` proves the pool works without reading a row of
 * anyone's data.
 *
 * Reporting unhealthy when auth is unconfigured is deliberate. The process is
 * up, but it is refusing every other request, and a container that answers "ok"
 * while serving nothing is how that misconfiguration survives to production.
 * An unhealthy HEALTHCHECK marks the container; it does not restart it, so this
 * surfaces the problem without a crash loop.
 */
export async function GET(): Promise<Response> {
  const headers = { "cache-control": "no-store" };

  if (!authConfigured()) {
    return Response.json(
      { ok: false, status: "unconfigured", error: UNCONFIGURED_MESSAGE },
      { status: 503, headers },
    );
  }

  try {
    await query("SELECT 1");
    return Response.json({ ok: true, database: "connected" }, { headers });
  } catch {
    // No error detail here. pg's messages carry the host, port and database
    // name from the connection string, and nothing authenticates this response.
    // The full message is on /api/health/detail.
    return Response.json({ ok: false, database: "unreachable" }, { status: 503, headers });
  }
}
