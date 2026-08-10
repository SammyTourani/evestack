/**
 * Being told, rather than having to look.
 *
 * `lib/monitors.ts` already draws latency and failure rates. This is the other
 * half: a threshold, an evaluation, and a state. A chart tells you something is
 * wrong once you are looking at it, which is the wrong time.
 *
 * ── Defaults, not a builder ──────────────────────────────────────────────────
 *
 * There is no UI here for composing a monitor, and that is the design rather
 * than the backlog. Vercel shipped a dashboard builder as Monitoring, then
 * sunset it in November 2025 and folded the same data into curated insight
 * sections — the lesson being that an empty canvas asks every operator to
 * rediscover what is worth watching, and most never do. Datadog's Agent
 * Observability makes the same bet from the other side with zero-configuration
 * anomaly detection.
 *
 * So the set below ships ON, tuned, and named. Every one of these corresponds
 * to a failure this codebase has actually documented or hit:
 *
 *   wedged                a turn started and never finished; nothing retries it
 *   turn_failure_rate     error_code plus finished-with-no-model-call
 *   turn_latency_p95      the number worth alerting on, not session duration
 *   daily_spend           against EVESTACK_ALERT_DAILY_SPEND_USD, falling back
 *                         to @evestack/budget's own daily cap
 *   unpriced_spend        a model with no catalog price is running and the
 *                         real bill is unknown, which reads as $0.00 anywhere
 *                         that forgets to check `priced`
 *   no_spans_while_active turns are running and no spans have arrived. The
 *                         ingest path fails SILENTLY on a bad token — the 401
 *                         goes to the agent's exporter, not to anyone's screen
 *                         (docs/observability.mdx) — so the only symptom is a
 *                         trace tier that stays empty while work happens.
 *                         `unknown` when the trace tier cannot be read at all,
 *                         which is a different question with a different fix
 *   sandbox_networked     a sandbox not on NetworkMode=none
 *   sandbox_long_lived    a sandbox up past the hour, with no idle timeout
 *   schedule_failing      a schedule with a failing streak
 *
 * The last four cannot exist in a hosted product: three of them need the
 * machine, and the ingest one needs to know that the collector is ours.
 *
 * ── A monitor that cannot be evaluated is not OK ─────────────────────────────
 *
 * Every check returns one of `ok`, `firing`, `unknown`. `unknown` is not a
 * failure state and not a passing one: the Docker socket being unmounted, or
 * the budget being unset, means the question was not asked. Collapsing that
 * into `ok` is how a dashboard reports all-clear for something it never looked
 * at, which is the single most dangerous thing an alerting page can do.
 */

import { dailySpendCap } from "./budget-env";
import { query } from "./db";
import { STUCK_TURN_MS, schemaVersionsAhead } from "./facts";
import { freshFacts } from "./metrics";
import { getMonitorSummary } from "./monitors";
import { getSchedules } from "./schedules";
import { ORPHAN_AFTER_MS, concerns, listSandboxes } from "./sandboxes";

export type AlertState = "ok" | "firing" | "unknown";
export type Severity = "page" | "warn" | "info";

export interface AlertResult {
  readonly id: string;
  readonly title: string;
  readonly severity: Severity;
  readonly state: AlertState;
  /** One sentence, always present, saying what was measured and what it was. */
  readonly detail: string;
  /** Where to go to act on it. */
  readonly href?: string;
  /** What would have to be true for this to stop firing. */
  readonly threshold?: string;
}

const WINDOW_HOURS = 24;

