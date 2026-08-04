import { httpBasic, localDev } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

/**
 * Route auth. eve fails closed: anything not matched here gets a 401.
 *
 * The stock `eve init` template ships `vercelOidc()` and `placeholderAuth()`.
 * Both are wrong off Vercel — vercelOidc only verifies Vercel-issued tokens,
 * and placeholderAuth explicitly refuses browser traffic in production. So we
 * replace them with HTTP Basic, whose credentials `create-evestack` generates
 * for you and writes to .env.
 *
 * localDev() first so `eve dev` on loopback needs no credentials. It only
 * matches loopback hostnames, so it cannot wave through public traffic — but
 * it does trust the Host header, which is why Basic sits underneath it rather
 * than being the only line of defense.
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
