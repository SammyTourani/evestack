import { type AuthFn, httpBasic, localDev } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

/**
 * Route auth. eve fails closed: anything not matched here gets a 401.
 *
 * The stock `eve init` template ships `vercelOidc()` and `placeholderAuth()`.
 * Both are wrong off Vercel — vercelOidc only verifies Vercel-issued tokens,
 * and placeholderAuth explicitly refuses browser traffic in production. So we
 * replace them with HTTP Basic, whose credentials `create-evestack` generates
 * for you and writes to .env.local.
 *
 * The loopback bypass goes first so `eve dev` needs no credentials on your own
 * machine; HTTP Basic sits underneath it for everything else.
 */

/**
 * Hostnames that mean "this machine", matched exactly.
 *
 * eve's own `localDev()` decides this with an unanchored `/^127\./` plus
 * `endsWith(".localhost")` over the Host header. Neither is as narrow as it
 * reads: `127.evil.com`, `127.0.0.1.evil.com` and `evil.localhost` are all names
 * someone else can register and point at your agent, and each one is handed a
 * full `local-dev` principal with no credentials. Measured against eve 0.29.5 —
 * a request carrying `Host: 127.evil.com` was answered 200 where `Host:
 * evil.example.com` was correctly 401.
 *
 * Host is attacker-controlled, so it can only ever be used to *deny*. This
 * narrows the match to literal loopback names and then defers to eve for the
 * principal itself. Anything else falls through to HTTP Basic.
 */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const LOOPBACK_IPV4 = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (LOOPBACK_HOSTNAMES.has(host)) return true;
  const octets = LOOPBACK_IPV4.exec(host);
  return octets !== null && octets.slice(1).every((octet) => Number(octet) <= 255);
}

function strictLocalDev(): AuthFn<Request> {
  const grant = localDev();
  return (request) => {
    let hostname: string;
    try {
      hostname = new URL(request.url).hostname;
    } catch {
      return null;
    }
    return isLoopbackHostname(hostname) ? grant(request) : null;
  };
}

const username = process.env.EVESTACK_AUTH_USER;
const password = process.env.EVESTACK_AUTH_PASSWORD;

export default eveChannel({
  auth: [
    strictLocalDev(),
    ...(username && password
      ? [httpBasic({ username, password }, { realm: "evestack" })]
      : []),
  ],
});