/** Defaults chosen to be quiet on a healthy install and loud on a broken one. */
export const THRESHOLDS = {
  failureRate: 0.1,
  latencyP95Ms: 60_000,
  wedgedSessions: 1,
  /**
   * DERIVED, not typed. This was a literal `1` while lib/sandboxes.ts:294 held
   * its own `ORPHAN_AFTER_MS = 60 * 60 * 1000`, and the two were kept in step
   * only by an assertion in test/alerts-evaluate.test.mjs that they matched.
   *
   * That is the same split the wedge threshold had — a test can prove two
   * numbers are equal today, it cannot make them equal tomorrow. The number
   * that DECIDES is ORPHAN_AFTER_MS: `concerns()` filters on it (sandboxes.ts:321)
   * and this alert only counts the rows that filter returned. Everything this
   * file prints about the limit is therefore the filter's own number, so raising
   * ORPHAN_AFTER_MS to 90 minutes can no longer leave the page stating an hour
   * while showing sandboxes it stopped flagging until ninety.
   *
   * STUCK_TURN_MS is shared out of lib/facts.ts for exactly this reason, and the
   * same rule applies here: one definition, every reader imports it.
   */
  sandboxLongLivedHours: ORPHAN_AFTER_MS / 3_600_000,
  scheduleFailingStreak: 3,
} as const;

/**
 * The cap "Spend today" is judged against, and which cap it is.
 *
 * This used to read `EVESTACK_DAILY_BUDGET_USD`, which is not a variable. The
 * real one is `EVESTACK_BUDGET_DAILY_USD` — the same four words in a different
 * order — and the transposition existed only inside this file, so nothing else
 * in the repository contradicted it. The result was not a wrong number; it was
 * this monitor reporting `unknown` on every install ever made, saying "no cap is
 * configured" while @evestack/budget enforced its $10/day default a process
 * away. lib/budget-env.ts carries the full write-up.
 */
function budgetUsd(): { usd: number | null; scope: "install" | "per-principal" } {
  return dailySpendCap(process.env);
}

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
const usd = (n: number): string => `$${n.toFixed(2)}`;

/**
 * Everything the alert list needs.
 *
 * `Promise.allSettled` rather than `all`: a monitor whose data source is down
 * must report `unknown` rather than taking the other eight with it. That is the
 * same reasoning as the state itself — a page that shows nothing because one
 * check threw is a page that hides the seven that were fine and the one that
 * was firing.
 */
