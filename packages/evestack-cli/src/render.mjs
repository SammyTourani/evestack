/**
 * Turning a diagnosis into something a person reads at 3am, or a machine parses.
 *
 * Both come from the same `report` object so they cannot disagree about what was
 * found. The human report leads with what was looked at and what could not be —
 * an incident tool that quietly skips a check is worse than one that fails.
 */
import { c as color, g } from "create-evestack/ui";

import { table, section, duration, fmt } from "./format.mjs";

/**
 * The gutter, in the same three states everything else reports in.
 *
 * The words stay — a doctor report gets pasted into an incident channel where
 * "FAULT" is scannable and a glyph alone is not — but the glyph and the colour
 * are now the ones `verify` and `status` use, so the three commands agree about
 * what red means.
 */
const MARK = {
  critical: `  ${g.FAIL} ${color.redBold("FAULT")}`,
  warning: `  ${g.WARN} ${color.yellowBold("WARN")} `,
  info: `  ${g.SKIP} ${color.dim("note")} `,
};

function header(report) {
  const c = report.connection;
  const s = report.schemas;
  const lines = [
    `  ${g.MARK} ${color.bold("doctor")}   ${color.dim("read-only · nothing here writes to your database")}`,
    "",
    `  postgres   ${c.target}`,
    `             ${c.database ?? "?"} as ${c.user ?? "?"}, server ${c.serverVersion ?? "?"}`,
    `             session is ${
      c.readOnlyEnforced
        ? "read-only at the server (default_transaction_read_only=on)"
        : "NOT pinned read-only — the SET did not stick (pooler?); only SELECTs are sent"
    }, statement_timeout ${c.statementTimeoutMs}ms`,
    `  graphile   ${s.graphile}${s.graphileMigration === null ? "" : ` (migration ${s.graphileMigration})`}`,
  ];

  // Say plainly that the supported surface cannot answer this question. It is
  // the reason the tool reads a table graphile marks private, and an operator
  // who does not know that will not understand why the numbers differ from
  // `select * from graphile_worker.jobs`.
  if (s.publicJobsViewPresent && !s.publicViewExposesAvailability) {
    lines.push(
      `             reading ${s.graphile}._private_jobs: the public "jobs" view does not`,
      "             expose is_available, so a dead job reads as healthy through it",
    );
  }
  if (s.missingColumns.length > 0) {
    lines.push(`             columns not found: ${s.missingColumns.join(", ")}`);
  }
  lines.push(
    `  workflow   ${s.workflow}${
      s.workflowRunsPresent ? "" : " — no workflow_runs table, so runs and sessions were not assessed"
    }`,
  );
  if (report.sessions) {
    lines.push(
      `  agent      ${report.sessions.agentUrl}${
        report.sessions.agentReachable ? "" : " — unreachable, so no session was classified"
      }`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function queueSection(report) {
  const h = report.health;
  let out = section("queue");
  out += table(
    [
      {
        jobs: h.jobs,
        available: h.available,
        unavailable: h.unavailable,
        locked: h.locked,
        attempts_exhausted: h.attempts_exhausted,
        exhausted_no_error: h.exhausted_without_error,
      },
    ],
    { indent: "  " },
  );
  if (h.availabilityDerived) {
    out +=
      "\n  availability was computed, not read: this schema has no is_available column\n";
  }
  if (report.runSummary) {
    out += "\n";
    out += table([report.runSummary], { indent: "  " });
  }
  return out;
}

function findingsSection(report) {
  let out = section("findings");
  if (report.findings.length === 0) {
    out +=
      "  Nothing to act on. No run is stranded behind a job that cannot be claimed,\n" +
      "  and no job is one attempt from being unclaimable.\n";
    return out;
  }
  for (const f of report.findings) {
    out += `\n${MARK[f.severity] ?? " ".repeat(9)} ${color.bold(f.title)}\n`;
    out += `           ${f.action}\n`;
    if (f.evidence.length > 0) out += `\n${table(f.evidence, { indent: "           " })}`;
    // The detail block is the "why", and it needs air between it and the
    // evidence table or the two read as one run-on paragraph.
    if (f.detail.length > 0) out += `\n${f.detail.map((line) => color.dim(`           ${line}`) + "\n").join("")}`;
  }
  return out;
}

function verdict(report) {
  const critical = report.findings.filter((f) => f.severity === "critical");
  let out = section("verdict");
  if (critical.length === 0) {
    out +=
      "  Nothing is currently costing you a run.\n" +
      "  Any dead jobs listed above are leftovers whose runs found another way forward —\n" +
      "  worth knowing, not an incident.\n";
    return out;
  }
  out += `  ${critical.length} fault${critical.length === 1 ? "" : "s"}: ${critical
    .map((f) => f.title)
    .join("; ")}.\n`;
  if (report.remediation) {
    out +=
      "\n  Remediation SQL is printed below. It is not run, by this tool or any other:\n" +
      "  @workflow/world-postgres moved beta.31 to beta.38 in two days and _private_jobs\n" +
      "  is a private table. A human reads it, a human runs it.\n";
  }
  return out;
}

export function renderText(report) {
  let out = `${header(report)}`;
  out += queueSection(report);
  out += findingsSection(report);
  out += verdict(report);
  if (report.remediation) {
    out += section("remediation sql — not run; `--sql` prints only this, to pipe");
    out += `${report.remediation}\n`;
  }
  return out;
}

/** Machine-readable, and deliberately the same object the text renderer used. */
export function renderJson(report) {
  const { runs, ...rest } = report;
  return `${JSON.stringify(
    {
      ...rest,
      generatedAt: report.generatedAt.toISOString(),
      sessions: report.sessions
        ? {
            ...report.sessions,
            agentError: report.sessions.agentError?.message ?? null,
          }
        : null,
      runs: runs ? Object.fromEntries(runs) : {},
    },
    (_key, value) => (value instanceof Date ? value.toISOString() : value),
    2,
  )}\n`;
}

/** `--verbose` dumps the rows behind the findings, for pasting into an issue. */
export function renderVerbose(report) {
  let out = "";
  out += section("dead jobs — attempts exhausted, can never be claimed again");
  out += table(
    report.dead.map((j) => ({
      id: j.id,
      kind: j.kind,
      attempts: `${j.attempts}/${j.max_attempts}`,
      last_error: j.last_error === null ? "NULL" : fmt(j.last_error).split("\n")[0].slice(0, 40),
      job_key: j.job_key === null ? "NULL" : "set",
      run_id: j.run_id ?? "?",
      created_at: j.created_at,
    })),
    { indent: "  " },
  );
  out += section("locked right now");
  out += table(
    report.locked.map((j) => ({
      id: j.id,
      locked_for: duration(j.locked_for_ms),
      locked_by: j.locked_by,
      attempts: `${j.attempts}/${j.max_attempts}`,
      run_id: j.run_id ?? "?",
    })),
    { indent: "  " },
  );
  if (report.sessions && report.sessions.entries.length > 0) {
    out += section("sessions");
    out += table(
      report.sessions.entries.map((e) => ({
        session: e.sessionId,
        health: e.health,
        idle: duration(e.idleMs),
        pending: e.pendingCount,
        why: e.reason,
      })),
      { indent: "  " },
    );
  }
  return out;
}
