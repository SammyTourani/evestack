import { MetricQueryError, runMetricQuery } from "@/lib/metrics";
import { handleRouteError, isResponse, jsonError, jsonOk, readJsonObject } from "../../control/_http";

/**
 * POST /api/metrics/query — every chart in the dashboard, as one endpoint.
 *
 * The body is a config object shaped like Langfuse's — `{view, measures,
 * dimensions, filters, timeDimension, orderBy, limit}` — and `lib/metrics.ts`
 * is the only thing that turns it into SQL. There is deliberately no second
 * route and no builder: a chart is a body, and a new metric is a catalog entry
 * in that file. If adding one ever needs a change here, the design has failed.
 *
 * POST rather than GET even though this reads nothing. The body is a nested
 * object with arrays in it; as a query string it would be either a JSON blob in
 * a parameter or a bespoke encoding, and both are worse to debug than a body.
 * `proxy.ts` gates it like every other route — session tier, plus the
 * cross-site check every write gets, which costs a read-only route nothing
 * because the dashboard's own fetches are same-origin.
 *
 * No `export const dynamic = "force-dynamic"`, unlike its siblings, and that is
 * deliberate rather than forgotten: Next never prerenders a POST handler, so
 * the line is inert here. Measured — `next build` lists this route as `ƒ`
 * (dynamic) with and without it. A future GET added to this file would also be
 * dynamic by default, which is what Next 15 changed it back to.
 *
 * Two failure modes, kept apart on purpose. A request the caller can fix — an
 * unknown measure, a granularity that would produce 43,200 buckets, an operator
 * that does not apply to the field — is a 400 carrying the reason and the list
 * of names that would have worked. Anything else is the usual 500/503 path, so
 * "you asked for something that does not exist" never reads as "the database is
 * down".
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const body = await readJsonObject(request);
    if (isResponse(body)) return body;

    const result = await runMetricQuery(body);
    return jsonOk({ ...result });
  } catch (error) {
    if (error instanceof MetricQueryError) {
      return jsonError(error.message, 400, "bad_request");
    }
    return handleRouteError(error, request);
  }
}
