import { evaluateAlerts } from "@/lib/alerts";
import { deliverOnce, deliveryStatus } from "@/lib/alert-delivery";
import { handleRouteError, jsonOk } from "../control/_http";

export const dynamic = "force-dynamic";

/**
 * GET /api/alerts — the nine monitors and whether anyone is being told.
 *
 * Same reasoning as /api/fleet: "is anything wrong right now" is a question
 * worth answering from a terminal, from @evestack/mcp, or from another
 * monitoring system entirely. A self-hosted install is allowed to have opinions
 * about where its alerts go, and the honest way to support that is to make the
 * evaluation readable rather than to grow a plugin interface.
 *
 * The delivery block is included on purpose. An integration that reports the
 * alerts but not whether they are being delivered lets a reader conclude from a
 * quiet channel that nothing is wrong, when the truth may be that nothing is
 * configured.
 *
 * Authenticated by proxy.ts, like everything not named in `tierFor`.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const [alerts, delivery] = await Promise.all([evaluateAlerts(), deliveryStatus()]);
    return jsonOk({
      alerts,
      delivery,
      counts: {
        firing: alerts.filter((a) => a.state === "firing").length,
        unknown: alerts.filter((a) => a.state === "unknown").length,
        ok: alerts.filter((a) => a.state === "ok").length,
      },
    });
  } catch (error) {
    return handleRouteError(error, request);
  }
}

/**
 * POST /api/alerts — run one delivery tick now.
 *
 * This exists so that "did my webhook work?" is answerable in one request
 * instead of by waiting for an incident. Setting up a webhook and finding out
 * whether it was right the next time production breaks is not a setup
 * experience; it is a second incident.
 *
 * `force` skips the inter-instance lease, because the operator asking is not the
 * timer and should not be told "another replica has the lease, try later". It
 * does NOT skip the transition rules: a forced tick on a healthy install sends
 * nothing and says so, which is the correct answer to "test my webhook" when
 * there is genuinely nothing to report. `?test=1` is the way to prove the
 * transport itself — see below.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);

    if (url.searchParams.get("test") === "1") {
      const { sendTestNotification } = await import("@/lib/alert-delivery");
      const result = await sendTestNotification();
      return jsonOk({ test: true, ...result });
    }

    const outcome = await deliverOnce({ force: true });
    return jsonOk({
      evaluated: outcome.evaluated,
      sent: outcome.sent,
      skipped: outcome.skipped,
      failures: outcome.failures,
      transitions: outcome.planned.map((t) => ({
        id: t.alert.id,
        kind: t.kind,
        from: t.from,
        to: t.to,
      })),
    });
  } catch (error) {
    return handleRouteError(error, request);
  }
}
