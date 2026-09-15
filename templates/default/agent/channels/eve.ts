import { httpBasic, localDev } from "eve/channels/auth";
import { defaultEveAuth, eveChannel } from "eve/channels/eve";
import { handleSlashCommand } from "../../lib/dashboard-command";

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
 * container hostname. So it is gone, and the template pins an eve new enough
 * to carry the fix (0.30.0 is the floor; the pin itself moves with upstream).
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

  /**
   * Slash commands typed at the agent, handled before the model sees them.
   *
   * eve's terminal UI owns a fixed list of slash commands and passes anything it
   * does not recognise through as an ordinary message. This is where those land.
   * `/dashboard` opens the control plane from the host, deterministically, while
   * the model is still being asked — see lib/dashboard-command.ts for why that is
   * the only seam eve offers and what it can and cannot do.
   *
   * `defaultEveAuth(ctx)` is not optional here. Defining `onMessage` replaces the
   * default auth projection, and omitting it would hand every session a null
   * principal — the helper exists so a hook can add `context` without taking on
   * the auth decision as well.
   *
   * Every message pays one `Set` lookup for this, and nothing else: a message
   * that is not a command returns before any work is done.
   */
  async onMessage(ctx, message) {
    const auth = defaultEveAuth(ctx);
    const command = await handleSlashCommand(message);
    if (!command.handled) return { auth };
    return {
      auth,
      ...(command.context ? { context: command.context } : {}),
      ...(command.title ? { title: command.title } : {}),
    };
  },
});
