"use client";

import { useState } from "react";
import styles from "./session.module.css";

/**
 * Fork this session into a new one, optionally rewriting a turn.
 *
 * Kept behind a disclosure rather than sitting open next to "Promote to eval",
 * because unlike promoting — which downloads a file — forking spends money and
 * re-executes tools for real. The warning is in the panel, not in a tooltip.
 */
export function ForkPanel({ sessionId, turnCount }: { sessionId: string; turnCount: number }) {
  const [open, setOpen] = useState(false);
  const [fromTurn, setFromTurn] = useState(String(Math.max(1, turnCount)));
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forked, setForked] = useState<string | null>(null);

  async function fork() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/control/sessions/${encodeURIComponent(sessionId)}/fork`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            fromTurn: Number(fromTurn),
            ...(message.trim() ? { message: message.trim() } : {}),
          }),
        },
      );
      const body = (await response.json().catch(() => null)) as
        | { sessionId?: string; error?: string }
        | null;
      if (!response.ok || !body?.sessionId) {
        throw new Error(body?.error ?? `Fork failed (${response.status}).`);
      }
      setForked(body.sessionId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Fork failed.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button type="button" className={styles.promote} onClick={() => setOpen(true)}>
        Fork and replay
      </button>
    );
  }

  return (
    <div className={styles.forkPanel}>
      <p className={styles.forkWarn}>
        A fork is a real run. It calls the model, spends money, and executes tools for real —
        replay only the turns you are willing to repeat.
      </p>

      <div className={styles.forkRow}>
        <label htmlFor="fork-from">Replay turns 1 –</label>
        <input
          id="fork-from"
          className={styles.forkNum}
          type="number"
          min={1}
          max={Math.max(1, turnCount)}
          value={fromTurn}
          onChange={(event) => setFromTurn(event.target.value)}
        />
        <span className="faint">of {Math.max(1, turnCount)}</span>
      </div>

      <textarea
        className={styles.forkText}
        rows={3}
        placeholder="Rewrite that last replayed turn… (leave empty to replay it verbatim)"
        value={message}
        onChange={(event) => setMessage(event.target.value)}
      />

      <div className={styles.forkRow}>
        <button type="button" className={styles.promote} disabled={busy} onClick={fork}>
          {busy ? "running…" : "Run the fork"}
        </button>
        <button type="button" className={styles.cancelBtn} onClick={() => setOpen(false)}>
          cancel
        </button>
        {forked && (
          <a className={styles.forkLink} href={`/sessions/${encodeURIComponent(forked)}`}>
            open the fork →
          </a>
        )}
      </div>

      {error && <p className={styles.forkError}>{error}</p>}
    </div>
  );
}
