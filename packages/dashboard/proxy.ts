import { NextResponse, type NextRequest } from "next/server";
import {
  INGEST_UNAUTHENTICATED_MESSAGE,
  UNCONFIGURED_MESSAGE,
  authConfigured,
  authenticate,
  ingestAuthorized,
  isCrossSiteWrite,
  safeNextPath,
  tierFor,
} from "@/lib/auth";

/**
 * The one gate every request goes through.
 *
 * WHY HERE AND NOT IN EACH HANDLER. Per-handler auth is opt-in, and opt-in auth
 * is a list someone forgets to add to. This file is opt-out: `tierFor` returns
 * "session" for every path it does not explicitly name, so a route added
 * tomorrow is protected before its author has thought about the question, and
 * the only way to open something up is to write it down here.
 *
 * WHY `proxy.ts` AND NOT `middleware.ts`. Next 16 renamed the convention.
 * Both filenames still resolve in 16.3.0 — but `middleware.ts` logs a
 * deprecation on every boot (next/dist/build/index.js warns "The middleware
 * file convention is deprecated"), and having both present is a hard build
 * error. Proxy runs on the Node.js runtime by default in 16, which is what lets
 * lib/auth.ts use `node:crypto` instead of pulling in a JWT dependency.
 */

/**
 * Everything except build output.
 *
 * `_next/` has to be excluded or the sign-in page cannot load the stylesheet it
 * is rendered with — an auth wall that blocks its own CSS looks like a broken
 * server. It holds compiled assets and nothing about a session, so this costs
 * no secrecy. Note the shape: this is an exclusion list, not an inclusion list,
 * so forgetting to add a path here fails closed.
 */
export const config = {
  matcher: ["/((?!_next/|favicon\\.ico).*)"],
};

const NO_STORE = { "cache-control": "no-store" };

const CROSS_SITE =
  "Cross-site writes are refused. This request carried a browser origin that is not this " +
  "dashboard's.";

/** google.rpc.Code 16, UNAUTHENTICATED. The ingest route answers in OTLP's error
 * vocabulary rather than the dashboard's, because its callers are exporters. */
const OTLP_UNAUTHENTICATED = 16;

