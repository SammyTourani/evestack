/**
 * The contract that exists because of the bug that got away.
 *
 * On eve 0.29.x, `localDev()` decided "is this request from my own machine" by
 * looking at the request — `new URL(request.url).hostname` matched against an
 * unanchored `/^127\./` plus `endsWith(".localhost")`. In a server the request
 * URL is built from the client's Host header, so `127.evil.com` — a name anyone
 * can register and point at your agent — was handed a full local-dev principal
 * with no credentials at all. evestack shipped a `strictLocalDev()` wrapper to
 * narrow it.
 *
 * eve 0.30.0 fixed it upstream: the decision now comes from the process
 * (`EVE_DEV=1`, i.e. "this is an `eve dev` run"), and nothing in the request is
 * consulted. At that point our wrapper became actively harmful — it could add
 * no protection and would reject legitimate local-dev access over a LAN IP, a
 * tunnel, or a container hostname — so it was deleted.
 *
 * The wrapper typechecked perfectly on the day it became useless. A typecheck
 * cannot see semantic drift. This can:
 *
 *   run this contract against eve 0.29.5 and it goes red on `127.evil.com`.
 *   run it against 0.30.2 and it is green.
 *
 * Nothing else in this repo can tell those two apart.
 */

/**
 * Names an attacker can register and point at someone's agent. Each one either
 * matched eve 0.29.x's loopback heuristic outright or sits one character away
 * from a plausible re-introduction of it.
 */
const HOSTILE_HOSTS = [
  "127.evil.com", // matched the unanchored /^127\./
  "127.0.0.1.evil.com", // matched it too, and reads like loopback at a glance
  "127.0.0.1.nip.io", // wildcard DNS anyone can use; resolves, and matched too
  "evil.localhost", // matched endsWith(".localhost")
  "localhost.evil.com", // reads like loopback, is not
  "attacker.example.com", // plain foreign host, the control case
];

/**
 * Runs `body` with the given env applied and every key restored afterwards, so
 * a contract cannot leak dev-mode state into the ones that run after it.
 */
