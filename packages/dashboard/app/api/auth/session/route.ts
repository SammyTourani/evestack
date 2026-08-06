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
 * to make online guessing hopeless against the 24 hex characters
 * `create-evestack` generates, and it cannot lock the operator out.
 */

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

  let user = "";
  let password = "";
  let next = "/";

  if (wantsJson) {
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json(
        { ok: false, error: "Invalid JSON body.", code: "bad_request" },
        { status: 400, headers: { "cache-control": "no-store" } },
      );
    }
    user = typeof body.user === "string" ? body.user : "";
    password = typeof body.password === "string" ? body.password : "";
    next = safeNextPath(typeof body.next === "string" ? body.next : "/");
  } else {
    const form = await request.formData();
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
    : NextResponse.redirect(new URL(next, request.url), {
        status: 303,
        headers: { "cache-control": "no-store" },
      });

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

function back(request: Request, path: string, error: string, next: string): Response {
  const target = new URL(path, request.url);
  target.searchParams.set("error", error);
  if (next !== "/") target.searchParams.set("next", next);
  return NextResponse.redirect(target, { status: 303, headers: { "cache-control": "no-store" } });
}
