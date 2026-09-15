import { NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  UNCONFIGURED_MESSAGE,
  authConfigured,
  isSecureRequest,
  issueSession,
  safeNextPath,
  verifyCredentials,
} from "@/lib/auth";
import { isResponse, readBoundedBody } from "../../control/_http";

export const dynamic = "force-dynamic";

/**
 * POST /api/auth/session — exchange the deployment credential for a cookie.
 *
 * The only route in the dashboard that reads a password. It answers a browser
 * form with a 303 back to wherever the user was headed, and a JSON caller with
 * JSON, so `curl -X POST -d '{"user":…,"password":…}' -c jar` is a working way
 * to script against the dashboard without repeating credentials on every call.
 *
 * There is no lockout. A counter keyed on a client-supplied address is a
 * denial-of-service handle — anyone can spend someone else's budget of attempts
 * — so the cost of a wrong guess is a delay that grows with consecutive
 * failures across the process and resets on the first success. That is enough
 * to make online guessing hopeless against the password `create-evestack`
 * generates: `randomBytes(18).toString("base64url")`
 * (packages/create-evestack/create.mjs:543), which is 24 characters of
 * base64url — 18 random bytes, 144 bits.
 *
 * This comment said "24 hex characters" until it was checked against the
 * generator. It is the right count of the wrong alphabet, and hex would make it
 * a much weaker claim than the truth: 24 hex characters is 12 bytes, 96 bits.
 * The digit that matters in a delay argument is the size of the space being
 * guessed, so a security note that understates it by 48 bits is not a typo.
 *
 * The 144-bit figure holds only for a generated password. An operator who edits
 * EVESTACK_AUTH_PASSWORD by hand can put anything there, and the growing delay
 * is the whole of what protects a short one.
 */

/**
 * The ceiling on a sign-in body.
 *
 * This is the one route in the dashboard that answers a caller who has proved
 * nothing — proxy.ts lets the sign-in tier through before it asks for a
 * credential, because there is no credential yet — and it read the body with
 * `request.json()` / `request.formData()`, neither of which stops. Anyone who
 * could open the port could therefore hold a chunked POST open and stream as
 * much as they liked into this process before the first password comparison
 * ran. Of everything reachable here that is the worst place for an unbounded
 * read, because it is the only one that needs no account.
 *
 * 16 KB, which is about fifty times what a sign-in carries: a username, a
 * password and a `next` path. Deliberately NOT tunable — unlike
 * EVESTACK_MAX_JSON_BODY_BYTES on the control tier there is no legitimate body
 * shape here that grows, so a knob could only ever be used to take the limit
 * off the one unauthenticated route in the building.
 */
const MAX_SIGN_IN_BODY_BYTES = 16 * 1024;

const BASE_FAILURE_DELAY_MS = 150;
const MAX_FAILURE_DELAY_MS = 2000;
/** Consecutive failures decay after this long, so a burst of typos this morning
 * is not still slowing sign-in down this afternoon. */
const FAILURE_DECAY_MS = 5 * 60_000;

let consecutiveFailures = 0;
let lastFailureAt = 0;

async function penalize(): Promise<void> {
  if (Date.now() - lastFailureAt > FAILURE_DECAY_MS) consecutiveFailures = 0;
  const delay = Math.min(MAX_FAILURE_DELAY_MS, BASE_FAILURE_DELAY_MS * 2 ** consecutiveFailures);
  consecutiveFailures += 1;
  lastFailureAt = Date.now();
  await new Promise((resolve) => setTimeout(resolve, delay));
}

