/**
 * The three chat channels fail closed on inbound requests.
 *
 * Every scaffolded agent mounts POST /eve/v1/telegram, /eve/v1/slack and
 * /eve/v1/discord, and none of the three sits behind EVESTACK_AUTH_* — that
 * policy covers /eve/v1/session only, because no chat provider can send Basic
 * credentials. Each route carries its own inbound verification instead, and the
 * template's own comments state exactly what that is: a constant-time compare of
 * Telegram's secret-token header, Slack's HMAC over `v0:{timestamp}:{body}`, and
 * Discord's Ed25519 signature over `timestamp + body`.
 *
 * Every word of that was an ASSUMPTION about eve's behaviour, asserted in a
 * comment and checked by nothing. These routes need a public HTTPS URL to be
 * driven by the real providers, which is presumably why they were never covered —
 * but that prerequisite is for OUTBOUND registration. Inbound is just a POST, so
 * a probe can absolutely reach it, and if any of these ever stops verifying, the
 * failure is a stranger's message dispatched to someone's agent as though it came
 * from their own chat.
 *
 * ─ No model call, deliberately ─
 *
 * The runtime job runs with no model key on purpose: a probe that reaches a
 * provider is a cost, and on a maintainer's machine a real one. So each positive
 * case here is one the provider itself defines as a no-op handshake:
 *
 *   Discord  type 1 PING          answered with {"type":1}, dispatches nothing
 *   Slack    url_verification     answered with the challenge, dispatches nothing
 *   Telegram an update with no    accepted, and there is nothing to dispatch
 *            message in it
 *
 * Verified rather than assumed: the Telegram case was measured against a live
 * agent with `workflow.workflow_runs` counted before and after, and the count did
 * not move.
 */
import { sign as edSign, createPrivateKey, createHmac } from "node:crypto";

const AGENT = process.env.EVESTACK_PROBE_AGENT_URL;

