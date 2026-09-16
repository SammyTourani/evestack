/**
 * The heartbeat's quiet hour, proved against eve's own predicate.
 *
 * ─ What this file is guarding ────────────────────────────────────────────────
 *
 * The whole promise of `agent/schedules/heartbeat.ts` is that an hour with
 * nothing to report costs you nothing — no notification, no history entry. That
 * promise does not live in this repository at all. It lives in four places
 * inside eve, and this project's only contribution is the string it asks the
 * model to reply with:
 *
 *   dist/src/shared/empty-delivery.js      declares `<eve-empty-delivery/>` and
 *                                          `hasEmptyDeliverySentinel(text)`
 *   dist/src/harness/emission.js           runs that predicate on every completed
 *                                          message and emits `message: null`
 *   dist/src/harness/tool-loop.js          stores null rather than the text
 *   dist/src/public/channels/<name>/defaults.js
 *                                          decline to post a null message
 *
 * So the one thing that can silently break it here is the token drifting out of
 * step with eve's — which is exactly what had happened: this template asked for
 * `HEARTBEAT_OK`, a string nothing anywhere has ever looked for, and shipped a
 * long comment explaining that a quiet hour therefore texted you `HEARTBEAT_OK`
 * every hour.
 *
 * ─ Why the assertion runs through eve's real function ────────────────────────
 *
 * Asserting `ACK === "<eve-empty-delivery/>"` would pin the string to a second
 * copy of itself, which is the same mistake in a different file: it would keep
 * passing the day eve renames the marker or tightens what it accepts. So the
 * prompt the handler actually dispatches is searched for a token that eve's OWN
 * `hasEmptyDeliverySentinel` accepts, imported from node_modules. If eve changes
 * the marker, this fails; if somebody edits the token back to a project-local
 * one, this fails; and it cannot pass by agreeing with itself.
 *
 * eve publishes no subpath for that module (74 entries in its `exports` map,
 * none of them `./shared`), so it is imported by path into dist — knowingly. The
 * module has no imports of its own, which is what makes that safe to do from a
 * test. If the path moves, rewrite this rather than deleting it: the assertion
 * is the point.
 *
 * ─ Why the whole module is driven rather than the constant exported ──────────
 *
 * Same reasoning as test/channel-access.test.mjs: a constant checked in
 * isolation cannot catch the edit that matters most, which is the prompt being
 * reworded around it, the wrong variable being interpolated, or the dispatch
 * being rewired. So eve's schedule API, @evestack/schedules and the three
 * channel modules are replaced by recording stubs, the module under test is the
 * real one, and every assertion below reads the exact string that was handed to
 * `send()`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hasEmptyDeliverySentinel } from "../node_modules/eve/dist/src/shared/empty-delivery.js";

/** A module whose source is `source`, resolvable without touching the disk. */
const stub = (source) => `data:text/javascript,${encodeURIComponent(source)}`;

/** What `tracked()` was constructed with, so the wrapper's arguments are visible too. */
const TRACKED = {};
globalThis.__evestackTracked = TRACKED;

/*
 * `@evestack/schedules` is stubbed rather than used because `tracked` claims a
 * fire by INSERTing into Postgres before it calls the handler. A test that needs
 * a database to read a prompt string would be a test nobody runs. The stub keeps
 * the wrapper's shape — name, cron, options, and a function that forwards — so
 * the assertions below still run the real handler through the real call path.
 *
 * The channel modules are stubbed for a blunter reason: importing the real ones
 * constructs live Telegram/Slack/Discord channels from whatever happens to be in
 * the developer's environment.
 */
const CHANNEL_STUB = (name) =>
  stub(`export default { name: ${JSON.stringify(name)} };\n`);

const STUBS = {
  "eve/schedules": stub(
    "export function defineSchedule(definition) {\n  return definition;\n}\n",
  ),
  "@evestack/schedules": stub(
    "export function tracked(name, cron, handler, options) {\n" +
      "  globalThis.__evestackTracked.name = name;\n" +
      "  globalThis.__evestackTracked.cron = cron;\n" +
      "  globalThis.__evestackTracked.options = options;\n" +
      "  return async (args) => await handler(args);\n" +
      "}\n",
  ),
};

/*
 * The channels are imported by relative specifier (`../channels/telegram.js`),
 * so they are matched on the tail of the specifier rather than by exact key.
 * Node does not rewrite a `.js` specifier to the `.ts` file beside it — the
 * import fails outright without this hook — which is a second reason the stub is
 * not optional here.
 */
