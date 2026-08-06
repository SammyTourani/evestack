"use client";

import { useEffect, useState } from "react";
import styles from "./session.module.css";

/**
 * Replay this session into a new one, optionally rewriting a turn.
 *
 * The whole design of this panel is one idea: you cannot press the button until
 * you have been shown what it will re-execute. Replaying is not a simulation
 * and not a checkpoint fork — reaching turn 5 means running turns 1 through 4
 * again, tools and all — so the panel loads the real per-turn tool list from
 * `GET .../fork`, marks exactly which turns are in scope, and keeps the run
 * button disabled behind a confirmation that names them. A generic "this spends
 * money" warning would not tell you that turn 3 called `send_email`.
 *
 * The confirmation is deliberately re-armed whenever the range changes: ticking
 * it for turns 1–2 must not silently authorise turns 1–6.
 */

interface PlannedTurn {
  turn: number;
  message: string;
  tools: string[];
  deniedTools: string[];
  failed: boolean;
}

interface ForkResult {
  sessionId: string;
  turnsPlanned: number;
  turnsDelivered: number;
  complete: boolean;
  stopped?: { atTurn: number; code: string; message: string };
}

export function ForkPanel({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false);
  const [plan, setPlan] = useState<PlannedTurn[] | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [fromTurn, setFromTurn] = useState(1);
  const [message, setMessage] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ForkResult | null>(null);

  // The transcript comes off the agent's durable stream, not Postgres, so it is
  // fetched when the panel opens rather than on every session page view.
  useEffect(() => {
    if (!open || plan !== null) return;

    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(
          `/api/control/sessions/${encodeURIComponent(sessionId)}/fork`,
          { signal: controller.signal },
        );
        const body = (await response.json().catch(() => null)) as
          | { turns?: PlannedTurn[]; error?: string }
          | null;
        if (!response.ok || !body?.turns) {
          throw new Error(body?.error ?? `Could not read this session's turns (${response.status}).`);
        }
        setPlan(body.turns);
        // Default to the last turn: rewriting what you said last is the common
        // case, and it is also the range the operator is most likely to have
        // meant. It still has to be confirmed below.
        setFromTurn(Math.max(1, body.turns.length));
      } catch (cause) {
        if (controller.signal.aborted) return;
        setPlanError(cause instanceof Error ? cause.message : "Could not read this session.");
      }
    })();

    return () => controller.abort();
  }, [open, plan, sessionId]);

  // Clamped here rather than trusted from the input: a cleared number field
  // reads as 0, and 0 would send a range the route rejects after the operator
  // has already confirmed it.
  function changeRange(raw: number) {
    const max = plan?.length ?? 1;
    const next = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), max) : 1;
    if (next === fromTurn) return;
    setFromTurn(next);
    setAcknowledged(false);
  }

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/control/sessions/${encodeURIComponent(sessionId)}/fork`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fromTurn,
          ...(message.trim() ? { message: message.trim() } : {}),
        }),
      });
      const body = (await response.json().catch(() => null)) as
        | (ForkResult & { error?: string })
        | null;
      if (!response.ok || !body?.sessionId) {
        throw new Error(body?.error ?? `Replay failed (${response.status}).`);
      }
      setResult(body);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Replay failed.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button type="button" className={styles.promote} onClick={() => setOpen(true)}>
        Replay into a new session
      </button>
    );
  }

  const included = plan?.filter((entry) => entry.turn <= fromTurn) ?? [];
  const tools = [...new Set(included.flatMap((entry) => entry.tools))];
  const forkHref = result ? `/sessions/${encodeURIComponent(result.sessionId)}` : null;

  return (
    <div className={styles.forkPanel}>
      <p className={styles.forkWarn}>
        <strong>This re-runs the conversation for real.</strong> There is no saved state to branch
        from, so replaying turn {Math.max(1, fromTurn)} means running every turn before it again —
        calling the model, spending money, and executing the same tools with the same arguments.
        Anything the original sent, deleted or paid for happens a second time.
      </p>

      {planError && <p className={styles.forkError}>{planError}</p>}

      {!plan && !planError && <p className="faint">Reading this session&apos;s turns…</p>}

      {plan && plan.length === 0 && (
        <p className="faint">
          No user messages were recovered from this session&apos;s durable event log, so there is
          nothing to replay.
        </p>
      )}

      {plan && plan.length > 0 && (
        <>
          <div className={styles.forkRow}>
            <label htmlFor="fork-from">Replay turns 1 –</label>
            <input
              id="fork-from"
              className={styles.forkNum}
              type="number"
              min={1}
              max={plan.length}
              value={fromTurn}
              disabled={busy || result !== null}
              onChange={(event) => changeRange(Number(event.target.value))}
            />
            <span className="faint">of {plan.length}</span>
          </div>

          <ol className={styles.forkPlan}>
            {plan.map((entry) => {
              const inScope = entry.turn <= fromTurn;
              const rewritten = entry.turn === fromTurn && message.trim().length > 0;
              return (
                <li
                  key={entry.turn}
                  className={inScope ? styles.forkTurn : `${styles.forkTurn} ${styles.forkTurnOut}`}
                >
                  <span className={styles.forkTurnNum}>{entry.turn}</span>
                  <span className={styles.forkTurnBody}>
                    <span className={styles.forkTurnMsg} title={entry.message}>
                      {rewritten ? <s>{entry.message}</s> : entry.message}
                    </span>
                    {rewritten && <span className={styles.forkTurnNew}>{message.trim()}</span>}
                    {entry.tools.length > 0 && (
                      <span className={styles.forkTools}>
                        {entry.tools.map((tool) => (
                          <span
                            key={tool}
                            className={
                              inScope ? `${styles.forkTool} ${styles.forkToolLive}` : styles.forkTool
                            }
                          >
                            {tool}
                          </span>
                        ))}
                        {inScope && <span className="faint">runs again</span>}
                      </span>
                    )}
                  </span>
                </li>
              );
            })}
          </ol>

          <textarea
            className={styles.forkText}
            rows={3}
            placeholder={`Rewrite turn ${fromTurn}… (leave empty to replay it verbatim)`}
            value={message}
            disabled={busy || result !== null}
            onChange={(event) => setMessage(event.target.value)}
          />

          <p className={styles.forkNote}>
            The model is free to take a different path this time, so the tools above are what the
            original ran, not a guarantee of what the replay will run. Turns after {fromTurn} are
            dropped — they answered a conversation that is no longer happening.
          </p>

          {result === null && (
            <label className={styles.forkAck}>
              <input
                type="checkbox"
                checked={acknowledged}
                disabled={busy}
                onChange={(event) => setAcknowledged(event.target.checked)}
              />
              <span>
                {tools.length > 0 ? (
                  <>
                    I understand turns 1–{fromTurn} will execute again, including{" "}
                    <strong>{tools.join(", ")}</strong>.
                  </>
                ) : (
                  <>
                    I understand turns 1–{fromTurn} will run again. No tool calls were recorded in
                    them, so this should only cost model tokens.
                  </>
                )}
              </span>
            </label>
          )}

          <div className={styles.forkRow}>
            {result === null && (
              <button
                type="button"
                className={styles.promote}
                disabled={busy || !acknowledged}
                onClick={run}
              >
                {busy ? `replaying ${fromTurn} turn${fromTurn === 1 ? "" : "s"}…` : "Run the replay"}
              </button>
            )}
            <button
              type="button"
              className={styles.cancelBtn}
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              {result === null ? "cancel" : "close"}
            </button>
            {forkHref && (
              <a className={styles.forkLink} href={forkHref}>
                open the replay →
              </a>
            )}
          </div>

          {busy && (
            <p className="faint">
              Each turn has to finish before the next is sent, so this takes about as long as the
              original conversation did. Leaving the page stops sending further turns; the ones
              already sent keep running.
            </p>
          )}
        </>
      )}

      {result && (
        <div className={styles.forkResult}>
          <p>
            {result.complete
              ? `Replayed all ${result.turnsPlanned} turn${result.turnsPlanned === 1 ? "" : "s"} into a new session.`
              : `Sent ${result.turnsDelivered} of ${result.turnsPlanned} turns.`}{" "}
            <span className="mono">{result.sessionId}</span>
          </p>
          {result.stopped && (
            <p className={styles.forkStopped}>
              Stopped before turn {result.stopped.atTurn}: {result.stopped.message}
            </p>
          )}
        </div>
      )}

      {error && <p className={styles.forkError}>{error}</p>}
    </div>
  );
}
