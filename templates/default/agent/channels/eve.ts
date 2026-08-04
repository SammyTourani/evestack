import { httpBasic, localDev } from "eve/channels/auth";
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
 * `localDev()` goes first so `eve dev` needs no credentials on your own
 * machine; HTTP Basic sits underneath it for everything else.
 *
 * ─ A note on why this file used to be longer ─
 *
 * On eve 0.29.x, `localDev()` decided "is this my machine" from the request's
 * Host header, using an unanchored `/^127\./` plus `endsWith(".localhost")`.
 * Host is attacker-controlled, so `127.evil.com` — a name anyone can register
 * and point at your agent — was handed a full local-dev principal with no
 * credentials. We measured it: that Host answered 200 where a plain foreign
 * host answered 401. This template shipped a `strictLocalDev()` wrapper that
 * narrowed the match to literal loopback names.
 *
 * eve 0.30.0 fixed it properly upstream: `localDev()` now grants based on the
 * deployment being an `eve dev` / `vercel dev` process rather than on anything
 * in the request, and `isLoopbackRequest` was removed. Keeping our wrapper on
 * 0.30 would be worse than useless — it can no longer add protection, and it
 * would reject legitimate local-dev access over a LAN IP, a tunnel, or a
 * container hostname. So it is gone, and the package pins eve ^0.30.2.
 *
 * If you are pinned to eve 0.29.x for some reason, you still need that guard:
 * see git history for the version this replaced.
 */
const username = process.env.EVESTACK_AUTH_USER;
const password = process.env.EVESTACK_AUTH_PASSWORD;

export default eveChannel({
  auth: [
    localDev(),
    ...(username && password
      ? [httpBasic({ username, password }, { realm: "evestack" })]
      : []),
  ],
});
