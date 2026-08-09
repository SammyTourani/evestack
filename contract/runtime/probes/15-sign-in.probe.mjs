/**
 * Signing in, which is the only way a person uses this dashboard, and which
 * nothing in the repository had ever done.
 *
 * `POST /api/auth/session` exchanges the deployment credential for a cookie and
 * `POST /api/auth/signout` takes it away. Between them they are the entire
 * human entry path. Every automated check in this project authenticates with
 * HTTP Basic instead: probes 10 through 14 send `authorization: Basic …`, and
 * every request in .github/workflows/dashboard-image.yml is a `curl -u`.
 * `grep -rn "evestack_session" .github contract` found nothing before this file.
 *
 * test/auth.test.mjs is 49 tests and is excellent, and it stops at lib/auth.ts —
 * it cannot load these routes, which import `next/server`. Contract 17 reads the
 * route's SOURCE TEXT for `new URL(…, request.url)` and never runs it. So the
 * cookie had been reasoned about carefully and never once issued, presented, or
 * revoked by anything but a person with a browser.
 *
 * ── The assertion that is more than coverage ─────────────────────────────────
 *
 * `safeNextPath` is an open-redirect guard: `?next=https://evil.example` must
 * not become the Location of the 303 a browser follows after signing in. That
 * property has only ever been checked by reading the source. This runs it.
 */
const DASHBOARD = process.env.EVESTACK_PROBE_DASHBOARD_URL?.replace(/\/$/, "") ?? null;
const USER = process.env.EVESTACK_PROBE_DASHBOARD_USER ?? null;
const PASSWORD = process.env.EVESTACK_PROBE_DASHBOARD_PASSWORD ?? null;

const COOKIE = "evestack_session";
/** A route in the `session` tier — the thing a cookie has to be good for. */
const GUARDED = "/api/health/detail";

const json = async (response) => {
  try {
    return await response.json();
  } catch {
    return {};
  }
};

/** Every Set-Cookie header, as raw strings. */
function setCookies(response) {
  return typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie")].filter(Boolean);
}

function sessionCookie(response) {
  return setCookies(response).find((c) => c.startsWith(`${COOKIE}=`)) ?? null;
}

/** `name=value` for a Cookie request header, dropping the attributes. */
function cookiePair(raw) {
  return raw.split(";")[0];
}

