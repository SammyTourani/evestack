/**
 * The sessions list, at the two altitudes a test can actually reach.
 *
 * The pure rules first — which outcome a session inherits from its turns, and
 * how a row becomes a CSV field — because both are silent when they are wrong:
 * a precedence bug shows a green session that failed, and a quoting bug shows a
 * spreadsheet with the columns shifted one to the right on exactly the rows
 * whose titles had a comma in them.
 *
 * Then the markup, through `test/ui-render.mjs`, whose header says what that
 * can and cannot see. It cannot click a facet chip. It can prove the thing this
 * page most has to get right and that no type checks: that an unpriced model
 * and a free one do not render the same string.
 *
 * The SQL half — the `fact_turn` rollup in `app/sessions/page.tsx` — is
 * deliberately not restated here. `test/monitors.test.mjs` sets that
 * convention: anything whose semantics belong to PostgreSQL is asserted against
 * a real server, not re-implemented in JavaScript.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { contains, omits, render } from "./ui-render.mjs";

const APP = new URL("../app/sessions/", import.meta.url).href;

const { OUTCOMES } = await import(new URL("../components/ui/badge.tsx", import.meta.url).href);
const { DEFAULT_PAGE_SIZE, PAGE_SIZES, sessionOutcome, toCsv } = await import(`${APP}rollup.ts`);
const { SessionsTable } = await import(`${APP}sessions-client.tsx`);

/** 2026-08-06T12:00:00Z, so `ago()` is a fixed string in every assertion. */
const NOW = Date.UTC(2026, 7, 6, 12, 0, 0);

function row(overrides = {}) {
  return {
    id: "wrun_0000000000000000000000001",
    title: "Summarise the incident channel",
    trigger: "slack",
    createdAt: new Date(NOW - 3_600_000).toISOString(),
    outcome: "ok",
    model: "openai/gpt-5-mini",
    provider: "openai",
    environment: "development",
    runType: "turn",
    turns: 3,
    workMs: 12_400,
    timedTurns: 3,
    inputTokens: 4_210,
    outputTokens: 812,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0.0142,
    pricedTurns: 3,
    unpricedTurns: 0,
    toolsCalled: 5,
    spanTurns: 3,
    ...overrides,
  };
}

const one = (overrides) => render(SessionsTable, { rows: [row(overrides)], now: NOW });

/**
 * Just the rows. The toolbar above them explains what the export writes, in
 * prose that names the same words the cells do — so a `contains("Unpriced")`
 * over the whole page passes whatever the cell says, which is the assertion
 * failing to test anything.
 */
const body = (markup) =>
  markup.slice(markup.indexOf("<tbody>"), markup.indexOf("</tbody>"));

/** The closed facet chip for `name`, as the popover trigger renders it. */
const chip = (name) => `data-state="closed">${name}<`;

/* -------------------------------------------------------------------------- */
/* outcome precedence                                                          */
/* -------------------------------------------------------------------------- */

test("every outcome the SQL can hold has a rank, so none renders as an em dash", () => {
  // The vocabulary is pinned to sql/facts.sql's CHECK by test/ui-primitives; this
  // pins the sessions list's severity map to the same list. A value added there
  // and not to SEVERITY would otherwise be skipped silently on this page.
  for (const outcome of OUTCOMES) {
    assert.equal(sessionOutcome([outcome]), outcome, `${outcome} has no rank`);
  }
});

test("a session takes the worst outcome of its turns, not the last or the commonest", () => {
  assert.equal(sessionOutcome(["ok", "ok", "failed"]), "failed");
  assert.equal(sessionOutcome(["failed", "wedged"]), "wedged");
  assert.equal(sessionOutcome(["ok", "running"]), "running");
  assert.equal(sessionOutcome(["ok", "cancelled"]), "cancelled");
  assert.equal(sessionOutcome(["budget_stopped", "no_model_call"]), "no_model_call");
  assert.equal(sessionOutcome(["ok", "ok"]), "ok");
});

test("no turns is null, and an unknown value is skipped rather than crashing the badge", () => {
  assert.equal(sessionOutcome([]), null);
  // OutcomeBadge looks its label up in a total map and would throw on a miss.
  assert.equal(sessionOutcome(["quantum_superposition"]), null);
  assert.equal(sessionOutcome(["quantum_superposition", "failed"]), "failed");
});

test("the default page size is one of the offered sizes", () => {
  // It doubles as DataTable's `virtualizeAfter`, which is what makes the claim
  // "the default page is rendered on the server" true.
  assert.ok(PAGE_SIZES.includes(DEFAULT_PAGE_SIZE));
});

/* -------------------------------------------------------------------------- */
/* CSV                                                                         */
/* -------------------------------------------------------------------------- */

test("CSV quotes the fields that would otherwise break the format", () => {
  const csv = toCsv([
    row({ title: 'Fix "auth", then deploy' }),
    row({ id: "wrun_2", title: "line one\nline two" }),
  ]);
  const lines = csv.split("\r\n");
  assert.equal(lines[0].startsWith("session_id,title,outcome,trigger,models"), true);
  contains(csv, '"Fix ""auth"", then deploy"');
  contains(csv, '"line one\nline two"');
  // Trailing CRLF, and the embedded newline did not become a third record.
  assert.equal(csv.endsWith("\r\n"), true);
});