async function withEnv(overrides, body) {
  const saved = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await body();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Not a real dev process: no `eve dev`, no `vercel dev`. */
const NOT_A_DEV_PROCESS = { EVE_DEV: undefined, VERCEL: undefined, VERCEL_ENV: undefined };

function requestFrom(host) {
  // Both vectors at once: the URL hostname (what eve 0.29.x read) and the Host
  // header it is derived from. Whichever one a future eve consults, a hostile
  // value is present in it.
  return new Request(`http://${host}/eve/v1/session`, { headers: { host } });
}

function principalOf(result) {
  if (result === null || result === undefined) return null;
  if (result instanceof Response) return `HTTP ${result.status} response`;
  return `principal ${result.principalId ?? "?"} (type ${result.principalType ?? "?"}, via ${result.authenticator ?? "?"})`;
}

const localDevIgnoresRequest = {
  id: "auth/local-dev-must-not-trust-the-request",
  title: "localDev() grants on process state, never on anything the caller controls",
  assumption:
    "localDev() decides from the running process (EVE_DEV / vercel dev), and no Host header or URL hostname can make it grant.",
  evestackUse:
    "templates/default/agent/channels/eve.ts puts `localDev()` first in the auth chain of every scaffolded " +
    "agent, so that `eve dev` needs no credentials on your own machine, with HTTP Basic underneath it for " +
    "everything else. Every evestack agent is therefore exactly as exposed as localDev() is permissive. If " +
    "eve reintroduces a request-derived grant, anyone who can reach the agent's port gets an " +
    "unauthenticated local-dev principal — full session creation, full tool execution — by sending a Host " +
    "header. That is a remote authentication bypass in the default template, and it is what eve 0.29.5 " +
    "actually shipped. See the long comment in that file for the history.",

  async check(eve, t) {
    const auth = await eve.loadPublic("eve/channels/auth");
    t.equal(typeof auth.localDev, "function", "eve/channels/auth still exports localDev()");

    await withEnv(NOT_A_DEV_PROCESS, async () => {
      const authenticate = auth.localDev();
      for (const host of HOSTILE_HOSTS) {
        const result = await authenticate(requestFrom(host));
        t.ok(result === null || result === undefined, `localDev() denies a request claiming to come from "${host}"`, {
          ...(result === null || result === undefined
            ? {}
            : { expected: "no principal", actual: principalOf(result) }),
        });
      }
    });

    // The other half of the contract. Without this, localDev() returning null
    // unconditionally — a genuine regression that would break `eve dev` for
    // every user — would pass the assertions above.
    await withEnv({ ...NOT_A_DEV_PROCESS, EVE_DEV: "1" }, async () => {
      const granted = await auth.localDev()(requestFrom("attacker.example.com"));
      t.ok(
        granted !== null && granted !== undefined,
        "localDev() still grants inside an `eve dev` process, regardless of the request's host",
        granted ? {} : { expected: "a local-dev principal", actual: "no principal" },
      );
      t.equal(granted?.principalType, "local-dev", "the dev grant is still a `local-dev` principal");
    });
  },
};

const failsClosed = {
  id: "auth/http-basic-fails-closed",
  title: "httpBasic() rejects missing and wrong credentials",
  assumption: "eve's httpBasic() returns no principal without correct credentials, and eve 401s when no authenticator matches.",
  evestackUse:
    "HTTP Basic is the credential evestack generates at scaffold time and writes to .env.local " +
    "(EVESTACK_AUTH_USER / EVESTACK_AUTH_PASSWORD); it is the only thing standing between a self-hosted " +
    "agent and the internet once localDev() declines, and packages/dashboard authenticates to the agent " +
    "with it. `create-evestack` tells users this protects their agent. If it ever failed open — or if " +
    "routeAuth stopped 401ing when every authenticator declines — that promise would be false on every " +
    "install, and the CI assertion that .env.local carries a non-empty password would be guarding nothing.",

  async check(eve, t) {
    const auth = await eve.loadPublic("eve/channels/auth");
    const basic = auth.httpBasic({ username: "evestack", password: "correct-horse" }, { realm: "evestack" });
    const encode = (raw) => `Basic ${Buffer.from(raw).toString("base64")}`;

    await withEnv(NOT_A_DEV_PROCESS, async () => {
      const noHeader = await basic(new Request("http://agent.example/eve/v1/session"));
      t.ok(noHeader === null || noHeader === undefined, "httpBasic() denies a request with no Authorization header", {
        ...(noHeader ? { expected: "no principal", actual: principalOf(noHeader) } : {}),
      });

      const wrong = await basic(
        new Request("http://agent.example/eve/v1/session", {
          headers: { authorization: encode("evestack:wrong") },
        }),
      );
      t.ok(wrong === null || wrong === undefined, "httpBasic() denies a wrong password", {
        ...(wrong ? { expected: "no principal", actual: principalOf(wrong) } : {}),
      });

      const right = await basic(
        new Request("http://agent.example/eve/v1/session", {
          headers: { authorization: encode("evestack:correct-horse") },
        }),
      );
      t.ok(right !== null && right !== undefined, "httpBasic() grants on the configured credentials", {
        ...(right ? {} : { expected: "a principal", actual: "no principal" }),
      });
      t.equal(right?.principalId, "evestack", "the granted principal is identified by the configured username");

      // The chain as the template composes it: localDev() first, httpBasic()
      // underneath. Unauthenticated traffic must come back 401, not 200.
      const response = await auth.routeAuth(requestFrom("127.evil.com"), [basic]);
      const closed = response instanceof Response && response.status === 401;
      t.ok(
        closed,
        "routeAuth() answers 401 when every authenticator declines — eve still fails closed",
        closed
          ? {}
          : {
              expected: "401 response",
              actual: response instanceof Response ? `HTTP ${response.status}` : principalOf(response),
            },
      );
    });
  },
};

export default [localDevIgnoresRequest, failsClosed];
