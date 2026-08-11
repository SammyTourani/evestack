import { UNCONFIGURED_MESSAGE, authConfigured } from "@/lib/auth";
import { query } from "@/lib/db";
import { schemaVersionsAhead } from "@/lib/facts";
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
 *
 * That last sentence is why there are now three not-ok states rather than two.
 * The third is `degraded / schema-too-new`: the database has been migrated by a
 * NEWER evestack than this image, so sql/traces.sql and sql/facts.sql refuse to
 * apply (SQLSTATE EV001), every page reading spans or the fact tables fails, and
 * OTLP ingest answers 503 to every batch. Measured on a real install: a
 * container in exactly that state reported HEALTHY for two hours while its
 * resolver had been silently replaced and its trace pages were empty. It is
 * `degraded` and not a flat failure because half the product genuinely still
 * works — the `workflow` tables are untouched — and the body says which half.
 */
/**
 * Components the database is ahead on, or an empty list if the question could
 * not be asked.
 *
 * Swallowing rather than throwing: an unreadable sql/ directory is a broken
 * install, but reporting it through the catch below would answer "database
 * unreachable", which is a confident wrong answer about the healthy half. The
 * comparison is skipped, loudly, and the other checks still run.
 */
async function versionsAhead(): Promise<{ ahead: string[]; unavailable: string | null }> {
  try {
    return { ahead: await schemaVersionsAhead(), unavailable: null };
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    console.warn(
      "[evestack] /api/health could not compare its schema version against the database, so " +
        `it cannot tell you whether this image is older than that database: ${why}`,
    );
    // Returned as well as logged. A console.warn on the server is not an answer
    // to the caller: the body was an unqualified ok with no trace of a check
    // that did not run, which is the shape this route was already fixed for
    // once. `ok` stays true because the primary question was answered.
    return { ahead: [], unavailable: why };
  }
}
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
    /*
     * DEGRADED: the database is newer than this build understands.
     *
     * The container is up, Postgres is up, the schema is there, and this
     * dashboard is the thing that is out of date. sql/traces.sql and
     * sql/facts.sql refuse to apply against a marker ahead of their own
     * (SQLSTATE EV001), so every page that reads spans or the fact tables
     * fails and the OTLP ingest endpoint answers 503 to every batch.
     *
     * It is reported here because the alternative was measured: a container
     * in exactly this state answered `ok` on this endpoint for two hours
     * while its trace pages were empty and its resolver had been silently
     * replaced. This route already refuses to pretend for an unconfigured
     * install and for a missing schema; the same judgement applies.
     *
     * `degraded` and not a flat failure, because it is neither: /sessions,
     * /monitors and /approvals read the workflow tables and are unaffected.
     * The 503 is what marks the container — Docker reads the status, not the
     * body — and marking it is the point. An unhealthy HEALTHCHECK does not
     * restart anything, so this surfaces the mismatch without a crash loop.
     */
    const { ahead, unavailable } = await versionsAhead();
    if (ahead.length > 0) {
      return Response.json(
        {
          ok: false,
          database: "connected",
          status: "degraded",
          reason: "schema-too-new",
          version: dashboardVersion(),
          /*
           * Named, because "degraded" on its own tells an operator nothing
           * about which half of the product they can still trust.
           *
           * The rule, so these lists can be maintained rather than guessed at:
           * anything that applies sql/traces.sql or sql/facts.sql is refused,
           * and everything reading only the `workflow` tables is untouched.
           * /sessions calls refreshFacts() inside a try and degrades to blank
           * fact columns; /sessions/[id] does not, so the detail view goes with
           * the traces.
           *
           * `/charts` used to be the fifth entry in `available`, under a
           * sentence claiming every entry here had been checked against the
           * code and that /charts "is a static demo and stays up". Both halves
           * were false. app/charts/page.tsx:103 calls notFound() when NODE_ENV
           * is production — deliberately, it is a development gallery — so the
           * page this payload was advertising answers 404 on every image anyone
           * can pull, which the branch review proved on the published image, on
           * the merged image and on a container built by hand. It is not
           * degraded and it is not available; in a production build it is not
           * there at all, so it belongs to none of these lists.
           *
           * The claim of having been checked was the more expensive half of
           * that defect, because it is the reason nobody checked. So the claim
           * is gone and a check stands in its place:
           * test/blind-is-not-all-clear.test.mjs reads these lists out of this
           * route's own answer and opens the file that serves each one.
           */
          unavailable: [
            "/traces",
            "/sessions/[id]",
            "/costs",
            "/ (overview)",
            "/api/metrics/query",
            "/api/ingest/v1/traces",
          ],
          degradedButUp: ["/sessions"],
          available: ["/monitors", "/approvals", "/schedules", "/evals"],
          error:
            `This dashboard is older than its database (${ahead.join("; ")}). Nothing was ` +
            "migrated — an older image must leave a newer database alone. Pages that read " +
            "spans or the fact tables cannot be served and the OTLP ingest endpoint is " +
            "refusing spans with 503. Run the newer dashboard image.",
        },
        { status: 503, headers },
      );
    }
    return Response.json(
      {
        ok: true,
        database: "connected",
        version: dashboardVersion(),
        // Present only when a check did not run; its absence is the all-clear.
        ...(unavailable === null
          ? {}
          : { schemaComparison: "unavailable", schemaComparisonError: unavailable }),
      },
      { headers },
    );
  } catch {
    // No error detail here. pg's messages carry the host, port and database
    // name from the connection string, and nothing authenticates this response.
    // The full message is on /api/health/detail.
    return Response.json({ ok: false, database: "unreachable", version: dashboardVersion() }, { status: 503, headers });
  }
}
