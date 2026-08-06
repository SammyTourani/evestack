import assert from "node:assert/strict";
import { test } from "node:test";
import { copyValue, generate, parseArgs } from "../scripts/seed.mjs";

/**
 * The seeder is a fixture, so a bug in it does not fail loudly — it produces a database
 * that quietly disagrees with reality and makes every chart built on it wrong in the
 * same direction. Two things here are worth holding down.
 *
 * COPY's text format, because its failure mode is silent column drift rather than an
 * error. An unescaped tab does not raise; it shifts every subsequent column by one and
 * Postgres accepts the row.
 *
 * The deliberately broken attribution shape, because the entire point of this fixture is
 * that `chat` and `execute_tool` spans carry no session id. A well-meaning edit that
 * "fixes" that would leave the W1 attribution work with nothing to prove.
 */

test("COPY escaping: null is \\N, not the string NULL", () => {
  assert.equal(copyValue(null), "\\N");
  assert.equal(copyValue(undefined), "\\N");
  // The trap: an empty string is a value, not a null.
  assert.equal(copyValue(""), "");
});

test("COPY escaping: the four characters that would shift columns", () => {
  assert.equal(copyValue("a\tb"), "a\\tb");
  assert.equal(copyValue("a\nb"), "a\\nb");
  assert.equal(copyValue("a\rb"), "a\\rb");
  // Backslash must be escaped FIRST, or escaping the others re-escapes their backslash.
  assert.equal(copyValue("a\\b"), "a\\\\b");
  assert.equal(copyValue("a\\tb"), "a\\\\tb");
});

test("COPY escaping: booleans and dates take Postgres's spelling", () => {
  assert.equal(copyValue(true), "t");
  assert.equal(copyValue(false), "f");
  assert.equal(copyValue(new Date("2026-08-06T12:00:00.000Z")), "2026-08-06T12:00:00.000Z");
});

/**
 * Postgres's own inverse: one left-to-right pass, because sequential replaces cannot
 * undo this encoding. Unescaping `\t` before `\\` turns the two characters `\` `t` —
 * which the escaper wrote as `\\t` — into a real tab, silently corrupting the value.
 * Writing the correct inverse here is what makes the round trip mean something.
 */
function copyUnescape(text) {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== "\\") {
      out += text[i];
      continue;
    }
    i += 1;
    const code = text[i];
    if (code === "t") out += "\t";
    else if (code === "n") out += "\n";
    else if (code === "r") out += "\r";
    else out += code; // includes the escaped backslash itself
  }
  return out;
}

test("JSON survives a round trip through the escaper", () => {
  const value = { "$eve.title": "a\ttab\nand a \\ backslash", n: 1 };
  const escaped = copyValue(JSON.stringify(value));
  assert.deepEqual(JSON.parse(copyUnescape(escaped)), value);
});

test("the round trip holds for the characters that collide", () => {
  for (const raw of ["\\t", "\\n", "\\\\", "\\N", "a\tb\\tc", "", "\\"]) {
    assert.equal(copyUnescape(copyValue(raw)), raw, `round trip failed for ${JSON.stringify(raw)}`);
  }
});

const options = (extra = {}) => ({
  ...parseArgs([]),
  sessions: 60,
  days: 10,
  spanDays: 10,
  seed: 1,
  ...extra,
});

test("the same seed produces the same world", () => {
  const a = generate(options());
  const b = generate(options());
  assert.equal(a.runs.length, b.runs.length);
  assert.equal(a.spans.length, b.spans.length);
  assert.deepEqual(a.runs[0], b.runs[0]);
  assert.deepEqual(a.runs.at(-1), b.runs.at(-1));
});

test("a different seed produces a different world", () => {
  const a = generate(options({ seed: 1 }));
  const b = generate(options({ seed: 2 }));
  assert.notDeepEqual(a.runs[0].id, b.runs[0].id);
});

test("model and tool spans carry NO ids — this is the condition W1 has to fix", () => {
  const { spans } = generate(options());
  const matter = spans.filter(
    (s) => s.name.startsWith("chat ") || s.name.startsWith("execute_tool "),
  );
  assert.ok(matter.length > 0, "the fixture must contain model and tool calls at all");
  for (const span of matter) {
    assert.equal(
      span.attributes["ai.settings.context.eve.session.id"],
      undefined,
      `${span.name} must not carry a session id`,
    );
    assert.equal(span.attributes["agent.session.id"], undefined);
    assert.equal(span.attributes["workflow.run.id"], undefined);
  }
});