async function post(path, headers, body) {
  const response = await fetch(new URL(path, AGENT), {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  return { status: response.status, text: (await response.text()).slice(0, 200) };
}

/** Every refusal must be a refusal, not a 404 from a route that is not mounted —
 *  an unmounted route would otherwise make this probe look green. */
function refused(t, label, result) {
  t.ok(
    result.status === 401 || result.status === 403,
    `${label} is refused (401/403)`,
    result.status === 401 || result.status === 403 ? {} : { actual: `HTTP ${result.status} ${result.text}` },
  );
}

export default {
  id: "channels/inbound-requests-are-verified-not-trusted",
  title: "telegram, slack and discord each verify inbound requests and fail closed",
  needs: ["agent"],
  why:
    "None of the three channel routes sits behind EVESTACK_AUTH_*, because no chat provider can send " +
    "Basic credentials. Each one's only protection is its own signature check, which the template " +
    "asserts in a comment and nothing tested. If one stops verifying, a stranger's POST is dispatched " +
    "to someone's agent as though it arrived from their own Slack.",

  async available() {
    const missing = [];
    if (!AGENT) missing.push("EVESTACK_PROBE_AGENT_URL is not set");
    if (!process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN) missing.push("TELEGRAM_WEBHOOK_SECRET_TOKEN is not set on the agent");
    if (!process.env.SLACK_SIGNING_SECRET) missing.push("SLACK_SIGNING_SECRET is not set on the agent");
    if (!process.env.EVESTACK_PROBE_DISCORD_PRIVATE_KEY) {
      missing.push("EVESTACK_PROBE_DISCORD_PRIVATE_KEY is not set (the signing half of DISCORD_PUBLIC_KEY)");
    }
    return missing;
  },

  async run(t) {
    /* ---- telegram: a shared secret in a header ---------------------------- */
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN;
    // An update with no message in it: structurally valid, authenticated, and
    // there is nothing for the agent to answer. Measured to start no run.
    const quietUpdate = JSON.stringify({ update_id: 1 });

    refused(t, "telegram with no secret-token header", await post("/eve/v1/telegram", {}, quietUpdate));
    refused(
      t,
      "telegram with the wrong secret token",
      await post("/eve/v1/telegram", { "x-telegram-bot-api-secret-token": `${secret}-wrong` }, quietUpdate),
    );
    const telegramOk = await post(
      "/eve/v1/telegram",
      { "x-telegram-bot-api-secret-token": secret },
      quietUpdate,
    );
    t.ok(telegramOk.status === 200, "telegram with the correct secret token is accepted", {
      ...(telegramOk.status === 200 ? {} : { actual: `HTTP ${telegramOk.status} ${telegramOk.text}` }),
    });

    /* ---- discord: Ed25519 over timestamp + body --------------------------- */
    const key = createPrivateKey(process.env.EVESTACK_PROBE_DISCORD_PRIVATE_KEY);
    const ping = JSON.stringify({ type: 1 });
    const now = String(Math.floor(Date.now() / 1000));
    const signature = edSign(null, Buffer.from(now + ping), key).toString("hex");
    const dHeaders = (sig, ts) => ({ "x-signature-ed25519": sig, "x-signature-timestamp": ts });

    refused(t, "discord with no signature", await post("/eve/v1/discord", {}, ping));
    refused(t, "discord with a wrong signature", await post("/eve/v1/discord", dHeaders("00".repeat(64), now), ping));

    const pong = await post("/eve/v1/discord", dHeaders(signature, now), ping);
    t.ok(
      pong.status === 200 && pong.text.includes('"type":1'),
      "discord answers a correctly signed PING with a PONG, which is what endpoint verification needs",
      { ...(pong.status === 200 && pong.text.includes('"type":1') ? {} : { actual: `HTTP ${pong.status} ${pong.text}` }) },
    );

    // The signature covers the body, so reusing it over different bytes must fail.
    // This is the assertion that separates "checks a signature" from "checks that
    // a signature is present".
    refused(
      t,
      "discord with a valid signature over a DIFFERENT body",
      await post("/eve/v1/discord", dHeaders(signature, now), JSON.stringify({ type: 2 })),
    );
    refused(
      t,
      "discord with a valid signature and a substituted timestamp",
      await post("/eve/v1/discord", dHeaders(signature, String(Number(now) + 999)), ping),
    );

    /* ---- slack: HMAC-SHA256 over v0:timestamp:body ------------------------ */
    const signing = process.env.SLACK_SIGNING_SECRET;
    const slackSig = (ts, body) => `v0=${createHmac("sha256", signing).update(`v0:${ts}:${body}`).digest("hex")}`;
    const challenge = JSON.stringify({ type: "url_verification", challenge: "probe-challenge-value" });
    const sHeaders = (sig, ts) => ({ "x-slack-signature": sig, "x-slack-request-timestamp": ts });

    refused(t, "slack with no signature", await post("/eve/v1/slack", {}, challenge));
    refused(t, "slack with a wrong signature", await post("/eve/v1/slack", sHeaders(`v0=${"0".repeat(64)}`, now), challenge));

    const echoed = await post("/eve/v1/slack", sHeaders(slackSig(now, challenge), now), challenge);
    t.ok(
      echoed.status === 200 && echoed.text.includes("probe-challenge-value"),
      "slack echoes a correctly signed url_verification challenge",
      { ...(echoed.status === 200 && echoed.text.includes("probe-challenge-value") ? {} : { actual: `HTTP ${echoed.status} ${echoed.text}` }) },
    );
    refused(
      t,
      "slack with a valid signature over a DIFFERENT body",
      await post(
        "/eve/v1/slack",
        sHeaders(slackSig(now, challenge), now),
        JSON.stringify({ type: "event_callback", event: { type: "app_mention", text: "hi" } }),
      ),
    );

    // Replay. A signature stays valid forever unless the timestamp is bounded, so
    // a captured request would otherwise be replayable indefinitely.
    const old = String(Math.floor(Date.now() / 1000) - 60 * 60 * 24);
    refused(
      t,
      "slack with a correctly signed request from 24 hours ago",
      await post("/eve/v1/slack", sHeaders(slackSig(old, challenge), old), challenge),
    );
  },
};