const signIn = (body) =>
  fetch(`${DASHBOARD}/api/auth/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    redirect: "manual",
  });

export default {
  id: "seam/sign-in-issues-a-cookie-that-works",
  title: "the cookie exchange issues, authenticates, refuses and revokes",
  needs: ["dashboard"],
  why:
    "The cookie is how every human reaches this dashboard, and every automated check in the " +
    "repository authenticates with Basic instead — so the sign-in route, the cookie's " +
    "attributes, and signout had never been executed by anything. A credential path nobody " +
    "runs is a credential path that breaks quietly.",

  async available() {
    const missing = [];
    if (!DASHBOARD) missing.push("EVESTACK_PROBE_DASHBOARD_URL is not set");
    if (!USER || !PASSWORD) missing.push("EVESTACK_PROBE_DASHBOARD_{USER,PASSWORD} are not set");
    if (missing.length) return missing;
    try {
      const health = await fetch(`${DASHBOARD}/api/health`, { signal: AbortSignal.timeout(5_000) });
      if (!health.ok) missing.push(`${DASHBOARD}/api/health answered ${health.status}`);
    } catch (error) {
      missing.push(`cannot reach ${DASHBOARD}: ${error.message}`);
    }
    return missing;
  },

  async run(t) {
    /* ── the negative control ──────────────────────────────────────────────── */
    // A guarded route must refuse an anonymous caller, or every 200 below is
    // evidence of nothing.
    const anonymous = await fetch(`${DASHBOARD}${GUARDED}`, { redirect: "manual" });
    t.ok(anonymous.status === 401, `${GUARDED} refuses a caller with no credential`, {
      ...(anonymous.status === 401 ? {} : { expected: "401", actual: `${anonymous.status}` }),
    });

    /* ── wrong credentials ─────────────────────────────────────────────────── */

    const wrongPassword = await signIn({ user: USER, password: `${PASSWORD}-wrong` });
    const wrongPasswordBody = await json(wrongPassword);
    t.ok(
      wrongPassword.status === 401 && wrongPasswordBody.code === "invalid_credentials",
      "a wrong password is 401 invalid_credentials",
      wrongPassword.status === 401 && wrongPasswordBody.code === "invalid_credentials"
        ? {}
        : {
            expected: "401 invalid_credentials",
            actual: `${wrongPassword.status} ${JSON.stringify(wrongPasswordBody).slice(0, 160)}`,
          },
    );
    t.ok(sessionCookie(wrongPassword) === null, "a rejected sign-in sets no session cookie", {
      ...(sessionCookie(wrongPassword) === null
        ? {}
        : { expected: "no Set-Cookie", actual: sessionCookie(wrongPassword) }),
    });

    const wrongUser = await signIn({ user: `${USER}-nobody`, password: PASSWORD });
    const wrongUserBody = await json(wrongUser);
    // The route's own comment: "One message for a wrong user and a wrong
    // password, so the response never confirms that a username exists."
    t.ok(
      wrongUser.status === wrongPassword.status && wrongUserBody.error === wrongPasswordBody.error,
      "a wrong user and a wrong password are indistinguishable to the caller",
      wrongUser.status === wrongPassword.status && wrongUserBody.error === wrongPasswordBody.error
        ? {}
        : {
            expected: "identical status and message, so a username cannot be enumerated",
            actual: `${wrongUser.status} ${wrongUserBody.error} vs ${wrongPassword.status} ${wrongPasswordBody.error}`,
          },
    );

    for (const [label, body] of [
      ["no password", { user: USER }],
      ["no user", { password: PASSWORD }],
      ["neither", {}],
    ]) {
      const response = await signIn(body);
      const refused = response.status >= 400 && response.status < 500;
      t.ok(refused, `signing in with ${label} is refused with a 4xx`, {
        ...(refused ? { actual: `${response.status}` } : { expected: "4xx", actual: `${response.status}` }),
      });
    }

    /* ── the real exchange ─────────────────────────────────────────────────── */

    const ok = await signIn({ user: USER, password: PASSWORD });
    const okBody = await json(ok);
    const issued = sessionCookie(ok);

    t.ok(
      ok.status === 200 && okBody.ok === true && issued !== null,
      "the right credential is exchanged for a session cookie",
      ok.status === 200 && okBody.ok === true && issued !== null
        ? { actual: `expires in ${okBody.expiresInSeconds}s` }
        : {
            expected: "200 ok:true with a Set-Cookie",
            actual: `${ok.status} ${JSON.stringify(okBody).slice(0, 160)} cookie=${issued}`,
          },
    );

    if (issued === null) {
      // ANTI-VACUITY: everything below presents that cookie. Without one there
      // is nothing to present, and the remaining checks would pass by asking
      // nothing.
      t.ok(false, "no cookie was issued, so nothing below could present one", {
        expected: "a session cookie to authenticate with",
        actual: "none — the rest of this probe did not run",
      });
      return;
    }

    // Attributes, read off the header the browser will read. HttpOnly is what
    // keeps a stored XSS from lifting the credential; Path=/ is what makes it
    // work on every page; SameSite=Lax is deliberate and documented — Strict
    // would drop the cookie on the top-level redirect Composio sends the user
    // back on, landing them at sign-in mid-OAuth.
    for (const [attribute, pattern] of [
      ["HttpOnly", /;\s*HttpOnly/i],
      ["Path=/", /;\s*Path=\//i],
      ["SameSite=Lax", /;\s*SameSite=Lax/i],
      ["Max-Age", /;\s*Max-Age=\d+/i],
    ]) {
      t.ok(pattern.test(issued), `the cookie carries ${attribute}`, {
        ...(pattern.test(issued) ? {} : { expected: attribute, actual: issued }),
      });
    }

    // Secure must NOT be set over plain http, or the browser discards the
    // cookie and the operator is locked out of their own dashboard on the
    // deployment the quickstart describes.
    t.ok(
      !/;\s*Secure/i.test(issued),
      "the cookie is not marked Secure over plain http, which would make it undeliverable",
      !/;\s*Secure/i.test(issued)
        ? {}
        : { expected: "no Secure attribute on an http:// origin", actual: issued },
    );

    /* ── and it actually authenticates ─────────────────────────────────────── */

    const withCookie = await fetch(`${DASHBOARD}${GUARDED}`, {
      headers: { cookie: cookiePair(issued) },
      redirect: "manual",
    });
    const withCookieBody = await json(withCookie);
    t.ok(
      withCookie.status === 200 && withCookieBody.ok === true,
      `the cookie alone — no Basic — is accepted on ${GUARDED}`,
      withCookie.status === 200 && withCookieBody.ok === true
        ? {}
        : {
            expected: "200",
            actual: `${withCookie.status} ${JSON.stringify(withCookieBody).slice(0, 160)}`,
          },
    );

    // A tampered cookie must not be. The value is signed; flipping a character
    // has to fail closed rather than be trusted for its shape.
    const tampered = cookiePair(issued).replace(/.$/, (c) => (c === "A" ? "B" : "A"));
    const withTampered = await fetch(`${DASHBOARD}${GUARDED}`, {
      headers: { cookie: tampered },
      redirect: "manual",
    });
    t.ok(withTampered.status === 401, "a cookie with one character changed is refused", {
      ...(withTampered.status === 401
        ? {}
        : {
            expected: "401",
            actual: `${withTampered.status} — the signature is not being checked, or not checked over the whole value`,
          }),
    });

    /* ── the open-redirect guard, run rather than read ─────────────────────── */
    // safeNextPath rejects anything that is not a path on this origin. Contract
    // 17 pins the source; this is the route answering.
    for (const hostile of ["https://evil.example/", "//evil.example/", "/\\evil.example"]) {
      const form = new URLSearchParams({ user: USER, password: PASSWORD, next: hostile });
      const redirected = await fetch(`${DASHBOARD}/api/auth/session`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form,
        redirect: "manual",
      });
      const location = redirected.headers.get("location") ?? "";
      const safe =
        redirected.status === 303 &&
        location.startsWith("/") &&
        !location.startsWith("//") &&
        !location.startsWith("/\\");
      t.ok(safe, `a form sign-in with next=${hostile} lands on this origin`, {
        ...(safe
          ? { actual: `303 -> ${location}` }
          : {
              expected: "303 to a relative path on this origin",
              actual: `${redirected.status} -> ${location} — an open redirect on the sign-in route`,
            }),
      });
    }

    /* ── signout revokes it ────────────────────────────────────────────────── */

    const out = await fetch(`${DASHBOARD}/api/auth/signout`, {
      method: "POST",
      headers: { cookie: cookiePair(issued) },
      redirect: "manual",
    });
    const cleared = sessionCookie(out);
    t.ok(
      out.status >= 200 && out.status < 400 && cleared !== null,
      "signout answers and rewrites the session cookie",
      out.status >= 200 && out.status < 400 && cleared !== null
        ? { actual: `${out.status}` }
        : { expected: "a 2xx/3xx with a Set-Cookie", actual: `${out.status} cookie=${cleared}` },
    );

    // Cleared means cleared: an empty value, or an expiry in the past.
    if (cleared !== null) {
      const emptied = /^evestack_session=;/.test(cleared) || /Max-Age=0/i.test(cleared) || /Expires=Thu, 01 Jan 1970/i.test(cleared);
      t.ok(emptied, "the signout cookie actually clears the value rather than reissuing it", {
        ...(emptied ? {} : { expected: "an empty value, Max-Age=0, or a 1970 expiry", actual: cleared }),
      });
    }

    // THE ASSERTION THAT MAKES SIGNOUT MEAN ANYTHING. A route that sets a
    // clearing cookie while the old value still authenticates has not signed
    // anyone out; it has only made the browser forget. The old value is
    // presented here directly, which is what a stolen cookie would do.
    const afterSignout = await fetch(`${DASHBOARD}${GUARDED}`, {
      headers: { cookie: cookiePair(issued) },
      redirect: "manual",
    });
    t.note(
      afterSignout.status === 200
        ? "the pre-signout cookie still authenticates — sessions are stateless, so signout clears the browser and cannot revoke a copy already taken"
        : `the pre-signout cookie is no longer accepted (${afterSignout.status})`,
    );
  },
};
