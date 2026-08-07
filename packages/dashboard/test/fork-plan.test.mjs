/**
 * The two refusals in app/api/control/sessions/[id]/fork/route.ts.
 *
 * Forking replays a past conversation for real: reaching turn 5 means re-running
 * turns 1 through 4 against real tools, so an email the original sent gets sent
 * again. The one thing that makes the button defensible is that the operator is
 * shown the exact per-turn plan and the run does only what they acknowledged.
 * Both halves of that were broken by the same detail, and neither is visible by
 * reading the route's control flow:
 *
 *  1. `readRecentEvents` reads a TAIL window (`startIndex: -lookback`), and turn
 *     numbers in that route are positional — the first recovered turn is called
 *     "turn 1". Past the window the plan is mislabelled, so `describeTruncation`
 *     refuses instead of numbering from the middle of a conversation.
 *  2. Because the window is a tail, one event appended to the original session
 *     between the GET and the POST slides it, and `turns.slice(0, fromTurn)`
 *     selects different messages than the ones on screen. `fingerprintPlan` is
 *     what makes that mismatch visible to the POST, which then refuses.
 *
 * These are pure functions on purpose: what needs asserting is the arithmetic and
 * the digest, not HTTP, so nothing here stands up a server or an agent. The route
 * module is imported for real, though — a copy of the digest in the test would
 * pass forever while the route computed something else.
 */
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

/**
 * The route reaches its dependencies through tsconfig's `@/*` alias, which
 * test/register-ts-resolve.mjs deliberately does not handle (it only appends a
 * missing `.ts`, and only to relative specifiers). Rather than teach that shared
 * hook a second trick for one test, the alias is resolved here — for `@/` only,
 * against this package's root, so a bare specifier still goes to node_modules —
 * and the module is imported dynamically, because a static import would resolve
 * before this line ever ran.
 *
 * lib/queries.ts is the one specifier that is answered with a stub instead. It is
 * the route's Postgres layer, reachable only from the handlers, and the handlers
 * are exactly what this test does not call: the functions under test take numbers
 * and strings and return a message and a digest. Importing it for real would make
 * these assertions fail whenever an unrelated query was mid-edit, which says
 * nothing about either refusal. The stub throws rather than returning undefined,
 * so if a helper ever does start needing the database this test breaks loudly
 * instead of passing on a lie.
 */
const packageRoot = new URL("../", import.meta.url);
const queriesStub =
  "data:text/javascript,export const getSession = () => {" +
  "throw new Error('test/fork-plan.test.mjs stubs lib/queries.ts: the helpers it covers are pure');" +
  "};";
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/lib/queries") return { url: queriesStub, shortCircuit: true };
    if (specifier.startsWith("@/")) {
      for (const suffix of ["", ".ts", ".tsx"]) {
        const candidate = new URL(`${specifier.slice(2)}${suffix}`, packageRoot);
        if (existsSync(fileURLToPath(candidate))) {
          return { url: candidate.href, shortCircuit: true };
        }
      }
    }
    return nextResolve(specifier, context);
  },
});

const { describeTruncation, fingerprintPlan } = await import(
  "../app/api/control/sessions/[id]/fork/route.ts"
);

/** Only `userMessage` is fingerprinted; the rest is what a real turn carries. */
const turn = (userMessage, toolNames = []) => ({
  turnId: null,
  userMessage,
  toolNames,
  deniedTools: [],
  assistantReply: null,
  failed: false,
});

/* -------------------------------------------------------------------------- */
/* the transcript window that did not reach turn 1                             */
/* -------------------------------------------------------------------------- */

test("a read that reached the first event is not truncated", () => {
  // startIndex 0 is the only thing that makes "turn 1" mean turn 1.
  assert.equal(describeTruncation({ startIndex: 0, tailIndex: 11 }), null);
  // An empty session: eve reports tailIndex -1 and readRecentEvents returns
  // startIndex 0. Nothing was dropped, so this is not the truncation refusal —
  // the route answers it with nothing_to_replay instead.
  assert.equal(describeTruncation({ startIndex: 0, tailIndex: -1 }), null);
});

test("a read that started mid-conversation is refused, naming the real cause", () => {
  const refusal = describeTruncation({ startIndex: 905, tailIndex: 5000 });
  assert.equal(typeof refusal, "string");
  // The cause is the length of the session against the size of the window, and
  // the message has to say so: "could not read this session" would send the
  // operator looking at the agent, which is fine.
  assert.match(refusal, /longer than the transcript window/);
  assert.match(refusal, /5001 recorded events/);
  assert.match(refusal, /last 4096/);
  assert.match(refusal, /starting at event 905/);
  // And it has to say why that is fatal rather than cosmetic.
  assert.match(refusal, /cannot be numbered from 1/);
});

