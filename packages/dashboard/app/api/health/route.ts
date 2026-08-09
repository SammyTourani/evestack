import { UNCONFIGURED_MESSAGE, authConfigured } from "@/lib/auth";
import { query } from "@/lib/db";
import { dashboardVersion } from "@/lib/version";

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
 * up, but the only thing it will serve is a sign-in page with no form on it, and
 * a container that answers "ok" while serving nothing usable is how that
 * misconfiguration survives to production.
 * An unhealthy HEALTHCHECK marks the container; it does not restart it, so this
 * surfaces the problem without a crash loop.
 */
export async function GET(): Promise<Response> {
  const headers = { "cache-control": "no-store" };

  if (!authConfigured()) {
    return Response.json(
      { ok: false, status: "unconfigured", version: dashboardVersion(), error: UNCONFIGURED_MESSAGE },
      { status: 503, headers },
    );
  }

  try {
    // `SELECT 1` proves the pool works and nothing more, and "nothing more" was
    // the bug: a stack brought up without `npm run db:bootstrap` answered 200
    // here and reported HEALTHY in `docker ps` while every page in the dashboard
    // failed, because `workflow.workflow_runs` did not exist. Measured on a
    // clean machine — healthy container, unusable product.
    //
    // to_regclass() rather than a query against the table: it answers NULL
    // instead of raising, needs no permissions beyond catalog read, and cannot
    // be confused with the connection failing. Reporting unhealthy here is the
    // same judgement the unconfigured branch above already makes — the process
    // is up and refusing to pretend it can do its job. An unhealthy HEALTHCHECK
    // marks the container; it does not restart it, so this surfaces the
    // misconfiguration without a crash loop.
    const [schema] = await query<{ present: string | null }>(
      "SELECT to_regclass('workflow.workflow_runs')::text AS present",
    );
    if (!schema?.present) {
      return Response.json(
        {
          ok: false,
          database: "connected",
          status: "schema-missing",
          version: dashboardVersion(),
          error:
            "Postgres is reachable but has no agent schema. Run `npm run db:bootstrap` in your agent project.",
        },
        { status: 503, headers },
      );
    }
    return Response.json({ ok: true, database: "connected", version: dashboardVersion() }, { headers });
  } catch {
    // No error detail here. pg's messages carry the host, port and database
    // name from the connection string, and nothing authenticates this response.
    // The full message is on /api/health/detail.
    return Response.json({ ok: false, database: "unreachable", version: dashboardVersion() }, { status: 503, headers });
  }
}