test("...but their ancestors do, so the ids are reachable by walking the tree", () => {
  const { spans } = generate(options());
  const byId = new Map(spans.map((s) => [`${s.trace_id}/${s.span_id}`, s]));
  const matter = spans.filter(
    (s) => s.name.startsWith("chat ") || s.name.startsWith("execute_tool "),
  );

  for (const span of matter) {
    let cursor = span;
    let sessionId;
    for (let hop = 0; hop < 8 && cursor; hop += 1) {
      sessionId = cursor.attributes["ai.settings.context.eve.session.id"];
      if (sessionId) break;
      cursor = byId.get(`${cursor.trace_id}/${cursor.parent_span_id}`);
    }
    assert.ok(sessionId, `${span.name} must resolve to a session by walking up`);
  }
});

test("engine noise dominates the table, as it does in a real one", () => {
  const { spans } = generate(options());
  const noise = spans.filter((s) => s.name === "workflow.stream.read.complete").length;
  const ratio = noise / spans.length;
  // Measured at 92.5% on a live database. A fixture that is mostly signal would let
  // ingest-hygiene work look effective when it is not.
  assert.ok(ratio > 0.85, `engine noise should dominate, got ${(ratio * 100).toFixed(1)}%`);
});

test("noise spans carry the all-zero placeholder run id, which joins to nothing", () => {
  const { spans } = generate(options());
  const noise = spans.find((s) => s.name === "workflow.stream.read.complete");
  assert.equal(noise.attributes["workflow.run.id"], "wrun_00000000000000000000000000");
});

test("every failure mode is present, not just rolled for", () => {
  const { runs } = generate(options());
  const turns = runs.filter((r) => r.attributes["$eve.type"] === "turn");
  const has = (fn, label) => assert.ok(turns.some(fn), `fixture must contain ${label}`);

  has((r) => r.error_code !== null, "an errored turn");
  has((r) => r.completed_at !== null && !r.attributes["$eve.model"], "a no-model-call turn");
  has((r) => r.status === "cancelled", "a cancelled turn");
  has((r) => r.completed_at === null, "an unfinished (wedged) turn");
});

test("the untagged sessionTimeoutWorkflow companion exists for every session", () => {
  const { runs } = generate(options());
  const sessions = runs.filter((r) => r.attributes["$eve.type"] === "session");
  const untagged = runs.filter((r) => r.attributes["$eve.type"] === undefined);
  // One per session. Anything counting runs without filtering on `$eve.type` will
  // double-count, which is exactly the bug this row exists to expose.
  assert.equal(untagged.length, sessions.length);
});

test("unpriced and free are different states", () => {
  const { budgetSteps } = generate(options());
  const unpriced = budgetSteps.filter((b) => !b.priced);
  const free = budgetSteps.filter((b) => b.priced && b.cost_usd === 0);

  assert.ok(unpriced.length > 0, "fixture must exercise the unpriced path");
  assert.ok(free.length > 0, "fixture must exercise the genuinely-free path");
  // Both record 0. Only the boolean distinguishes them, which is the whole point:
  // summing cost without reading `priced` reports unpriced spend as free.
  for (const step of unpriced) assert.equal(step.cost_usd, 0);
});

test("priced models are costed at their own rates, not one shared rate", () => {
  const { budgetSteps } = generate(options());
  const rateOf = (model) => {
    const rows = budgetSteps.filter((b) => b.model === model && b.output_tokens > 0);
    const cost = rows.reduce((sum, r) => sum + r.cost_usd, 0);
    const out = rows.reduce((sum, r) => sum + r.output_tokens, 0);
    return out > 0 ? cost / out : 0;
  };
  // Sonnet is an order of magnitude dearer than gpt-5-mini. If a single rate were
  // applied to everything, these would be equal and the cost chart would be fiction.
  assert.ok(
    rateOf("anthropic/claude-sonnet-5") > rateOf("openai/gpt-5-mini") * 2,
    "per-model rates must actually differ",
  );
  assert.equal(rateOf("ollama/qwen3"), 0, "local inference is free");
});