test("CSV writes an unpriced cost as empty and a free one as zero", () => {
  const unpriced = toCsv([row({ costUsd: null, pricedTurns: 0, unpricedTurns: 2, turns: 2 })]);
  const free = toCsv([row({ costUsd: 0, pricedTurns: 2, unpricedTurns: 0, turns: 2 })]);
  const columns = unpriced.split("\r\n")[0].split(",");
  const cost = columns.indexOf("cost_usd");
  assert.equal(unpriced.split("\r\n")[1].split(",")[cost], "");
  assert.equal(free.split("\r\n")[1].split(",")[cost], "0");
  // And the reader can tell which is which without opening the dashboard.
  assert.equal(unpriced.split("\r\n")[1].split(",")[columns.indexOf("unpriced_turns")], "2");
});

test("CSV leaves an uncountable tool call empty rather than writing zero", () => {
  const csv = toCsv([row({ toolsCalled: null, spanTurns: 0 })]);
  const columns = csv.split("\r\n")[0].split(",");
  const cells = csv.split("\r\n")[1].split(",");
  assert.equal(cells[columns.indexOf("tools_called")], "");
  assert.equal(cells[columns.indexOf("turns_with_spans")], "0");
});

/* -------------------------------------------------------------------------- */
/* the rendered table                                                          */
/* -------------------------------------------------------------------------- */

test("the page renders rows, not just a header", () => {
  // The failure mode this whole route has: a table that typechecks, renders its
  // chrome, and shows nothing. Below `virtualizeAfter` every row is server-rendered.
  const markup = render(SessionsTable, {
    rows: [row(), row({ id: "wrun_2", title: "Second" })],
    now: NOW,
  });
  contains(markup, "Summarise the incident channel");
  contains(markup, "Second");
  contains(markup, "wrun_0000000000000000000000001");
  contains(markup, "2 of 2 rows shown");
  contains(markup, 'href="/sessions/wrun_2"');
});

test("outcome replaces status, with the shared badge and its explanation", () => {
  contains(one({ outcome: "budget_stopped" }), "budget stopped");
  contains(one({ outcome: "budget_stopped" }), "reached its configured spend or step cap");
  contains(one({ outcome: "no_model_call" }), "no model call");
  // `status` said `running` on every row. It is not a column here at all.
  omits(one(), 'class="status status-running"');
});

test("an unpriced model and a free one do not render the same string", () => {
  const unpriced = body(
    one({
      model: "acme/experimental-v1",
      provider: "acme",
      costUsd: null,
      pricedTurns: 0,
      unpricedTurns: 3,
    }),
  );
  contains(unpriced, "Unpriced");
  omits(unpriced, "$0.00", "an unpriced model was rendered as free");

  const free = body(one({ model: "ollama/qwen3", provider: "ollama", costUsd: 0 }));
  contains(free, "$0.00");
  omits(free, "Unpriced", "a measured zero was rendered as unknown");
});

test("a session that half-ran an unpriced model says the figure is partial", () => {
  const markup = body(one({ costUsd: 0.02, pricedTurns: 2, unpricedTurns: 1, turns: 3 }));
  contains(markup, "+ unpriced");
  contains(markup, "1 of 3 turns ran an unpriced model");
});

test("a session that never reached a model has no cost, not a zero one", () => {
  const markup = body(
    one({
      outcome: "no_model_call",
      model: null,
      provider: null,
      costUsd: null,
      pricedTurns: 0,
      unpricedTurns: 0,
      inputTokens: 0,
      outputTokens: 0,
    }),
  );
  omits(markup, "$0.00");
  omits(markup, "Unpriced");
  contains(markup, "nothing to price");
});

test("a span-derived count says what it was computed over, or nothing at all", () => {
  const none = body(one({ toolsCalled: null, spanTurns: 0, turns: 4 }));
  contains(none, "the trace tier is opt-in");
  omits(none, ">0<", "an uncounted tool call was rendered as zero");

  const partial = body(one({ toolsCalled: 2, spanTurns: 1, turns: 4 }));
  contains(partial, "Partial — 1 of 4 turns carry this measure.");

  // Full coverage gets no caveat; `coverageNote` owns that decision.
  omits(body(one()), "carry this measure");
});

test("duration is the agent's work, and says so", () => {
  contains(one(), "12.4s");
  contains(one(), "not how long the agent worked");
});

test("an absent dimension is an em dash, and it is still its own facet", () => {
  const markup = one({ environment: null });
  contains(body(markup), ">—</td>");
  // environment is NULL on 1,552 of 1,922 seeded turns, so the facet has to
  // offer that bucket rather than hide most of the table.
  contains(markup, chip("environment"));
});

test("every facet the brief names has a chip, and the search box exists", () => {
  const markup = one();
  const names = ["outcome", "trigger", "model", "provider", "environment", "run type"];
  for (const name of names) contains(markup, chip(name));
  assert.equal((markup.match(/aria-haspopup="dialog"/g) ?? []).length, names.length);
  contains(markup, 'type="search"');
  contains(markup, "Export CSV (1)");
});

test("one row looks deliberate rather than broken", () => {
  const markup = one();
  contains(markup, "1 of 1 rows shown");
  contains(markup, 'aria-rowcount="2"');
});

test("ten thousand rows render without dying, and state the real total", () => {
  const rows = Array.from({ length: 10_000 }, (_, i) =>
    row({ id: `wrun_${i}`, title: `Session ${i}` }),
  );
  const markup = render(SessionsTable, { rows, now: NOW });
  contains(markup, "10000 of 10000 rows shown");
  contains(markup, 'aria-rowcount="10001"');
  contains(markup, "Export CSV (10000)");
  // Above `virtualizeAfter` the server sends the chrome and an empty <tbody>,
  // and hydration fills it — the trade components/ui/table.tsx documents. If
  // this ever starts containing row 9,999 the server is shipping a 10,000-row
  // HTML document, which is the failure this threshold exists to prevent.
  omits(markup, "Session 9999");
});
