import { OTLPHttpJsonTraceExporter, registerOTel } from "@vercel/otel";
import { defineInstrumentation } from "eve/instrumentation";

/**
 * Ships traces to the evestack dashboard.
 *
 * A TRADE-OFF WORTH KNOWING: the mere existence of this file disables eve's
 * zero-config local trace spool (`.eve/traces/v1`), which is what `eve traces`
 * reads. eve hands control to authored instrumentation and does not install its
 * own writer alongside it. Delete this file to get `eve traces` back.
 *
 * That is an acceptable trade here because the dashboard supersedes the spool:
 * it keeps history past the spool's bounded retention (7 days / 512 MB / 20
 * traces), and it survives `eve dev` exiting.
 *
 * JSON, not protobuf: the dashboard's ingest route parses OTLP/HTTP JSON, so
 * OTLPHttpProtoTraceExporter — the exporter eve's own `instrumentation/jaeger`
 * registry item uses — would post bytes the endpoint cannot read.
 *
 * With EVESTACK_DASHBOARD_URL unset we register nothing, so an agent running
 * without the dashboard pays no exporter cost and fails no exports.
 */

/**
 * The header the dashboard reads.
 *
 * Must match `INGEST_TOKEN_HEADER` in packages/dashboard/lib/auth.ts byte for
 * byte — `ingestAuthorized()` does `request.headers.get(INGEST_TOKEN_HEADER)`
 * and compares the value in constant time. There is no negotiation and no
 * second spelling: a typo here is a 401 on every span, and (see below) a 401 on
 * every span is invisible unless something goes looking for it.
 *
 * `Authorization: Bearer <token>` is accepted by that route as well, but the
 * dedicated header is what the docs and the dashboard's own curl examples use,
 * and it does not collide with the Basic credentials the same deployment sends
 * everywhere else.
 */
const INGEST_TOKEN_HEADER = "x-evestack-ingest-token";

const endpoint = process.env.EVESTACK_DASHBOARD_URL?.trim();

/**
 * The shared secret. Optional here and required by the dashboard whenever the
 * dashboard has one — the two sides must hold the SAME value.
 *
 * Trimmed, and blank counts as unset, because `EVESTACK_INGEST_TOKEN=` on its
 * own line in .env.local is a variable someone meant to fill in, not a secret
 * equal to the empty string.
 */
const ingestToken = process.env.EVESTACK_INGEST_TOKEN?.trim();

export default defineInstrumentation({
  setup: ({ agentName }) => {
    if (!endpoint) {
      // A token with nowhere to send it is a half-finished setup, and the only
      // symptom otherwise is the absence of traces nobody asked for yet.
      if (ingestToken) {
        console.warn(
          "[evestack:traces] EVESTACK_INGEST_TOKEN is set but EVESTACK_DASHBOARD_URL is not, " +
            "so no exporter is registered and the token does nothing. Set " +
            "EVESTACK_DASHBOARD_URL=http://localhost:4000/api/ingest/v1/traces to export traces.",
        );
      }
      return;
    }

    registerOTel({
      serviceName: agentName,
      traceExporter: new OTLPHttpJsonTraceExporter({
        url: endpoint,
        // Spread rather than `{ [HEADER]: token ?? "" }`: with the variable
        // unset this sends no header at all, which is byte-for-byte the request
        // this exporter made before the dashboard grew an auth tier. An empty
        // header would also be *accepted* by `ingestAuthorized()` — it trims to
        // "" and falls through — but "send the credential header, empty" is a
        // shape someone reading a packet capture has to reason about, and
        // "don't send it" is not.
        ...(ingestToken ? { headers: { [INGEST_TOKEN_HEADER]: ingestToken } } : {}),
      }),
    });

    // Fire-and-forget: nothing downstream waits on it, and a boot must not be
    // delayed by the dashboard being slow or absent.
    void reportIngestCredential(endpoint, ingestToken);
  },
  // Prompts and tool results are the reason to open a trace at all — without
  // them the dashboard can show that a turn happened but not what it did.
  // Set both false for sensitive or regulated data.
  recordInputs: process.env.EVESTACK_TRACE_CONTENT !== "off",
  recordOutputs: process.env.EVESTACK_TRACE_CONTENT !== "off",
});

