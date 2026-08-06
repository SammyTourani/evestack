import { NextResponse } from "next/server";
import { SESSION_COOKIE, isSecureRequest } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * POST /api/auth/signout — drop the session cookie.
 *
 * POST rather than GET so a link prefetch or an `<img>` cannot sign the
 * operator out. It is reachable without a session on purpose: clearing a cookie
 * you may not have is harmless, and gating it would mean answering "sign me
 * out" with "sign in first".
 *
 * Expiring the cookie is the whole of it — there is no server-side session
 * table to revoke against. That is the honest cost of a stateless signed
 * cookie: a copy stolen before sign-out stays valid until it expires, and the
 * way to kill every outstanding cookie at once is to change
 * EVESTACK_AUTH_PASSWORD (or EVESTACK_SESSION_SECRET), because the signing key
 * is derived from it.
 */
export async function POST(request: Request): Promise<Response> {
  const response = NextResponse.redirect(new URL("/signin", request.url), {
    status: 303,
    headers: { "cache-control": "no-store" },
  });

  response.cookies.set({
    name: SESSION_COOKIE,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure: isSecureRequest(request),
    path: "/",
    maxAge: 0,
  });

  return response;
}
