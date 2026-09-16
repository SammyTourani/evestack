"use client";

import { useId, useRef, useState } from "react";
import type { InputRequest } from "@/lib/agent-client";
import styles from "@/app/chat/chat.module.css";

/** A decision stays visible until the agent accepts it. Never retry it automatically. */
export function DecisionCard({
  sessionId,
  request,
  onResolved,
}: {
  sessionId: string;
  request: InputRequest;
  onResolved: (warning?: string) => void;
}) {
  const fieldId = useId();
  const submitting = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState("");
  const options = request.options?.length
    ? request.options
    : request.kind === "tool-approval"
      ? [
          { id: "approve", label: "Approve" },
          { id: "deny", label: "Deny" },
        ]
      : [];

  async function submit(value: { optionId?: string; text?: string }) {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/control/sessions/${encodeURIComponent(sessionId)}/approve`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ requestId: request.requestId, ...value }),
        },
      );
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        audited?: boolean;
      };
      if (!response.ok)
        throw new Error(
          body.error ??
            `Decision was not confirmed (${response.status}). Refresh the task before trying again.`,
        );
      onResolved(
        body.audited === false
          ? "The decision was accepted, but its audit record could not be saved. Check database health; do not send the decision again."
          : undefined,
      );
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Decision delivery could not be confirmed. Refresh before trying again.",
      );
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <section
      className={styles.approval}
      aria-label="Pending decision"
      aria-busy={busy}
    >
      <h3 className={styles.approvalHead}>Needs your decision</h3>
      <p className={styles.approvalPrompt}>{request.prompt}</p>
      {request.action && (
        <pre className={styles.approvalAction}>
          {request.action.toolName}(
          {JSON.stringify(request.action.input, null, 2)})
        </pre>
      )}
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      <div className={styles.approvalButtons}>
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            disabled={busy}
            className={option.id === "deny" || option.id === "cancel" ? styles.deny : undefined}
            title={"description" in option ? option.description : undefined}
            onClick={() => void submit({ optionId: option.id })}
          >
            {option.label || option.id}
          </button>
        ))}
      </div>
      {request.allowFreeform !== false &&
        (request.allowFreeform || options.length === 0) && (
          <form
            className={styles.answerForm}
            onSubmit={(event) => {
              event.preventDefault();
              if (answer.trim()) void submit({ text: answer.trim() });
            }}
          >
            <label htmlFor={fieldId}>Your answer</label>
            <textarea
              id={fieldId}
              value={answer}
              disabled={busy}
              onChange={(event) => setAnswer(event.target.value)}
              maxLength={20000}
            />
            <button type="submit" disabled={busy || !answer.trim()}>
              Send answer
            </button>
          </form>
        )}
      {busy && <p role="status">Sending decision…</p>}
    </section>
  );
}