export async function evaluateAlerts(): Promise<AlertResult[]> {
  const [summary, spend, ingest, sandboxes, schedules] = await Promise.allSettled([
    getMonitorSummary(WINDOW_HOURS),
    dailySpend(),
    ingestHealth(),
    listSandboxes(),
    failingSchedules(),
  ]);

  const out: AlertResult[] = [];

  /* ── turn health ─────────────────────────────────────────────────────────── */
  if (summary.status === "fulfilled") {
    const s = summary.value;
    const rate = s.turns.failureRate;
    const n = (value: number): string => value.toLocaleString("en-US");
    // Unfinished turns are not in the rate, so they have to be in the sentence.
    // Dropping them from the arithmetic and saying nothing would replace one
    // quiet answer with another: the reader would see a rate over ten turns and
    // no sign of the ninety that are stuck behind it.
    const stalledNote =
      s.turns.stalled === 0 ? "" : `, ${n(s.turns.stalled)} of them stalled for over an hour`;
    const unfinishedNote =
      s.turns.unfinished === 0
        ? ""
        : ` ${n(s.turns.unfinished)} more ${s.turns.unfinished === 1 ? "turn has" : "turns have"} not finished and ${s.turns.unfinished === 1 ? "is" : "are"} judged neither way${stalledNote}.`;
    out.push({
      id: "turn_failure_rate",
      title: "Turn failure rate",
      severity: "page",
      /*
       * `finished`, not `total`. With `total` here a window in which every turn
       * was still running reported a rate of 0 and a state of `ok` — the
       * denominator fix in lib/monitors.ts would have moved the lie from the
       * number into the verdict. Nothing judged is `unknown`, which this file's
       * header calls the one state a monitor must not collapse into `ok`.
       */
      state:
        s.turns.finished === 0 ? "unknown" : rate > THRESHOLDS.failureRate ? "firing" : "ok",
      detail:
        s.turns.total === 0
          ? `No turns in the last ${WINDOW_HOURS}h, so there is no rate to judge.`
          : s.turns.finished === 0
            ? `None of the ${n(s.turns.total)} turns in the last ${WINDOW_HOURS}h have finished, so none can be judged${stalledNote}.`
            : `${pct(rate)} of ${n(s.turns.finished)} finished turns failed — ${n(s.turns.errored)} carried an error code and ${n(s.turns.noModelCall)} finished without ever reaching a model.${unfinishedNote}`,
      threshold: `at or under ${pct(THRESHOLDS.failureRate)}`,
      href: "/monitors",
    });

    const p95 = s.turnLatencyMs?.p95 ?? null;
    out.push({
      id: "turn_latency_p95",
      title: "p95 turn latency",
      severity: "warn",
      state: p95 === null ? "unknown" : p95 > THRESHOLDS.latencyP95Ms ? "firing" : "ok",
      detail:
        p95 === null
          ? `Nothing finished in the last ${WINDOW_HOURS}h, so there is no latency to measure.`
          : `p95 is ${(p95 / 1000).toFixed(1)}s over ${s.turnLatencyMs?.count.toLocaleString("en-US")} finished turns. Session duration is deliberately not used here — eve leaves a session running while a human keeps the tab open.`,
      threshold: `at or under ${THRESHOLDS.latencyP95Ms / 1000}s`,
      href: "/monitors",
    });
  } else {
    out.push(unknownFrom("turn_failure_rate", "Turn failure rate", "page", summary.reason));
    out.push(unknownFrom("turn_latency_p95", "p95 turn latency", "warn", summary.reason));
  }

  /* ── wedged ──────────────────────────────────────────────────────────────── */
  out.push(await wedged());

  /* ── money ───────────────────────────────────────────────────────────────── */
  if (spend.status === "fulfilled") {
    const { usd: cap, scope } = budgetUsd();
    const { total, unpriced, unpricedTurns } = spend.value;
    // Which cap this is, said out loud. `dailySpend()` sums every priced turn on
    // the INSTALL, and the fallback cap is per PRINCIPAL — the same number on a
    // single-user install and a different one the moment there are two. Naming
    // the scope is what stops that difference from being a silent wrong answer.
    const scopeNote =
      scope === "per-principal"
        ? " That is @evestack/budget's per-principal daily cap, compared here against the whole install's spend — set EVESTACK_ALERT_DAILY_SPEND_USD to judge the install against its own number."
        : "";
    out.push({
      id: "daily_spend",
      title: "Spend today",
      severity: "warn",
      state: cap === null ? "unknown" : total > cap ? "firing" : "ok",
      detail:
        cap === null
          ? // Which one is off, not "both". `dailySpendCap` returns null from two
            // different places — the operator set EVESTACK_ALERT_DAILY_SPEND_USD
            // to `false`, or budgets are disabled entirely — and telling someone
            // who deliberately switched off spend alerting that their budget cap
            // is also gone would send them to check a setting that is fine.
            scope === "install"
            ? `${usd(total)} so far today. Spend alerting is switched off with EVESTACK_ALERT_DAILY_SPEND_USD=false, so there is nothing to compare it to.`
            : `${usd(total)} so far today. @evestack/budget has no daily cap — either EVESTACK_BUDGET_DAILY_USD=false or budgets are disabled — and EVESTACK_ALERT_DAILY_SPEND_USD is unset, so there is nothing to compare it to.`
          : `${usd(total)} of ${usd(cap)} spent today.${scopeNote}`,
      threshold:
        cap === null ? "set EVESTACK_ALERT_DAILY_SPEND_USD to enable" : `under ${usd(cap)}/day`,
      href: "/",
    });

    out.push({
      id: "unpriced_spend",
      title: "Unpriced models running",
      severity: "info",
      // Not a cost threshold: ANY unpriced traffic means the real bill is
      // unknown, and every surface that forgets to read `priced` renders it as
      // $0.00. One turn is enough to make the spend figure wrong.
      state: unpricedTurns > 0 ? "firing" : "ok",
      detail:
        unpricedTurns > 0
          ? `${unpricedTurns.toLocaleString("en-US")} turn${unpricedTurns === 1 ? "" : "s"} today ran a model with no catalog price (${unpriced.join(", ")}). Their real cost is unknown, not zero — the ${usd(total)} above excludes them entirely.`
          : "Every model that ran today has a catalog price, so today's spend figure is complete.",
      threshold: "every model priced",
      href: "/",
    });
  } else {
    out.push(unknownFrom("daily_spend", "Spend today", "warn", spend.reason));
    out.push(unknownFrom("unpriced_spend", "Unpriced models running", "info", spend.reason));
  }

  /* ── the ingest path, which fails silently ───────────────────────────────── */
  if (ingest.status === "fulfilled") {
    const { activeTurns, spansLastHour, behind } = ingest.value;
    // `null` means the trace tier could not be read at all, which is not the
    // same question as "no spans arrived" and must not be answered with the
    // ingest-token advice. See ingestHealth().
    const unreadable = spansLastHour === null;
    const broken = !unreadable && activeTurns > 0 && spansLastHour === 0;
    const arrived = (spansLastHour ?? 0).toLocaleString("en-US");
    const turnWord = `turn${activeTurns === 1 ? "" : "s"}`;
    const REFUSED =
      `This dashboard is older than its database (${behind.join("; ")}), so the trace tier ` +
      "will not load and the OTLP ingest endpoint is answering 503 to every batch. Spans are " +
      "not being written, and nothing here can say anything about your exporter until that is " +
      "fixed. Run the newer dashboard image.";
    const TOKEN =
      `${activeTurns} ${turnWord} ran in the last hour and no spans arrived. A bad ingest ` +
      "token fails with a 401 the agent's exporter swallows, so this is usually the only " +
      "visible symptom.";
    out.push({
      id: "no_spans_while_active",
      title: "Trace ingest",
      severity: "warn",
      state: unreadable || activeTurns === 0 ? "unknown" : broken ? "firing" : "ok",
      detail: unreadable
        ? REFUSED
        : activeTurns === 0
          ? "No turns ran in the last hour, so an empty trace tier says nothing either way."
          : broken
            ? TOKEN
            : `${arrived} spans arrived in the last hour across ${activeTurns} ${turnWord}.`,
      threshold: "spans arriving while turns run",
      href: "/traces",
    });
  } else {
    out.push(unknownFrom("no_spans_while_active", "Trace ingest", "warn", ingest.reason));
  }

  /* ── the machine ─────────────────────────────────────────────────────────── */
  if (sandboxes.status === "fulfilled" && sandboxes.value.kind === "ok") {
    const boxes = sandboxes.value.sandboxes;
    const flags = concerns(boxes, new Set(boxes.map((b) => b.sessionId ?? "")));
    const networked = flags.filter((f) => f.kind === "networked");
    const long = flags.filter((f) => f.kind === "orphaned");

    out.push({
      id: "sandbox_networked",
      title: "Sandbox network isolation",
      severity: "page",
      state: networked.length > 0 ? "firing" : "ok",
      detail:
        networked.length > 0
          ? `${networked.length} running sandbox${networked.length === 1 ? " is" : "es are"} not on NetworkMode=none (${networked.map((f) => f.sandbox.name).join(", ")}), so code inside can reach the network.`
          : `All ${boxes.filter((b) => b.state === "running").length} running sandboxes are network-isolated.`,
      threshold: "every sandbox on `none`",
      href: "/sandboxes",
    });

    out.push({
      id: "sandbox_long_lived",
      title: "Long-lived sandboxes",
      severity: "info",
      state: long.length > 0 ? "firing" : "ok",
      detail:
        long.length > 0
          ? `${long.length} sandbox${long.length === 1 ? " has" : "es have"} been up over ${THRESHOLDS.sandboxLongLivedHours}h. eve keeps one container per session and applies no idle timeout, so they accumulate until something stops them.`
          : // The passing sentence spelled the limit out in English while the
            // firing one above it read the constant, so this line was the last
            // place on the page that could still contradict the filter: move
            // ORPHAN_AFTER_MS and it would go on naming sixty minutes.
            `No sandbox has been up longer than ${THRESHOLDS.sandboxLongLivedHours}h.`,
      threshold: `under ${THRESHOLDS.sandboxLongLivedHours}h`,
      href: "/sandboxes",
    });
  } else {
    const why =
      sandboxes.status === "fulfilled" && sandboxes.value.kind === "disabled"
        ? "EVESTACK_DOCKER_SOCKET is not set, so the containers on this machine were never looked at."
        : sandboxes.status === "fulfilled" && sandboxes.value.kind === "unreachable"
          ? `Docker did not answer: ${sandboxes.value.reason}`
          : String(sandboxes.status === "rejected" ? sandboxes.reason : "unavailable");
    for (const [id, title] of [
      ["sandbox_networked", "Sandbox network isolation"],
      ["sandbox_long_lived", "Long-lived sandboxes"],
    ] as const) {
      out.push({ id, title, severity: id === "sandbox_networked" ? "page" : "info", state: "unknown", detail: why, href: "/sandboxes" });
    }
  }

  /* ── schedules ───────────────────────────────────────────────────────────── */
  if (schedules.status === "fulfilled") {
    const failing = schedules.value;
    out.push({
      id: "schedule_failing",
      title: "Failing schedules",
      severity: "warn",
      state: failing.length > 0 ? "firing" : "ok",
      detail:
        failing.length > 0
          ? `${failing.map((f) => `${f.name} (${f.streak} in a row)`).join(", ")}.`
          : "No schedule has a failing streak.",
      threshold: `under ${THRESHOLDS.scheduleFailingStreak} consecutive failures`,
      href: "/schedules",
    });
  } else {
    out.push(unknownFrom("schedule_failing", "Failing schedules", "warn", schedules.reason));
  }

  return rankAlerts(out);
}