/**
 * Say out loud, once at boot, whether this exporter's credential is accepted.
 *
 * WHY THIS IS NOT REDUNDANT WITH THE EXPORTER'S OWN ERROR HANDLING: there is no
 * such error handling. @vercel/otel's fetch-based OTLP exporter does
 *
 *   fetch(url, …)
 *     .then((res) => { diag.debug("otlp: onSuccess", res.status, res.statusText); onSuccess(); })
 *     .catch((err) => { diag.error("otlp: onError", err); onError(err); })
 *
 * and an HTTP 401 *resolves* that promise. So a rejected batch takes the
 * success branch, the exporter reports ExportResultCode.SUCCESS to the batch
 * processor, the spans are dropped, and nothing is retried. The status is
 * mentioned only at `debug` level, and @vercel/otel installs a diag logger at
 * all only when OTEL_LOG_LEVEL is set — which by default it is not. Three
 * layers of silence over the same 401.
 *
 * That is why a misconfigured token looks exactly like "no traces yet". One GET
 * against the same endpoint with the same credential is the cheapest way to
 * turn it back into a sentence someone can read. The dashboard's GET on this
 * path runs the identical `ingestAuthorized()` check and returns counts only,
 * so this probe proves the credential without writing anything.
 */
async function reportIngestCredential(url: string, token: string | undefined): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: token ? { [INGEST_TOKEN_HEADER]: token } : {},
      // Unref'd by Node, so a dashboard that never answers cannot hold the
      // process open at shutdown.
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error) {
    // Not an error: on a laptop the agent usually starts before the dashboard.
    // Spans still export, and the batch processor keeps trying. Say it once so
    // that an empty Traces tab has an explanation somewhere.
    console.warn(
      `[evestack:traces] could not reach ${url} at startup (${describe(error)}), so trace ` +
        "export is unverified. Expected if the dashboard is not running yet.",
    );
    return;
  }

  // Always drain the body: an unread response holds its socket open.
  const detail = (await response.text().catch(() => "")).trim().slice(0, 300);

  if (response.status === 401) {
    console.error(
      "[evestack:traces] the dashboard REJECTED this exporter's credential (401). No spans " +
        "will be stored, and the OTLP exporter reports every rejected batch as a success — so " +
        'the dashboard will look like "no traces yet" rather than like a broken credential. ' +
        (token
          ? "EVESTACK_INGEST_TOKEN here does not match the dashboard's EVESTACK_INGEST_TOKEN; " +
            "the two must be identical."
          : "EVESTACK_INGEST_TOKEN is not set here. With it unset the ingest route falls back " +
            "to the dashboard's session auth, which an exporter cannot satisfy. Set the SAME " +
            "value on both sides (`openssl rand -hex 32`).") +
        ` Restart the agent after changing it. Endpoint: ${url}` +
        (detail ? `\n[evestack:traces] dashboard said: ${detail}` : ""),
    );
    return;
  }

  if (!response.ok) {
    console.warn(
      `[evestack:traces] ${url} answered ${response.status} ${response.statusText} at startup. ` +
        "The credential is fine; the endpoint is not healthy yet (a 503 here is usually its " +
        "Postgres)." +
        (detail ? ` Dashboard said: ${detail}` : ""),
    );
    return;
  }

  // The only line here that reports success, and the reason it earns its place:
  // every other message this module can print is a warning, so a correctly
  // configured agent said nothing at all about the dashboard and the operator
  // had no way to tell "connected" from "not attempted". eve's own boot output
  // is a port number and three channel-idle notices; nothing in it names the
  // thing you are actually meant to open.
  console.log(
    `[evestack] dashboard connected — open ${new URL(url).origin} ` +
      "(sign in with EVESTACK_AUTH_USER / EVESTACK_AUTH_PASSWORD from .env.local). " +
      "`npm run verify` checks every part of the stack.",
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
