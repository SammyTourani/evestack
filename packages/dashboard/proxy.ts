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
    // browser rather than leaving the operator with a bare 503.
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
    if (ingestAuthorized(request)) return NextResponse.next();
    return NextResponse.json(
      { code: OTLP_UNAUTHENTICATED, message: INGEST_UNAUTHENTICATED_MESSAGE },
      { status: 401, headers: NO_STORE },
    );
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