test("one event past the window is already a refusal", () => {
  // 4097 events read 4096 at a time leaves startIndex 1: the first turn on screen
  // would be numbered 1 while being some later turn. There is no tolerance band
  // here — being off by one turn is being wrong about which tools re-run.
  assert.notEqual(describeTruncation({ startIndex: 1, tailIndex: 4096 }), null);
});

/* -------------------------------------------------------------------------- */
/* the plan the operator acknowledged                                          */
/* -------------------------------------------------------------------------- */

test("the same plan fingerprints the same, and looks like a digest", () => {
  const plan = [turn("deploy staging"), turn("now production")];
  const first = fingerprintPlan(plan, 0);
  assert.equal(first, fingerprintPlan(plan, 0));
  // Recovered from a second read of the same events: same messages, same anchor,
  // so the POST goes through. Object identity is not what is being compared.
  assert.equal(first, fingerprintPlan([turn("deploy staging"), turn("now production")], 0));
  assert.match(first, /^[0-9a-f]{64}$/);
});

test("a window that slid by one turn does not match the plan that was shown", () => {
  // This is the defect, in the shape the POST would actually see it: the operator
  // acknowledged turns 1..3 of a 4-turn read, an event landed in the original
  // session, and the re-read now starts one turn later. `slice(0, 3)` on the
  // second list is three real messages that nobody approved.
  const shown = [turn("one"), turn("two"), turn("three"), turn("four")];
  const reread = [turn("two"), turn("three"), turn("four"), turn("five")];
  assert.notEqual(fingerprintPlan(shown, 0), fingerprintPlan(reread, 0));
});

test("a plan that only grew does not match either", () => {
  // The common live-session case: turns 1..N are unchanged and turn N+1 appeared.
  // Refusing is deliberate. It costs one re-read and one re-tick, and it is the
  // difference between "the operator saw this list" and "the operator saw a
  // prefix of this list".
  const shown = [turn("one"), turn("two")];
  assert.notEqual(fingerprintPlan(shown, 0), fingerprintPlan([...shown, turn("three")], 0));
});

test("a rewritten message does not match", () => {
  assert.notEqual(
    fingerprintPlan([turn("delete the staging bucket")], 0),
    fingerprintPlan([turn("delete the production bucket")], 0),
  );
});

test("the window anchor is part of the fingerprint", () => {
  // Same messages read from a different part of the stream is a different plan,
  // even though the message list is identical — the turn numbers the operator
  // read were derived from where the window started.
  const plan = [turn("retry"), turn("retry")];
  assert.notEqual(fingerprintPlan(plan, 0), fingerprintPlan(plan, 12));
});

test("a message cannot forge a turn boundary", () => {
  // The digest is over a JSON document rather than a joined string, so no
  // delimiter exists for a user message to smuggle. If it ever became a join,
  // these two plans would collide and a two-turn replay could be passed off as a
  // one-turn one.
  assert.notEqual(fingerprintPlan([turn("a\nb")], 0), fingerprintPlan([turn("a"), turn("b")], 0));
  assert.notEqual(
    fingerprintPlan([turn('a","b')], 0),
    fingerprintPlan([turn("a"), turn("b")], 0),
  );
});

test("the tool lists are deliberately not fingerprinted", () => {
  // Documenting a decision, not an accident. The digest pins the messages that
  // get re-sent; the tool list is evidence about what the original session did,
  // and the panel already says the replay is free to call different tools. A
  // completed turn's tools cannot change, so including them would only refuse
  // forks of sessions that are still running.
  assert.equal(
    fingerprintPlan([turn("ship it", ["shell"])], 0),
    fingerprintPlan([turn("ship it", ["shell", "send_email"])], 0),
  );
});

test("an empty plan has a fingerprint of its own", () => {
  // Not a special case in the route — it answers an empty recovery with
  // nothing_to_replay before the digest is compared — but the digest must not be
  // something a caller could produce by sending nothing at all.
  assert.match(fingerprintPlan([], 0), /^[0-9a-f]{64}$/);
  assert.notEqual(fingerprintPlan([], 0), fingerprintPlan([turn("")], 0));
});
