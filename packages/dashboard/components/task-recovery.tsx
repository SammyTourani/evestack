"use client";

import { useEffect, useState } from "react";
import type { TaskRecovery } from "@/lib/task-recovery";
import { ResultMarkdown } from "./markdown";
import { QueueDiagnosisPanel } from "./queue-diagnosis";

export function TaskRecoveryPanel({ sessionId, status, reconnect }: { sessionId: string; status: string; reconnect: () => void }) {
  const [result, setResult] = useState<TaskRecovery | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    setError(null);
    fetch(`/api/tasks/${encodeURIComponent(sessionId)}/recovery`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]), cache: "no-store" })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok || !body.ok || !body.recovery) throw new Error(body.error ?? "Saved evidence is unavailable.");
        if (!controller.signal.aborted) setResult(body.recovery);
      }).catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Saved evidence is unavailable."); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [sessionId,status,refresh]);
  const evidence = result?.session.id === sessionId ? result : null;
  return <details className="task-budget" open={status === "error" ? true : undefined}>
    <summary>Saved evidence &amp; recovery{error ? " · unavailable" : busy ? " · checking…" : evidence?.failure ? " · failure recorded" : ""}</summary>
    {error && <p role="alert">{error}{evidence ? " The evidence below is from the previous check." : ""}</p>}
    {evidence && <>
      {evidence.coverage.turns === "unavailable" ? <p>Workflow history could not be read; failure and completion coverage is unknown.</p> : evidence.failure ? <p>Latest recorded failure or stopped turn: <a href={evidence.failure.href}><code>{evidence.failure.code}</code></a>. Inspect its evidence before repeating work.</p> : <p>No failed turn was found in the read window.</p>}
      {evidence.completedTurn && <p>Latest recorded completed turn: <a href={evidence.completedTurn.href}>inspect output</a>.</p>}
      {evidence.successfulAction ? <p>Latest tool span with an explicit success status: <a href={evidence.successfulAction.href}>{evidence.successfulAction.name}</a>. </p> : <p>No tool span with explicit success was found in this window.</p>}
      {evidence.traceError && <p>Latest recorded trace error: <a href={evidence.traceError.href}>{evidence.traceError.name}</a>{evidence.traceError.message ? ` — ${evidence.traceError.message}` : ""}</p>}
      {evidence.response && <details>
        <summary>Latest response text saved in traces</summary>
        <p>This may be an intermediate response. Verify it against the conversation and source.</p>
        <ResultMarkdown text={evidence.response.text} />
        {evidence.response.truncated && <p>Showing the first 8,000 characters.</p>}
        <a href={evidence.response.href}>Inspect response evidence</a>
      </details>}
      <details><summary>Evidence coverage</summary><p className="page-sub">Workflow evidence: {evidence.coverage.turns}, {evidence.coverage.turnsRead} recent turns{evidence.coverage.turnsTruncated ? " (older turns omitted)" : ""}. Trace evidence: {evidence.coverage.traces}, {evidence.coverage.tracesRead} recent matching spans{evidence.coverage.tracesTruncated ? " (older spans omitted)" : ""}. Trace retention or export gaps can hide activity. A recorded completion or tool status does not independently verify the requested result.</p></details>
    </>}
    <div className="workspace-actions">
      <button type="button" onClick={reconnect}>Reconnect to this task</button>
      <button type="button" disabled={busy} onClick={() => setRefresh((value) => value+1)}>Refresh saved evidence</button>
      <a href="/settings">Recheck agent &amp; database</a>
      <a href={`/regressions/new?task=${encodeURIComponent(sessionId)}`}>Save a correction as a regression case</a>
      <a href={`/sessions/${encodeURIComponent(sessionId)}`}>Open diagnostics &amp; replay preview</a>
    </div>
    <details><summary>Check the installation's job queue</summary><QueueDiagnosisPanel /></details>
    <details><summary>How to recover safely</summary>
    <p>Reconnecting reads this task's durable conversation without sending your request again. A new follow-up can execute tools. Replay starts another task and runs earlier messages again, so it can repeat side effects; inspect and confirm its tool preview first.</p>
    <p>For local diagnosis, run <code>npx evestack doctor</code> in your agent project. Check a provider error or budget stop before retrying. Saved workflow and trace evidence can be inspected while the agent is offline; live conversation recovery needs it to reconnect.</p></details>
  </details>;
}
