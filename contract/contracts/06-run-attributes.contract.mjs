/**
 * The `$eve.*` run attributes the dashboard's every query is built on.
 *
 * These are framework-owned keys written into `workflow.workflow_runs.attributes`
 * (JSONB). The dashboard reads them with `attributes->>'$eve.type'` and friends
 * — raw SQL strings, invisible to TypeScript. A renamed attribute does not
 * throw; Postgres returns NULL and the dashboard renders a confident zero.
 * Silent wrong numbers are the worst failure mode in the product, so this is
 * the contract with the least tolerance for drift.
 */
import { eveAttributes } from "../lib/repo.mjs";

const attributesExist = {
  id: "attributes/queried-names-still-emitted",
  title: "every $eve.* attribute evestack queries is still produced by eve",
  assumption: "The `$eve.*` run-attribute names evestack reads out of Postgres are still the names eve writes.",
  evestackUse:
    "packages/dashboard/lib/queries.ts computes session lists, token totals and — via lib/pricing.ts — every " +
    "dollar figure the dashboard shows, entirely from these keys. They are string literals inside SQL, so " +
    "nothing typechecks them. A renamed key makes `attributes->>'$eve.input_tokens'` return NULL, `SUM()` " +
    "return NULL, and the cost column read $0.00 for a session that really did spend money. No error " +
    "anywhere — just wrong numbers presented as right ones.",

  async check(eve, t) {
    const queried = eveAttributes();
    t.ok(queried.length > 0, `found ${queried.length} distinct $eve.* attributes in evestack's source`);

    // Scoped to eve's own code: dist/src/compiled is vendored third-party and
    // would produce meaningless matches.
    const emitters = ["dist/src/execution", "dist/src/harness", "dist/src/runtime", "dist/src/channel"];
    for (const { name, origins } of queried) {
      const hits = emitters.flatMap((subtree) => eve.grep(`"${name}"`, subtree));
      t.ok(hits.length > 0, `eve still writes \`${name}\` — read by ${origins[0]}`, {
        ...(hits.length > 0 ? {} : { expected: `${name} emitted somewhere in eve's dist`, actual: "not found" }),
      });
    }
  },
};

const typeDiscriminator = {
  id: "attributes/run-type-discriminator",
  title: "$eve.type still distinguishes session, turn and subagent runs",
  assumption: 'eve stamps runs with `$eve.type` of "session", "turn" or "subagent", and leaves internal runs untagged.',
  evestackUse:
    "Every dashboard query filters on `$eve.type` — not for tidiness, but because eve's own " +
    "sessionTimeoutWorkflow writes rows into the same table with no `$eve.type` at all. Without the filter " +
    "those internal rows are counted as user sessions: inflated session counts, a session list full of " +
    "phantom entries, and per-session cost divided across runs that never called a model. The three literal " +
    "values are hard-coded in packages/dashboard/lib/queries.ts.",

  async check(eve, t) {
    const attrs = await eve.loadInternal("dist/src/execution/eve-workflow-attributes.js");

    const session = attrs.buildSessionAttributes({ serializedContext: {}, inputMessage: "contract probe" });
    t.equal(session["$eve.type"], "session", 'a session run is still tagged $eve.type = "session"');
    t.ok("$eve.title" in session, "a session run still carries $eve.title (the dashboard's session label)");
    t.ok("$eve.trigger" in session, "a session run still carries $eve.trigger (which channel started it)");

    const turn = attrs.buildTurnAttributes({ requestId: "req_1", parentSessionId: "s_1", rootSessionId: "s_1" });
    t.equal(turn["$eve.type"], "turn", 'a turn run is still tagged $eve.type = "turn"');
    t.equal(turn["$eve.parent"], "s_1", "a turn still points at its session through $eve.parent");
    t.equal(turn["$eve.root"], "s_1", "a turn still carries $eve.root");

    const subagent = attrs.buildSubagentRootAttributes({
      serializedContext: {},
      parentSessionId: "s_1",
      parentCallId: "call_1",
      parentTurnId: "t_1",
      rootSessionId: "s_1",
      identity: { nodeId: "researcher" },
    });
    t.equal(subagent["$eve.type"], "subagent", 'a subagent run is still tagged $eve.type = "subagent"');
    t.equal(subagent["$eve.root"], "s_1", "a subagent still carries $eve.root back to the originating session");

    // The token and model attributes are written by the tool loop as a model
    // call reports usage, which is why a failed turn has none of them — the
    // absence of $eve.model is the only failure signal the dashboard has.
    const toolLoop = eve.readFile("dist/src/harness/tool-loop.js");
    for (const key of ["$eve.model", "$eve.input_tokens", "$eve.output_tokens", "$eve.cache_read_tokens"]) {
      t.contains(toolLoop, `"${key}"`, `the tool loop still stamps \`${key}\` on a turn that reached a model`);
    }
  },
};

export default [attributesExist, typeDiscriminator];
