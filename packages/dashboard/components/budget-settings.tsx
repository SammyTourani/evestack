"use client";
import { useCallback, useEffect, useRef, useState } from "react";

interface Settings {
  settings: {
    revision: number;
    policy: {
      sessionUsd: number | false;
      dailyUsd: number | false;
      timeZone: string;
    };
  } | null;
  defaults: {
    sessionUsd: number | false;
    dailyUsd: number | false;
    timeZone: string;
  };
  consumers: {
    id: string;
    revision: number;
    observed: { model?: string; mode?: string };
    updated_at: string;
  }[];
}
export function BudgetSettings() {
  const [state, setState] = useState<Settings | null>(null);
  const [session, setSession] = useState("2");
  const [daily, setDaily] = useState("10");
  const [zone, setZone] = useState("UTC");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const load = useCallback(async () => {
    const response = await fetch("/api/settings/budget");
    const body = await response.json();
    if (!response.ok) throw new Error(body.error);
    setState(body);
    const values = body.settings?.policy ?? body.defaults;
    setSession(values.sessionUsd === false ? "off" : String(values.sessionUsd));
    setDaily(values.dailyUsd === false ? "off" : String(values.dailyUsd));
    setZone(values.timeZone);
  }, []);
  useEffect(() => {
    void load().catch((error) => setError(error.message));
  }, [load]);
  return (
    <section className="workspace-section">
      <div className="workspace-heading">
        <h2>Budget controls</h2>
        <button
          type="button"
          disabled={busy}
          onClick={() => void load().catch((error) => setError(error.message))}
        >
          Refresh settings
        </button>
      </div>
      <p>
        Saved controls are read by opted-in agent hooks before a turn and after
        each model step. A call already in flight can finish and incur charges.
        Daily caps apply per principal, not to the entire installation.
      </p>
      <p className="page-sub">
        These controls stop on unknown model prices and database errors. They
        require the matching budget package with{" "}
        <code>dashboardControls: true</code>, enabled in new projects. Older or
        custom agents keep their own configuration until updated.
      </p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {state && (
        <form
          className="routine-form"
          onSubmit={async (event) => {
            event.preventDefault();
            if (lock.current) return;
            lock.current = true;
            setBusy(true);
            setError(null);
            setNotice(null);
            const amount = (value: string): number | false =>
              value.trim().toLowerCase() === "off"
                ? false
                : value.trim()
                  ? Number(value)
                  : NaN;
            try {
              const policy = {
                sessionUsd: amount(session),
                dailyUsd: amount(daily),
                timeZone: zone,
              };
              if (
                [policy.sessionUsd, policy.dailyUsd].some(
                  (value) =>
                    value !== false && (!Number.isFinite(value) || value < 0),
                )
              )
                throw new Error(
                  "Enter a non-negative dollar amount, or off to disable that cap.",
                );
              const response = await fetch("/api/settings/budget", {
                method: "PUT",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  revision: state.settings?.revision ?? 0,
                  policy,
                }),
              });
              const body = await response.json();
              if (!response.ok) throw new Error(body.error);
              await load();
              setNotice(
                `Saved revision ${body.settings.revision}. Verify the agent's observation below after its next event; saving alone does not confirm activation.`,
              );
            } catch (error) {
              setError(error instanceof Error ? error.message : String(error));
            } finally {
              lock.current = false;
              setBusy(false);
            }
          }}
        >
          <div className="workspace-grid">
            <label>
              Session cap (USD, or off)
              <input
                required
                value={session}
                onChange={(event) => setSession(event.target.value)}
              />
            </label>
            <label>
              Daily cap per principal (USD, or off)
              <input
                required
                value={daily}
                onChange={(event) => setDaily(event.target.value)}
              />
            </label>
            <label>
              Budget day time zone
              <input
                required
                value={zone}
                onChange={(event) => setZone(event.target.value)}
              />
            </label>
          </div>
          <button className="primary-action" disabled={busy} type="submit">
            {busy ? "Saving…" : "Save budget controls"}
          </button>
        </form>
      )}
      <h3>Observed by the agent</h3>
      {!state?.consumers.length ? (
        <p className="page-sub">
          No opted-in agent has reported yet. Run a test task after updating the
          agent, then refresh. This is an unknown activation state.
        </p>
      ) : (
        <ul>
          {state.consumers.map((consumer) => (
            <li key={consumer.id}>
              Revision {consumer.revision}{" "}
              {consumer.revision === (state.settings?.revision ?? 0)
                ? "matches saved settings"
                : "is older than saved settings"}{" "}
              · model {consumer.observed.model ?? "unknown"} · last observed{" "}
              {new Date(consumer.updated_at).toLocaleString()}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