const CHANNEL_NAMES = ["telegram", "slack", "discord"];

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith("/lib/heartbeat.js")) return { url: new URL("../lib/heartbeat.ts", import.meta.url).href, shortCircuit: true };
    const replacement = STUBS[specifier];
    if (replacement !== undefined) return { url: replacement, shortCircuit: true };
    for (const name of CHANNEL_NAMES) {
      if (specifier.endsWith(`/channels/${name}.js`)) {
        return { url: CHANNEL_STUB(name), shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});

/** The checks a human would have written in HEARTBEAT.md, kept off the real file. */
const TASKS = "## Checks\n\n- Look for anything that broke overnight.";

const HEARTBEAT_FILE = join(mkdtempSync(join(tmpdir(), "evestack-heartbeat-")), "HEARTBEAT.md");
writeFileSync(HEARTBEAT_FILE, `${TASKS}\n`, "utf8");

/*
 * Every variable the module reads, applied before the import, because the
 * channel and the cron are resolved at MODULE LOAD — that is the "off means off"
 * fix the file documents, and it means a later assignment would be ignored.
 */
process.env.EVESTACK_HEARTBEAT_CHANNEL = "telegram";
process.env.EVESTACK_HEARTBEAT_TARGET = '{"chatId":123456789}';
process.env.EVESTACK_HEARTBEAT_FILE = HEARTBEAT_FILE;
delete process.env.EVESTACK_HEARTBEAT_CRON;
delete process.env.EVESTACK_HEARTBEAT_QUIET_HOURS;
delete process.env.EVESTACK_HEARTBEAT_QUIET_TIMEZONE;

const schedule = (await import("../agent/schedules/heartbeat.ts")).default;

/** Fire the schedule once and return what reached `send()`. */
async function fire() {
  const sent = [];
  const waited = [];
  await schedule.run({
    appAuth: { authenticator: "app", principalId: "eve:app", principalType: "runtime" },
    to(channel, target) {
      return {
        async send(message, options) {
          sent.push({ channel, target, message, options });
        },
      };
    },
    waitUntil(promise) {
      waited.push(promise);
    },
  });
  return { sent, waited };
}

test("the acknowledgement the agent is asked for is one EVE will drop", async () => {
  const { sent } = await fire();
  assert.equal(sent.length, 1, "one fire, one dispatch");

  const { message } = sent[0];
  const accepted = message.split(/\s+/u).filter((token) => hasEmptyDeliverySentinel(token));

  assert.ok(
    accepted.length > 0,
    "the prompt must name a token eve's hasEmptyDeliverySentinel() accepts, so that a " +
      `quiet hour is emitted as message:null and no channel posts it. Prompt was:\n${message}`,
  );

  // The failure this file exists for. `HEARTBEAT_OK` is not a marker, it is a
  // string: eve delivers it like any other reply, so an hourly heartbeat with
  // nothing to say became an hourly notification saying "HEARTBEAT_OK".
  assert.ok(
    !message.includes("HEARTBEAT_OK"),
    "the old project-local token is not a thing eve looks for",
  );
});

test("and it is asked for ALONE, because eve only suppresses a reply that is the marker and nothing else", async () => {
  // eve narrowed the check to "the entire response, apart from surrounding
  // whitespace" deliberately (CHANGELOG b3ce510, 0.52.4) so that a reply which
  // quotes or explains the marker still reaches the user. That makes the wording
  // of this instruction load-bearing rather than decorative: an acknowledgement
  // with a sentence attached is delivered.
  const { sent } = await fire();
  const { message } = sent[0];

  assert.match(message, /reply with exactly/u);
  assert.match(message, /nothing else/u);

  assert.equal(
    hasEmptyDeliverySentinel("<eve-empty-delivery/>, nothing to report"),
    false,
    "eve rejects a decorated marker — which is why the prompt has to forbid decoration",
  );
  assert.equal(hasEmptyDeliverySentinel("  <eve-empty-delivery/>\n"), true, "whitespace is trimmed");
});

test("the human's file is still what the agent is asked to work through", async () => {
  // The prompt is the tasks file plus the framing, in that order. If the framing
  // ever swallowed the file, every assertion above would still pass while the
  // feature did nothing.
  const { sent, waited } = await fire();
  const { message, target, options } = sent[0];

  assert.ok(message.startsWith(TASKS), `HEARTBEAT.md leads the prompt:\n${message}`);
  assert.deepEqual(target, { chatId: 123456789 });
  assert.equal(options.auth.principalId, "eve:app");
  assert.equal(waited.length, 1, "the dispatch is still handed to waitUntil as well as awaited");
});

test("the schedule is still registered the way the template documents", () => {
  assert.equal(schedule.cron, "0 * * * *");
  assert.equal(globalThis.__evestackTracked.name, "heartbeat");
  assert.equal(globalThis.__evestackTracked.options.catchUp, true);
  assert.equal(globalThis.__evestackTracked.options.catchUpLimit, 3);
});

test("quiet hours and invalid quiet settings reach no channel dispatch", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-15T23:00:00Z") });
  process.env.EVESTACK_HEARTBEAT_QUIET_HOURS = "22:00-08:00";
  process.env.EVESTACK_HEARTBEAT_QUIET_TIMEZONE = "UTC";
  try {
    const result = await fire();
    assert.equal(result.sent.length, 0);assert.equal(result.waited.length, 0);
    process.env.EVESTACK_HEARTBEAT_QUIET_HOURS = "invalid";
    await assert.rejects(fire(), /HH:MM-HH:MM/);
  } finally {
    delete process.env.EVESTACK_HEARTBEAT_QUIET_HOURS;
    delete process.env.EVESTACK_HEARTBEAT_QUIET_TIMEZONE;
    t.mock.timers.reset();
  }
});
