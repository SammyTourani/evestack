"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./chat.module.css";

/**
 * The half of the control plane a person actually touches.
 *
 * Vercel's Agent Runs shows you what happened. This sends the message, resolves
 * the approval, and stops the run — against a self-hosted agent, from a browser.
 */

interface PendingRequest {
  requestId: string;
  kind: string;
  prompt: string;
  options?: { id: string; label?: string }[];
  allowFreeform?: boolean;
  display?: "confirmation" | "select" | "text";
  action?: { toolName: string; input: Record<string, unknown> };
}

interface Entry {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  toolName?: string;
  pending?: boolean;
}

type Status = "idle" | "starting" | "streaming" | "waiting" | "cancelling" | "error";

const STATUS_LABEL: Record<Status, string> = {
  idle: "idle",
  starting: "starting",
  streaming: "running",
  waiting: "waiting for you",
  cancelling: "cancelling",
  error: "error",
};

export function ChatClient({ initialSessionId }: { initialSessionId?: string }) {
  const [sessionId, setSessionId] = useState<string | null>(initialSessionId ?? null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [pending, setPending] = useState<PendingRequest[]>([]);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [entries, pending]);

  // Close the stream when the tab does; an abandoned reader would otherwise
  // hold an open response against the agent for the life of the page.
  useEffect(() => () => abortRef.current?.abort(), []);

  const upsertAssistant = useCallback((turnKey: string, text: string) => {
    setEntries((prev) => {
      const idx = prev.findIndex((e) => e.id === turnKey);
      if (idx === -1) return [...prev, { id: turnKey, role: "assistant", text }];
      const next = [...prev];
      next[idx] = { ...next[idx], text };
      return next;
    });
  }, []);

  const consume = useCallback(
    async (id: string, signal: AbortSignal) => {
      const response = await fetch(`/api/control/sessions/${id}/stream?format=ndjson`, { signal });
      if (!response.ok || !response.body) {
        throw new Error(`Stream failed (${response.status})`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Newline-delimited JSON: keep the trailing partial line in the buffer
        // rather than trying to parse a half-received event.
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let event: { type?: string; data?: Record<string, unknown> };
          try {
            event = JSON.parse(trimmed);
          } catch {
            continue;
          }
          handleEvent(id, event);
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const handleEvent = useCallback(
    (id: string, event: { type?: string; data?: Record<string, unknown> }) => {
      const data = event.data ?? {};
      switch (event.type) {
        case "message.received": {
          const text = String(data.message ?? "");
          setEntries((prev) =>
            prev.some((e) => e.role === "user" && e.text === text)
              ? prev
              : [...prev, { id: `u-${prev.length}-${text.slice(0, 12)}`, role: "user", text }],
          );
          setStatus("streaming");
          break;
        }
        case "message.appended":
          // messageSoFar is cumulative, so assigning it is correct even if a
          // delta was dropped or arrived out of order.
          upsertAssistant(
            `a-${data.turnId}-${data.stepIndex}`,
            String(data.messageSoFar ?? ""),
          );
          break;
        case "message.completed":
          upsertAssistant(`a-${data.turnId}-${data.stepIndex}`, String(data.message ?? ""));
          break;
        case "actions.requested": {
          const actions = (data.actions ?? []) as { toolName?: string; callId?: string }[];
          setEntries((prev) => [
            ...prev,
            ...actions.map((a) => ({
              id: `t-${a.callId}`,
              role: "tool" as const,
              text: "",
              toolName: a.toolName ?? "tool",
              pending: true,
            })),
          ]);
          break;
        }
        case "action.result": {
          const result = (data.result ?? {}) as { callId?: string; output?: unknown };
          setEntries((prev) =>
            prev.map((e) =>
              e.id === `t-${result.callId}`
                ? { ...e, pending: false, text: summarize(result.output) }
                : e,
            ),
          );
          break;
        }
        case "session.waiting":
          setStatus("waiting");
          // "next-user-message" is the ordinary end of a turn. Anything else
          // means the agent parked on something it needs from us, so go ask
          // what the request actually is.
          if (data.wait !== "next-user-message") void refreshPending(id);
          else setPending([]);
          break;
        case "turn.completed":
          setStatus((s) => (s === "cancelling" ? "cancelling" : "waiting"));
          break;
        case "turn.cancelled":
          setStatus("waiting");
          setEntries((prev) => [
            ...prev,
            { id: `sys-${prev.length}`, role: "system", text: "Run cancelled." },
          ]);
          break;
        case "step.failed":
        case "turn.failed": {
          // Without this the UI sat on "running" forever with an empty
          // transcript whenever a turn died — which is exactly what a provider
          // rate limit looks like, and the most likely failure a self-hoster
          // meets on day one. Silence is the worst possible answer there.
          const details = (data.details ?? {}) as { message?: string };
          setStatus("error");
          setError(explainFailure(String(data.code ?? "unknown"), details.message));
          break;
        }
        default:
          break;
      }
    },
    [upsertAssistant],
  );

  const refreshPending = useCallback(async (id: string) => {
    try {
      const response = await fetch(`/api/control/sessions/${id}/approve`);
      if (!response.ok) return;
      const body = (await response.json()) as { pendingRequests?: PendingRequest[] };
      setPending(body.pendingRequests ?? []);
    } catch {
      // A failed poll just means no approval UI this tick; the stream is the
      // source of truth and will say `session.waiting` again.
    }
  }, []);

  const start = useCallback(
    async (message: string) => {
      setStatus("starting");
      setError(null);
      try {
        const response = await fetch("/api/control/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message }),
        });
        const body = (await response.json()) as { sessionId?: string; error?: string };
        if (!response.ok || !body.sessionId) throw new Error(body.error ?? "Could not start session");

        setSessionId(body.sessionId);
        const controller = new AbortController();
        abortRef.current = controller;
        void consume(body.sessionId, controller.signal).catch((e) => {
          if (controller.signal.aborted) return;
          setError(e instanceof Error ? e.message : String(e));
          setStatus("error");
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setStatus("error");
      }
    },
    [consume],
  );

  const send = useCallback(async () => {
    const message = draft.trim();
    if (!message || status === "starting" || status === "streaming") return;
    setDraft("");

    if (!sessionId) {
      await start(message);
      return;
    }

    setEntries((prev) => [...prev, { id: `u-${prev.length}`, role: "user", text: message }]);
    setStatus("streaming");
    try {
      const response = await fetch(`/api/control/sessions/${sessionId}/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message }),
      });
      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        throw new Error(body.error ?? `Send failed (${response.status})`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
    }
  }, [draft, sessionId, start, status]);

  const decide = useCallback(
    async (request: PendingRequest, decision: "approve" | "deny") => {
      if (!sessionId) return;
      setPending((prev) => prev.filter((p) => p.requestId !== request.requestId));
      setStatus("streaming");
      try {
        const response = await fetch(`/api/control/sessions/${sessionId}/approve`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ decision, requestId: request.requestId }),
        });
        if (!response.ok) {
          const body = (await response.json()) as { error?: string };
          throw new Error(body.error ?? "Could not send the decision");
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setStatus("error");
      }
    },
    [sessionId],
  );

  const cancel = useCallback(async () => {
    if (!sessionId) return;
    setStatus("cancelling");
    try {
      await fetch(`/api/control/sessions/${sessionId}/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
    } catch {
      // Cancellation is best-effort by nature; the banner explains why.
    }
  }, [sessionId]);

  const busy = status === "starting" || status === "streaming";

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <div>
          <h1>Chat</h1>
          <p className="page-sub">
            Drive the agent from the browser — send, approve, cancel. Agent Runs can only watch.
          </p>
        </div>
        <div className={styles.headRight}>
          <span className={`status status-${status === "error" ? "failed" : "running"}`}>
            {STATUS_LABEL[status]}
          </span>
          {sessionId && (
            <a className={styles.sessionLink} href={`/sessions/${sessionId}`}>
              {sessionId.slice(0, 20)}…
            </a>
          )}
        </div>
      </div>

      {error && <div className={styles.error}>{error}</div>}

      {status === "cancelling" && (
        <div className={styles.notice}>
          Cancellation is cooperative — the model call already in flight keeps streaming until it
          finishes on its own. This can take a while.
        </div>
      )}

      <div className={styles.transcript}>
        {entries.length === 0 && (
          <div className="empty">
            <h2>No messages yet</h2>
            <p>Send something below and the agent starts a durable session.</p>
          </div>
        )}
        {entries.map((entry) => (
          <div key={entry.id} className={styles[entry.role] ?? styles.assistant}>
            {entry.role === "tool" ? (
              <div className={styles.toolCard}>
                <span className={styles.toolName}>{entry.toolName}</span>
                <span className={entry.pending ? styles.toolPending : styles.toolDone}>
                  {entry.pending ? "running…" : entry.text || "done"}
                </span>
              </div>
            ) : (
              <div className={styles.bubble}>{entry.text}</div>
            )}
          </div>
        ))}

        {pending.map((request) => (
          <div key={request.requestId} className={styles.approval}>
            <div className={styles.approvalHead}>Needs your decision</div>
            <div className={styles.approvalPrompt}>{request.prompt}</div>
            {request.action && (
              <pre className={styles.approvalAction}>
                {request.action.toolName}({JSON.stringify(request.action.input, null, 1)})
              </pre>
            )}
            <div className={styles.approvalButtons}>
              <button type="button" onClick={() => void decide(request, "approve")}>
                Approve
              </button>
              <button
                type="button"
                className={styles.deny}
                onClick={() => void decide(request, "deny")}
              >
                Deny
              </button>
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <form
        className={styles.composer}
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
          placeholder={sessionId ? "Reply…" : "Ask the agent something…"}
          rows={2}
        />
        <div className={styles.composerButtons}>
          {busy ? (
            <button type="button" className={styles.cancel} onClick={() => void cancel()}>
              Stop
            </button>
          ) : (
            <button type="submit" disabled={!draft.trim()}>
              Send
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

/**
 * eve wraps provider errors as a JSON blob inside a string inside `details`,
 * so the raw text is a wall of escaped quotes. The provider's own sentence is
 * almost always the actionable part — a rate limit says how long to wait, a bad
 * key says it is invalid — so dig that out and lead with it.
 */
function explainFailure(code: string, raw?: string): string {
  if (!raw) return `The turn failed (${code}).`;

  const match = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw);
  let detail = raw;
  if (match) {
    try {
      detail = JSON.parse(`"${match[1]}"`);
    } catch {
      detail = match[1];
    }
  }

  if (/rate.?limit/i.test(detail)) {
    return `Model provider rate limit: ${detail}`;
  }
  return `The turn failed (${code}): ${detail}`;
}

function summarize(output: unknown): string {
  if (output === undefined || output === null) return "done";
  const text = typeof output === "string" ? output : JSON.stringify(output);
  return text.length > 180 ? `${text.slice(0, 180)}…` : text;
}
