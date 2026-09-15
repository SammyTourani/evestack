"use client";

import { useEffect, useState } from "react";

interface Usage {
  costUsd: number;
  unpricedSteps: number;
  principalId?: string;
}
interface Budget {
  limits: {
    sessionUsd: number | false;
    dailyUsd: number | false;
    mode: string;
    timeZone: string;
  };
  configuration: { source: string; revision: number; explanation: string };
  session?: Usage;
  principals: Usage[];
  stops: { scope: string; reason: string; created_at: string }[];
}
const dollars = (value: number) => `$${value.toFixed(4)}`;
const cap = (value: number | false) =>
  value === false ? "off" : dollars(value);

export function TaskBudget({
  sessionId,
  status,
}: {
  sessionId: string;
  status: string;
}) {
  const [budget, setBudget] = useState<Budget | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [updated, setUpdated] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setBudget(null);
    setError(null);
    setUpdated(null);
    void fetch(`/api/budget?sessionId=${encodeURIComponent(sessionId)}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok || !body.ok)
          throw new Error(body.error ?? "Budget data is unavailable.");
        if (!controller.signal.aborted) {
          setBudget(body);
          setUpdated(new Date().toLocaleTimeString());
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message);
      });
    return () => controller.abort();
  }, [sessionId, status, refresh]);
  const usage = budget?.session;
  const principal = usage?.principalId
    ? budget?.principals.find((row) => row.principalId === usage.principalId)
    : undefined;
  return (
    <details className="task-budget">
      <summary>
        Budget ·{" "}
        {usage
          ? `${dollars(usage.costUsd)} recorded${usage.unpricedSteps ? " + unknown costs" : ""}`
          : error
            ? "unavailable"
            : budget
              ? "no recorded steps"
              : "checking…"}
      </summary>
      {error && <p role="status">{error}</p>}
      {budget && (
        <>
          <p>
            Session cap: {cap(budget.limits.sessionUsd)}. Daily cap per
            principal: {cap(budget.limits.dailyUsd)} ({budget.limits.timeZone}).
            Policy: {budget.limits.mode}.
          </p>
          {usage && (
            <p>
              {usage.unpricedSteps > 0
                ? `${usage.unpricedSteps} steps have unknown prices; remaining spend cannot be calculated.`
                : budget.limits.sessionUsd !== false
                  ? `${dollars(Math.max(0, budget.limits.sessionUsd - usage.costUsd))} remains against the configured session cap, before in-flight charges.`
                  : "The configured session cap is off."}
            </p>
          )}
          {principal && (
            <p>
              Principal <code>{principal.principalId}</code>:{" "}
              {dollars(principal.costUsd)} recorded today
              {principal.unpricedSteps ? " plus unpriced steps" : ""} across its
              tasks.
            </p>
          )}
          {budget.stops.length > 0 && (
            <p>
              Last recorded stop: {budget.stops[0].reason} (
              {new Date(budget.stops[0].created_at).toLocaleString()}). Raising
              a cap is checked on the next turn; it does not repeat stopped
              work.
            </p>
          )}
          <p className="page-sub">
            {budget.configuration.source === "saved"
              ? `Saved revision ${budget.configuration.revision}. `
              : ""}
            {budget.configuration.explanation}
          </p>
        </>
      )}
      <div className="workspace-actions">
        <button type="button" onClick={() => setRefresh((value) => value + 1)}>
          Refresh budget
        </button>
        <a href="/settings">Budget settings &amp; activation</a>
        {updated && <span className="page-sub">Checked {updated}</span>}
      </div>
    </details>
  );
}