export default function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  const tier = tierFor(pathname);

  // Liveness first, before the configuration check, so Docker's HEALTHCHECK can
  // still reach the route that is going to tell it what is wrong. The handler
  // decides what to report; see app/api/health/route.ts.
  if (tier === "liveness") return NextResponse.next();

  if (!authConfigured()) {
    // The sign-in page is allowed through so it can explain the problem in a
    // browser rather than leaving the operator with a bare 503. The exception is
    // the whole sign-in TIER and only its GETs, so three paths pass here, not
    // one: `/signin` renders (with no form — app/signin/page.tsx branches on
    // authConfigured()), and `/api/auth/session` and `/api/auth/signout` export
    // POST only, so Next's route module answers them with a bare 405. Every POST
    // in this tier, sign-in included, takes the 503 below.
    if (tier === "sign-in" && request.method === "GET") return NextResponse.next();
    return deny(request, UNCONFIGURED_MESSAGE, 503, "auth_unconfigured");
  }

  if (tier === "sign-in") {
    // Signing in is a write and is worth the same cross-site check as any
    // other, so a third-party page cannot submit the form on the user's behalf.
    if (isCrossSiteWrite(request)) return deny(request, CROSS_SITE, 403, "cross_site");
    return NextResponse.next();
  }

  if (tier === "ingest") {
    const ingest = ingestAuthorized(request);
    if (ingest === null) {
      return NextResponse.json(
        { code: OTLP_UNAUTHENTICATED, message: INGEST_UNAUTHENTICATED_MESSAGE },
        { status: 401, headers: NO_STORE },
      );
    }

    // A credential is not the whole question on a write, and this tier used to
    // act as though it were: it returned `NextResponse.next()` the moment
    // `ingestAuthorized` said yes, which made ingest the only write tier in the
    // dashboard reached without the check the sign-in tier above and the session
    // tier below both run. `ingestAuthorized` accepts the operator's cookie as
    // well as the shared token — on every deployment, configured token or not —
    // so "authorised" here can mean nothing more than "a browser was logged in".
    //
    // THE MECHANISM, because SameSite=Lax reads like it already covers this and
    // does not. Lax withholds the cookie from a cross-SITE POST, and a site is
    // scheme + registrable domain: THE PORT IS NOT PART OF IT. Any other server
    // on the operator's own machine — a dev server on http://localhost:3000, a
    // preview of something they cloned — is same-site with the dashboard on
    // :4000, so the cookie is attached to its writes. A page there needs no
    // preflight to reach us either: `fetch(url, {method:"POST",
    // credentials:"include", headers:{"content-type":"text/plain"}, body:
    // json})` is a CORS-simple request. The attacker cannot read the reply, and
    // does not need to — the span is already stored by then.
    //
    // WHAT A FORGED BATCH IS WORTH. `insertSpans` in lib/traces.ts upserts on
    // (trace_id, span_id) — DO UPDATE, not DO NOTHING. So a forged POST is not
    // only "extra rows in the Traces tab": it can rewrite the prompt and the
    // tool result on spans that already exist, which are what the session page
    // shows the operator while they decide whether to approve a tool call.
    //
    // The token door skips the check, and giving that up would cost more than it
    // buys. Presenting `x-evestack-ingest-token` or an `Authorization` header
    // makes a request non-simple, so a browser preflights it, and this dashboard
    // answers no preflight at all — there is no Access-Control-Allow-Origin
    // anywhere in it — so that fetch never becomes a POST. A real OTLP exporter
    // is not a browser and sends neither Origin nor Sec-Fetch-Site, so it takes
    // the early return inside isCrossSiteWrite and is unaffected either way;
    // `curl -u`, which lands here as "basic", is in the same position.
    //
    // Answered in the dashboard's vocabulary rather than OTLP's, unlike the 401
    // above: the only caller that can reach this line is a page in a browser,
    // and a google.rpc.Status is for the exporters that cannot.
    if (ingest.via !== "token" && isCrossSiteWrite(request)) {
      return deny(request, CROSS_SITE, 403, "cross_site");
    }

    return NextResponse.next();
  }

  if (authenticate(request) === null) {
    if (wantsHtml(request)) {
      const target = new URL("/signin", request.url);
      target.searchParams.set("next", safeNextPath(pathname + request.nextUrl.search));
      return NextResponse.redirect(target, 303);
    }
    // Deliberately no `WWW-Authenticate: Basic` header. It would make the
    // browser throw up its own credential dialog on every background fetch from
    // the chat page, which cannot be dismissed into a usable state. `curl -u`
    // sends Basic pre-emptively and needs no challenge.
    return deny(
      request,
      "Not signed in. Open /signin in a browser, or send the EVESTACK_AUTH_USER / " +
        "EVESTACK_AUTH_PASSWORD pair as HTTP Basic (`curl -u user:password`).",
      401,
      "unauthenticated",
    );
  }

  if (isCrossSiteWrite(request)) return deny(request, CROSS_SITE, 403, "cross_site");

  return NextResponse.next();
}

function deny(request: NextRequest, error: string, status: number, code: string): NextResponse {
  if (wantsHtml(request)) {
    // A browser navigation gets prose, because a raw JSON body in the address
    // bar is how a configuration problem turns into a bug report.
    return new NextResponse(`${error}\n`, {
      status,
      headers: { "content-type": "text/plain; charset=utf-8", ...NO_STORE },
    });
  }
  return NextResponse.json({ ok: false, error, code }, { status, headers: NO_STORE });
}

/** A top-level browser navigation, as opposed to fetch/curl/an exporter. Both
 * signals are checked because `Sec-Fetch-Dest` is absent on older clients. */
function wantsHtml(request: NextRequest): boolean {
  if (request.method !== "GET") return false;
  if (request.headers.get("sec-fetch-dest") === "document") return true;
  if (request.headers.get("sec-fetch-mode") === "navigate") return true;
  return (request.headers.get("accept") ?? "").includes("text/html");
}
