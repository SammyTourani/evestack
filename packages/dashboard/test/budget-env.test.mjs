import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  DEFAULT_DAILY_USD,
  DEFAULT_SESSION_USD,
  dailySpendCap,
  parseCap,
  readBudgetCaps,
} from "../lib/budget-env.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUDGET_CONFIG = join(HERE, "..", "..", "evestack-budget", "src", "config.ts");

/**
 * The dashboard re-reads the budget caps instead of importing them, because it
 * is a separate process that may be pointed at an agent it did not scaffold.
 * That is a copy, and a copy drifts. These are the tests that make it fail
 * loudly when it does rather than quietly reporting the wrong ceiling.
 */

test("the defaults still match the package that enforces them", () => {
  const source = readFileSync(BUDGET_CONFIG, "utf8");
  const session = /const DEFAULT_SESSION_USD = (\d+(?:\.\d+)?)/.exec(source);
  const daily = /const DEFAULT_DAILY_USD = (\d+(?:\.\d+)?)/.exec(source);

  // If these stop matching, the regex is wrong and every assertion below it
  // would vacuously pass — the failure mode this whole file exists to prevent.
  assert.ok(session, "could not find DEFAULT_SESSION_USD in the budget package");
  assert.ok(daily, "could not find DEFAULT_DAILY_USD in the budget package");

  assert.equal(DEFAULT_SESSION_USD, Number(session[1]));
  assert.equal(DEFAULT_DAILY_USD, Number(daily[1]));
});

test("the variable names still match the package that reads them", () => {
  // The bug this file was written for: lib/alerts.ts read
  // EVESTACK_DAILY_BUDGET_USD, which is not a variable — the real one is
  // EVESTACK_BUDGET_DAILY_USD. Nothing disagreed with the transposition loudly
  // enough to be noticed, so the monitor sat at `unknown` on every install.
  const source = readFileSync(BUDGET_CONFIG, "utf8");
  for (const name of [
    "EVESTACK_BUDGET_DAILY_USD",
    "EVESTACK_BUDGET_SESSION_USD",
    "EVESTACK_BUDGET_DISABLED",
  ]) {
    assert.ok(source.includes(name), `${name} is no longer read by @evestack/budget`);
  }
});

test("the name that caused the bug is gone from the dashboard for good", () => {
  const alerts = readFileSync(join(HERE, "..", "lib", "alerts.ts"), "utf8");
  // Allowed in prose that explains the bug; never as a process.env read.
  assert.ok(
    !/process\.env\.EVESTACK_DAILY_BUDGET_USD/.test(alerts),
    "lib/alerts.ts is reading EVESTACK_DAILY_BUDGET_USD again — that variable does not exist",
  );
});

/* ── the parser ────────────────────────────────────────────────────────────── */

test("a cap can be switched off by word", () => {
  for (const word of ["false", "off", "none", "FALSE", " Off "]) {
    assert.equal(parseCap(word, 10), false, word);
  }
});

test("an unset or empty cap takes the default", () => {
  assert.equal(parseCap(undefined, 10), 10);
  assert.equal(parseCap("   ", 10), 10);
});

test("a dollar sign is tolerated, because people write one", () => {
  assert.equal(parseCap("$25", 10), 25);
});

test("a typo falls back to the default rather than to no cap", () => {
  // The safe direction for a spend limit is the one that keeps limiting.
  assert.equal(parseCap("twenty", 10), 10);
  assert.equal(parseCap("-5", 10), 10);
});

test("zero is a real cap, not an absent one", () => {
  // `EVESTACK_BUDGET_DAILY_USD=0` means "spend nothing", which is a legitimate
  // way to freeze an agent. Falling back to the default here would quietly
  // grant it $10.
  assert.equal(parseCap("0", 10), 0);
});

test("disabling budgets disables both axes", () => {
  const caps = readBudgetCaps({ EVESTACK_BUDGET_DISABLED: "1", EVESTACK_BUDGET_DAILY_USD: "50" });
  assert.equal(caps.disabled, true);
  assert.equal(caps.dailyUsd, false);
  assert.equal(caps.sessionUsd, false);
});

/* ── which cap the spend monitor judges against ────────────────────────────── */

test("with nothing set the monitor still has a cap, so it can actually fire", () => {
  // This is the whole fix. Before it, the monitor reported `unknown` on every
  // install in existence while @evestack/budget enforced $10/day a process away.
  const { usd, scope } = dailySpendCap({});
  assert.equal(usd, DEFAULT_DAILY_USD);
  assert.equal(scope, "per-principal");
});

test("an install-wide cap wins over the per-principal fallback", () => {
  const { usd, scope } = dailySpendCap({
    EVESTACK_ALERT_DAILY_SPEND_USD: "100",
    EVESTACK_BUDGET_DAILY_USD: "10",
  });
  assert.equal(usd, 100);
  assert.equal(scope, "install");
});

test("switching the spend alert off is not undone by the budget cap", () => {
  // The trap in the obvious implementation: fall through on `false` and the
  // alert the operator just disabled comes straight back on at $10.
  const { usd } = dailySpendCap({
    EVESTACK_ALERT_DAILY_SPEND_USD: "false",
    EVESTACK_BUDGET_DAILY_USD: "10",
  });
  assert.equal(usd, null);
});

test("a typo in the install-wide cap still leaves the monitor watching", () => {
  // Not silently uncapped. It falls through to the per-principal number, and
  // the alert's own detail names which scope it landed on.
  const { usd, scope } = dailySpendCap({ EVESTACK_ALERT_DAILY_SPEND_USD: "ten dollars" });
  assert.equal(usd, DEFAULT_DAILY_USD);
  assert.equal(scope, "per-principal");
});

test("disabling budgets entirely leaves the spend monitor with nothing to judge", () => {
  const { usd } = dailySpendCap({ EVESTACK_BUDGET_DISABLED: "true" });
  assert.equal(usd, null);
});

test("scope is reported so the alert can say which cap it compared to", () => {
  // alerts.ts sums the whole INSTALL; the fallback cap is per PRINCIPAL. Same
  // number on a single-user install, different the moment there are two — and
  // the difference has to be visible rather than implied.
  assert.equal(dailySpendCap({}).scope, "per-principal");
  assert.equal(dailySpendCap({ EVESTACK_ALERT_DAILY_SPEND_USD: "5" }).scope, "install");
});
