"use client";
import { useEffect, useRef, useState } from "react";
import type { QueueDiagnosis } from "@/lib/queue-diagnosis";
import { Badge } from "./ui/badge";
import { ResultMarkdown } from "./markdown";
import styles from "./queue-diagnosis.module.css";

// Product guidance wraps the unchanged CLI finding. Full wording remains
// available, including the inference and coverage qualifications it carries.
const NEXT_ACTION: Record<string, string> = {
  "stranded-runs":
    "Review the affected runs and recent external activity before restarting the agent. Use the terminal doctor for a current recovery plan.",
  "wedged-jobs":
    "Inspect the repair plan in the terminal doctor and back up the database before applying it. Resetting a job can execute its tools again.",
  "wedged-jobs-unattributed":
    "The queue cannot reliably identify the affected run. Inspect the recorded evidence before changing any job.",
  "superseded-jobs":
    "A claimable replacement exists. Do not revive the old row; check whether the replacement is making progress.",
  "leftover-jobs":
    "Inspect the associated run's outcome before cleanup. A retained exhausted row alone does not mean a task needs to run again.",
  "failed-jobs":
    "Inspect the recorded error and fix its cause before retrying. A normal failure needs different recovery from a worker crash.",
  "stale-locks":
    "Check the worker process and its logs before intervening. A long-held lock alone does not prove the worker died.",
  "one-attempt-left":
    "Investigate worker failures before another restart consumes the last available attempt.",
  "enqueue-flooding":
    "Inspect restart loops and replacement jobs before restarting again. The observed ratio cannot count duplicates already executed.",
  "availability-derived":
    "The expected availability column is absent. Review schema compatibility and the CLI explanation before relying on this calculation.",
  "runs-not-assessed":
    "Workflow records could not be assessed here. Use the terminal doctor with the correct workflow schema.",
  "sessions-not-probed":
    "Run the terminal doctor to distinguish active work, a human decision and a stuck session. This database check does not contact the agent.",
  truncated:
    "Use the terminal doctor with a larger detail limit to inspect remaining candidates. The queue totals already cover this snapshot.",
};

export function QueueDiagnosisPanel() {
  const [result, setResult] = useState<QueueDiagnosis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  async function check() {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/doctor", {
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(20000),
        ]),
        cache: "no-store",
      });
      const body = await response.json();
      if (!response.ok || !body.ok || !body.diagnosis)
        throw new Error(body.error ?? "Queue diagnosis is unavailable.");
      if (!controller.signal.aborted) setResult(body.diagnosis);
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(
          cause instanceof Error
            ? cause.message
            : "Queue diagnosis is unavailable.",
        );
    } finally {
      if (!controller.signal.aborted) setBusy(false);
      if (request.current === controller) request.current = null;
    }
  }
  return (
    <section aria-label="Read-only queue diagnosis" className={styles.root}>
      <p>
        Check the installation's durable job queue using the CLI doctor's
        queries. This reads Postgres without contacting an agent, running work
        or repairing jobs.
      </p>
      <div>
        <button
          className="primary-action"
          type="button"
          disabled={busy}
          onClick={check}
        >
          {busy
            ? "Checking queue…"
            : result
              ? "Recheck queue health"
              : "Check queue health"}
        </button>
      </div>
      {busy && <p role="status">Reading a bounded queue snapshot…</p>}
      {error && (
        <p role="alert">
          {error}
          {result ? " The report below is from the previous check." : ""}
        </p>
      )}
      {result && (
        <>
          <p className="page-sub">
            Checked {new Date(result.checkedAt).toLocaleString()}.{" "}
            {result.counts.jobs} {result.counts.jobs === 1 ? "job" : "jobs"};{" "}
            {result.counts.available} available;{" "}
            {result.counts.attempts_exhausted} exhausted; {result.counts.locked}{" "}
            locked.
          </p>
          <p>
            An exhausted row can be superseded by a replacement job. Inspect the
            finding before considering recovery.
          </p>
          <div className={styles.findings}>
            {result.findings.map((finding) => (
              <article
                className={`workspace-section ${styles.finding}`}
                key={finding.id}
              >
                <h3>{finding.title}</h3>
                <div>
                  <Badge
                    tone={
                      finding.blind
                        ? "warn"
                        : finding.severity === "critical"
                          ? "err"
                          : finding.severity === "warning"
                            ? "warn"
                            : "neutral"
                    }
                  >
                    {finding.blind
                      ? "Not assessed"
                      : finding.severity === "critical"
                        ? "Needs attention"
                        : finding.severity}
                  </Badge>
                </div>
                <p>
                  {NEXT_ACTION[finding.id] ??
                    "Inspect the recorded evidence and full CLI explanation before choosing a recovery action."}
                </p>
                <details>
                  <summary>Full CLI explanation</summary>
                  <p>
                    Run <code>npx evestack doctor</code> for any terminal
                    options or repair SQL mentioned below.
                  </p>
                  <ResultMarkdown
                    text={[finding.action, ...finding.detail].join("\n\n")}
                  />
                </details>
                {finding.evidence.length > 0 && (
                  <details>
                    <summary>Recorded evidence</summary>
                    {finding.evidence.map((row, index) => (
                      <dl key={index}>
                        {Object.entries(row).map(([key, value]) => (
                          <div key={key}>
                            <dt>{key}</dt>
                            <dd
                              style={{
                                overflowWrap: "anywhere",
                                marginInlineStart: 0,
                              }}
                            >
                              {value}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    ))}
                  </details>
                )}
              </article>
            ))}
          </div>
          {result.findings.length === 0 && (
            <p>
              No finding in the checks performed. Live task health is still
              unknown.
            </p>
          )}
          <details>
            <summary>Queue check coverage</summary>
            <p>{result.scope}</p>
            <p>
              Queue counts cover the snapshot. Each detail query reads at most{" "}
              {result.coverage.rowLimit} candidates. Live sessions are not
              probed. Standard schemas: {result.schema} and{" "}
              {result.workflowSchema}; Graphile migration:{" "}
              {result.migration ?? "unknown"}.
            </p>
            {result.coverage.possiblyTruncated.length > 0 && (
              <p>
                Additional candidates may be omitted:{" "}
                {result.coverage.possiblyTruncated.join(", ")}.
              </p>
            )}
            {result.coverage.displayTruncated && (
              <p>
                Some finding text or evidence was shortened for display. Use the
                CLI for further inspection.
              </p>
            )}
          </details>
        </>
      )}
      <p>
        For the full diagnosis and any separately reviewed repair plan, run{" "}
        <code>npx evestack doctor</code> in the agent project. Back up the
        database before a repair; replay can repeat external actions.
      </p>
      <div className="workspace-actions">
        <a href="/settings">Check agent &amp; database access</a>
        <a href="/monitors">Health &amp; incidents</a>
        <a href="/sandboxes">Execution environments</a>
      </div>
    </section>
  );
}