/**
 * Firing first, then unknown, then ok; within a state, by severity.
 *
 * `unknown` above `ok` is the editorial claim of this whole module, so it is a
 * pure exported function rather than a comparator buried in a closure: "we did
 * not look" deserves more of a reader's attention than "we looked and it was
 * fine", and sorting it below `ok` would bury every un-mounted socket and
 * un-set budget under a list of passes.
 */
export function rankAlerts(alerts: readonly AlertResult[]): AlertResult[] {
  const stateRank: Record<AlertState, number> = { firing: 0, unknown: 1, ok: 2 };
  const sevRank: Record<Severity, number> = { page: 0, warn: 1, info: 2 };
  return [...alerts].sort(
    (a, b) => stateRank[a.state] - stateRank[b.state] || sevRank[a.severity] - sevRank[b.severity],
  );
}

function unknownFrom(id: string, title: string, severity: Severity, reason: unknown): AlertResult {
  return {
    id,
    title,
    severity,
    state: "unknown",
    detail: `Could not be evaluated: ${reason instanceof Error ? reason.message : String(reason)}`,
  };
}

/* -------------------------------------------------------------------------- */

/**
 * "1 hour", "15 minutes" — the shared threshold, in words, so the prose cannot
 * drift from the number the query uses.
 */
function describeMs(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

async function wedged(): Promise<AlertResult> {
  try {
    const [row] = await query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM workflow.workflow_runs
        WHERE attributes->>'$eve.type' IN ('turn','subagent')
          AND completed_at IS NULL
          AND started_at IS NOT NULL
          -- (now() AT TIME ZONE 'utc'), never a bare now(). workflow_runs
          -- timestamps are 'timestamp without time zone' holding UTC (checked
          -- against the running database, not assumed), and comparing one to a
          -- timestamptz makes Postgres read the stored value in the SERVER's
          -- zone. In America/New_York that is a four-hour shift and it points
          -- the wrong way: a turn started twenty minutes ago reads as starting
          -- three hours and forty minutes in the FUTURE, so the comparison
          -- below against a bare now() is false and this alert could never fire.
          --
          -- No backticks in here, ever: this is a template literal, and one
          -- inside the SQL ends the string with a parse error nowhere near the
          -- cause. lib/fleet.ts warns about it in the sibling query; that
          -- warning was written because someone did it, and it has now caught
          -- two more attempts in this file and in the CLI's port.
          --
          -- Not hypothetical, and not exotic: ci.yml runs the whole suite with
          -- TZ=America/New_York precisely to catch this class, and lib/fleet.ts
          -- carries the same conversion because "the CLI port of this file hit
          -- it for real: a session quiet for three hours looked five hours in
          -- the future and the sweep returned nothing".
          --
          -- The threshold is the SHARED one, not a number typed here. It was
          -- a literal 15 minutes while facts.sql, lib/fleet.ts and the
          -- wedged outcome all use STUCK_TURN_MS = 1 hour, so three surfaces
          -- disagreed about the same turn: this alert counted turns the fleet
          -- banner called healthy, and its own look-at-these link, which
          -- filters the sessions list on the wedged outcome, led to a shorter
          -- list than the number it had just reported.
          AND started_at < (now() AT TIME ZONE 'utc') - make_interval(secs => $1)`,
      [STUCK_TURN_MS / 1000],
    );
    return wedgedAlert(Number(row?.n ?? 0));
  } catch (error) {
    return unknownFrom("wedged", "Wedged turns", "page", error);
  }
}

/**
 * The wedge count, turned into a state and a sentence by ONE condition.
 *
 * This was two. The state came from `n >= THRESHOLDS.wedgedSessions` and the
 * prose from `n > 0` — lib/alerts.ts:392 and :394 as this file stood before the
 * change, checked against `git show HEAD:` rather than remembered. They are
 * the same test only while the threshold is exactly 1 — which it is, so the bug
 * was invisible and would have appeared the moment anyone tuned the number.
 * With a threshold of 3 and two wedged turns the alert said `ok` while printing,
 * word for word, the sentence it prints when it fires: "2 turns started over 1
 * hour ago and never finished. Nothing in eve notices or retries these." An
 * operator reading a green row and a paging sentence has to guess which half to
 * believe.
 *
 * `firing` is now computed once and the prose branches on that variable rather
 * than re-deriving the question, so the two cannot disagree again.
 *
 * The below-threshold sentence is NOT the zero sentence. Collapsing them would
 * have fixed the contradiction by inventing a different lie — "every turn that
 * started has finished" is false when two are stalled and the alert simply is
 * not paging about them yet. So there are three sentences behind two states: it
 * is fired, it is stalled but under the bar, or there is nothing stalled.
 *
 * `threshold` is a parameter, defaulted to the shipped one, purely so a test can
 * exercise a value other than 1 — the configuration in which the old split was
 * observable. Nothing in the product passes it.
 */
export function wedgedAlert(n: number, threshold: number = THRESHOLDS.wedgedSessions): AlertResult {
  const stuckLabel = describeMs(STUCK_TURN_MS);
  const firing = n >= threshold;
  const stalled = `${n} turn${n === 1 ? "" : "s"} started over ${stuckLabel} ago and never finished.`;
  return {
    id: "wedged",
    title: "Wedged turns",
    severity: "page",
    state: firing ? "firing" : "ok",
    detail: firing
      ? `${stalled} Nothing in eve notices or retries these.`
      : n > 0
        ? `${stalled} That is under the ${threshold} it takes to fire, but nothing in eve notices or retries them either.`
        : `Every turn that started has finished or is still within its first ${stuckLabel}.`,
    // Derived from `threshold`, not hardcoded. alerts-panel.tsx:51 renders this
    // as "healthy: <text>", so it states the condition under which the row is
    // green — and a fixed "none stalled" is only that condition while the
    // threshold is 1. At 3, `wedgedAlert(2, 3)` rendered state `ok` and
    // "healthy: none stalled past 1 hour" directly above a detail line reading
    // "2 turns started over 1 hour ago and never finished". Fixing the earlier
    // state/prose split moved the contradiction into this field rather than
    // removing it; the sweep never reads `threshold`, so nothing caught it.
    threshold:
      threshold === 1
        ? `none stalled past ${stuckLabel}`
        : `under ${threshold} stalled past ${stuckLabel}`,
    href: "/sessions?outcome=wedged",
  };
}

async function dailySpend(): Promise<{ total: number; unpriced: string[]; unpricedTurns: number }> {
  /**
   * Refresh before summing, or the spend cap is armed with stale money.
   *
   * This read the fact table without one. Inside `Promise.allSettled` a 42P01
   * degrades to `unknown` rather than breaking the panel, which is why it never
   * looked like a bug — but the failure that matters is quieter than that: on a
   * database whose facts are behind, every turn since the last refresh is
   * missing from the total, so the daily cap under-reports and the alert that
   * exists to fire before you overspend does not fire. A monitor that is wrong
   * in the safe-looking direction is the exact defect class this file is for.
   *
   * Coalesced, so the tick shares one upsert with anything else refreshing, and
   * cheap: a no-op refresh is ~20ms against a 60s default loop interval.
   */
  await freshFacts();
  /**
   * `priced` IS NOT A BOOLEAN. It is a three-state column and this loop read it
   * as a two-way branch.
   *
   * sql/facts.sql:155-158 says what the three states mean, and sql/facts.sql:515
   * is where they are written: `CASE WHEN model IS NULL THEN NULL ELSE rate IS
   * NOT NULL END`. TRUE the catalog priced it, FALSE the catalog has no entry for
   * the model that ran, NULL no model call happened at all — a turn that failed,
   * was cancelled, or was stopped by the budget before it reached a provider.
   *
   * `if (r.priced) … else …` put that third state in the `else`, so every turn
   * that never reached a provider was counted as UNPRICED SPEND. Two things came
   * out of it, both wrong in the loud direction:
   *
   *   - `unpriced_spend` fires. Its own comment two hundred lines up says one
   *     unpriced turn is enough, so a single failed turn — on an install where
   *     every model that actually ran is priced — is a standing `firing` row the
   *     operator can do nothing about.
   *   - The sentence has an empty parenthetical. Those rows group under a NULL
   *     `model` (same CASE: NULL priced only ever happens with a NULL model), so
   *     the `r.model !== null` guard below correctly refuses to name them and the
   *     prose renders "62 turns today ran a model with no catalog price ()."
   *     Reproduced against the stub pool before this fix, verbatim.
   *
   * Not a rare shape either: on the seeded month app/page.tsx:35 describes, 62 of
   * 1,922 turns never called a model, so this alert would have stood permanently
   * red on a stack where nothing was actually mispriced.
   *
   * So the branch is explicit on all three. NULL is in neither total: it is not
   * spend, and it is not a missing price. `no_model_call` is already counted, by
   * name, in the turn-failure-rate check at the top of this file — which is where
   * an operator can act on it.
   */
  const rows = await query<{
    model: string | null;
    priced: boolean | null;
    cost: string | null;
    n: string;
  }>(
    `SELECT model, priced, sum(cost_usd)::text AS cost, count(*)::text AS n
       FROM evestack.fact_turn
      WHERE created_at >= date_trunc('day', now())
      GROUP BY model, priced`,
  );
  let total = 0;
  const unpriced: string[] = [];
  let unpricedTurns = 0;
  for (const r of rows) {
    if (r.priced === true) total += Number(r.cost ?? 0);
    else if (r.priced === false) {
      unpricedTurns += Number(r.n ?? 0);
      if (r.model !== null && !unpriced.includes(r.model)) unpriced.push(r.model);
    }
    // r.priced === null — no model call. Deliberately in neither total.
  }
  return { total, unpriced, unpricedTurns };
}

async function ingestHealth(): Promise<{
  activeTurns: number;
  /** Null when this build cannot migrate the database, so the count means nothing. */
  spansLastHour: number | null;
  /** Components the database is ahead on, for the detail sentence. */
  behind: string[];
}> {
  const [turns] = await query<{ n: string }>(
    // (now() AT TIME ZONE 'utc') — see the wedged() query above for why.
    // workflow_runs.created_at is naive UTC; this one shifts the other way and
    // over-counts, so the "turns ran but no spans arrived" comparison is made
    // against a turn count from the wrong window.
    //
    // The span half below is deliberately NOT converted: evestack.spans is our
    // table and received_at is `timestamp with time zone`, so a bare now() is
    // already correct there. Converting both because they sit next to each
    // other would introduce the bug into the half that never had it.
    `SELECT count(*)::text AS n FROM workflow.workflow_runs
      WHERE attributes->>'$eve.type' IN ('turn','subagent')
        AND created_at >= (now() AT TIME ZONE 'utc') - interval '1 hour'`,
  );
  // Asked, not inferred from a thrown error. Nothing that merely SELECTs from
  // evestack.spans raises EV001 — the guard fires when the schema file is
  // APPLIED — so an image too old to migrate this database still reads a
  // healthy span count out of it while its own ingest route answers 503 to
  // every batch. Measured exactly that way before this line existed.
  const behind = await schemaVersionsAhead();
  let spansLastHour: number | null = behind.length > 0 ? null : 0;
  if (spansLastHour !== null) {
    try {
      const [spans] = await query<{ n: string }>(
        `SELECT count(*)::text AS n FROM evestack.spans WHERE received_at >= now() - interval '1 hour'`,
      );
      spansLastHour = Number(spans?.n ?? 0);
    } catch {
      // The spans table is created lazily on first ingest. Not existing is the
      // strongest possible evidence that nothing has ever been exported, which
      // is exactly what this check is about — so it counts as zero, not as an
      // error.
      spansLastHour = 0;
    }
  }
  return { activeTurns: Number(turns?.n ?? 0), spansLastHour, behind };
}

async function failingSchedules(): Promise<{ name: string; streak: number }[]> {
  /*
   * `getSchedules()` already computes this, correctly, from
   * `evestack.schedule_runs` — the table @evestack/schedules actually writes.
   *
   * The first version of this function invented its own query against a run
   * attribute named for schedules, which eve does not write. Contract 06
   * derives the `$eve.*` names evestack reads and asserts each one appears in
   * eve's dist, and it caught this by finding that literal here and failing to
   * find it upstream. The attribute exists nowhere, so the monitor
   * matched zero rows and reported "no schedule has a failing streak" on every
   * install forever. A monitor that cannot fire is worse than a missing one,
   * because the page counts it among the checks that passed.
   *
   * It is also the exact defect this module's own header warns about, written
   * into the module by the same commit as the warning.
   */
  const { schedules, tableExists } = await getSchedules();
  if (!tableExists) throw new Error("no schedule has ever run on this install");
  return schedules
    .filter((x) => x.failingStreak >= THRESHOLDS.scheduleFailingStreak)
    .map((x) => ({ name: x.name, streak: x.failingStreak }));
}