export async function POST(request: Request): Promise<Response> {
  const wantsJson = (request.headers.get("content-type") ?? "").includes("application/json");

  if (!authConfigured()) {
    return wantsJson
      ? NextResponse.json(
          { ok: false, error: UNCONFIGURED_MESSAGE, code: "auth_unconfigured" },
          { status: 503, headers: { "cache-control": "no-store" } },
        )
      : back(request, "/signin", "unconfigured", "/");
  }

  // The body is read once, bounded, before either parser sees it — and before
  // penalize() can be reached, so an oversized body costs the sender the refusal
  // rather than costing this process the memory. See MAX_SIGN_IN_BODY_BYTES.
  const bytes = await readBoundedBody(request, MAX_SIGN_IN_BODY_BYTES);
  if (isResponse(bytes)) return bytes;

  let user = "";
  let password = "";
  let next = "/";

  if (wantsJson) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return NextResponse.json(
        { ok: false, error: "Invalid JSON body.", code: "bad_request" },
        { status: 400, headers: { "cache-control": "no-store" } },
      );
    }
    // Guarded rather than cast. `request.json()` returned whatever the JSON
    // held, and `body.user` on the literal body `null` — four bytes, and valid
    // JSON — threw a TypeError out of this handler, so the answer to the
    // shortest hostile request there is was a 500. Anything that is not an
    // object is now the same "both fields are required" 400 an object missing
    // them gets.
    const body: Record<string, unknown> =
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    user = typeof body.user === "string" ? body.user : "";
    password = typeof body.password === "string" ? body.password : "";
    next = safeNextPath(typeof body.next === "string" ? body.next : "/");
  } else {
    // Re-wrapped rather than `request.formData()`, because the body has already
    // been read by the bounded reader above and a Request body can only be read
    // once. Handing the bytes back with the caller's own content-type keeps the
    // boundary parameter intact, so urlencoded and multipart both parse exactly
    // as they did — and as bytes, not text, nothing is mangled by a decode.
    let form: FormData;
    try {
      form = await new Response(bytes, {
        headers: { "content-type": request.headers.get("content-type") ?? "" },
      }).formData();
    } catch {
      // A body that is neither JSON nor a parseable form is not a browser
      // submitting the sign-in page. This used to throw out of the handler as a
      // 500; it is a 400 now, and still says nothing about credentials.
      return NextResponse.json(
        { ok: false, error: "Invalid form body.", code: "bad_request" },
        { status: 400, headers: { "cache-control": "no-store" } },
      );
    }
    user = String(form.get("user") ?? "");
    password = String(form.get("password") ?? "");
    next = safeNextPath(String(form.get("next") ?? "/"));
  }

  if (!user || !password) {
    await penalize();
    return wantsJson
      ? NextResponse.json(
          { ok: false, error: "Both 'user' and 'password' are required.", code: "bad_request" },
          { status: 400, headers: { "cache-control": "no-store" } },
        )
      : back(request, "/signin", "missing", next);
  }

  if (!verifyCredentials(user, password)) {
    await penalize();
    // One message for a wrong user and a wrong password, so the response never
    // confirms that a username exists.
    return wantsJson
      ? NextResponse.json(
          { ok: false, error: "Invalid credentials.", code: "invalid_credentials" },
          { status: 401, headers: { "cache-control": "no-store" } },
        )
      : back(request, "/signin", "invalid", next);
  }

  const issued = issueSession(user);
  if (!issued) {
    return NextResponse.json(
      { ok: false, error: UNCONFIGURED_MESSAGE, code: "auth_unconfigured" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  consecutiveFailures = 0;

  const response = wantsJson
    ? NextResponse.json(
        { ok: true, user, expiresInSeconds: issued.maxAgeSeconds },
        { headers: { "cache-control": "no-store" } },
      )
    : seeOther(next);

  response.cookies.set({
    name: SESSION_COOKIE,
    value: issued.value,
    httpOnly: true,
    // Lax, not Strict. Strict would drop the cookie on the top-level redirect
    // Composio sends the user back on after connecting an integration, landing
    // them on the sign-in page mid-OAuth. Lax still withholds the cookie from
    // every cross-site POST, which is the CSRF case that matters here.
    sameSite: "lax",
    secure: isSecureRequest(request),
    path: "/",
    maxAge: issued.maxAgeSeconds,
  });

  return response;
}

/**
 * A 303 to a path on THIS origin, as a relative Location.
 *
 * Never `NextResponse.redirect(new URL(path, request.url))`. Next builds
 * `request.url` from the address the server is BOUND to, and the Dockerfile runs
 * `next start --hostname 0.0.0.0`, so inside the shipped container that URL is
 * literally `http://0.0.0.0:4000/`. Every redirect out of a route handler
 * therefore pointed at 0.0.0.0 — and unlike the proxy, whose redirects Next
 * rewrites to a relative Location for us, a route handler emits exactly what it
 * is given.
 *
 * What that did to the one flow that matters: sign in with the CORRECT password,
 * get a valid cookie, and get sent to `http://0.0.0.0:4000/`. Measured on the
 * published image, following the redirect the way a browser does — final URL
 * `http://0.0.0.0:4000/`, final status **401 Not signed in**. The cookie was
 * issued for the host the user was actually on, 0.0.0.0 is a different origin,
 * so it is not sent back. Correct credentials, and the answer is that you are
 * not signed in. On any deployment whose published host port is not 4000 it is
 * worse: 0.0.0.0:4000 is some other service, or nothing at all.
 *
 * The 403 fixed in #3 had been hiding this, because nobody could get far enough
 * through sign-in to see it.
 *
 * A relative Location is not a workaround, it is the correct answer for a
 * same-origin redirect: RFC 7231 allows it, the browser resolves it against the
 * URL it actually dialled, and there is no host for us to get wrong. Anything
 * needing an ABSOLUTE url — an OAuth callback handed to a third party — must use
 * `publicOrigin()` from lib/auth.ts instead, which reads the request rather than
 * the bind address.
 *
 * `safeNextPath` has already guaranteed the argument starts with a single "/",
 * so this cannot be turned into a protocol-relative jump to another site.
 */
function seeOther(location: string): NextResponse {
  return new NextResponse(null, {
    status: 303,
    headers: { location, "cache-control": "no-store" },
  });
}

function back(_request: Request, path: string, error: string, next: string): Response {
  const query = new URLSearchParams({ error });
  if (next !== "/") query.set("next", next);
  return seeOther(`${path}?${query}`);
}
