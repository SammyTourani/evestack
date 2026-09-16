"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DecisionCard } from "@/components/decision-card";
import { ResultMarkdown } from "@/components/markdown";
import { TaskBudget } from "@/components/task-budget";
import type { InputRequest } from "@/lib/agent-client";
import { CONNECTION_DRAFT_KEY, MEMORY_DRAFT_KEY } from "@/lib/task-examples";
import styles from "./chat.module.css";

/**
 * The half of the control plane a person actually touches.
 *
 * Vercel's Agent Runs shows you what happened. This sends the message, resolves
 * the approval, and stops the run — against a self-hosted agent, from a browser.
 */

type PendingRequest = InputRequest;

interface Entry {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  toolName?: string;
  pending?: boolean;
}

type Status =
  | "idle"
  | "starting"
  | "streaming"
  | "waiting"
  | "cancelling"
  | "completed"
  | "error";

const STATUS_LABEL: Record<Status, string> = {
  idle: "idle",
  starting: "starting",
  streaming: "running",
  waiting: "waiting for you",
  cancelling: "cancelling",
  completed: "completed",
  error: "error",
};

export function ChatClient({
  initialSessionId,
  initialDraft,
  draftFromConnection = false,
  draftFromMemory = false,
}: {
  initialSessionId?: string;
  initialDraft?: string;
  draftFromConnection?: boolean;
  draftFromMemory?: boolean;
}) {
  const [sessionId, setSessionId] = useState<string | null>(
    initialSessionId ?? null,
  );
  const [entries, setEntries] = useState<Entry[]>([]);
  const [pending, setPending] = useState<PendingRequest[]>([]);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState(initialDraft ?? "");
  const [notice, setNotice] = useState<string | null>(null);
  const sendingRef = useRef(false);
  const connectionDraftLoaded = useRef(false);

  useEffect(() => {
    if (
      (!draftFromConnection && !draftFromMemory) ||
      initialSessionId ||
      connectionDraftLoaded.current
    )
      return;
    connectionDraftLoaded.current = true;
    try {
      const key = draftFromMemory ? MEMORY_DRAFT_KEY : CONNECTION_DRAFT_KEY;
      const saved = sessionStorage.getItem(key);
      if (!saved || saved.length > 20_000) {
        setNotice(
          `The task draft is no longer available in this tab. Return to ${draftFromMemory ? "Memory" : "Connections"} to prepare it again.`,
        );
        return;
      }
      setDraft((current) => current || saved);
      sessionStorage.removeItem(key);
      setNotice(
        draftFromMemory
          ? "This is a correction request. The original memory has not changed. Review the agent's actions and verify the resulting memory before treating it as corrected."
          : "Review this request before starting. Account authorization alone does not verify repository access or enforce read-only tools.",
      );
    } catch {
      setNotice(
        "Browser draft storage is unavailable. Enter your request below.",
      );
    }
  }, [draftFromConnection, draftFromMemory, initialSessionId]);

  const abortRef = useRef<AbortController | null>(null);
  const liveStreamRef = useRef<AbortSignal | null>(null);
  // `consume` is declared below this effect, so hold it behind a ref
  // rather than reordering the file around a hook dependency.
  const consumeRef = useRef<
    ((id: string, signal: AbortSignal) => Promise<void>) | null
  >(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [entries, pending]);

  // Close the stream when the tab does; an abandoned reader would otherwise
  // hold an open response against the agent for the life of the page.
  useEffect(() => () => abortRef.current?.abort(), []);

  // Attach to a session this page did not start (`/chat?session=…`). Sessions
  // are durable and outlive the tab, so one begun from curl, Slack, or a
  // previous visit has to be joinable — without this the id was accepted and
  // then silently ignored, leaving an empty transcript.
  useEffect(() => {
    if (!initialSessionId) return;

    const controller = new AbortController();
    abortRef.current = controller;
    setStatus("streaming");
    void consumeRef
      .current?.(initialSessionId, controller.signal)
      .catch((e) => {
        if (controller.signal.aborted) return;
        setError(e instanceof Error ? e.message : String(e));
        setStatus("error");
      });

    // Releasing the ref here is what makes this survive React's double-invoke
    // in development, and any genuine remount in production. An earlier version
    // guarded on `abortRef.current` being empty: the first mount's cleanup
    // aborted the stream, the remount saw a non-null ref and returned early,
    // and the transcript stayed empty forever behind a "running" badge.
    return () => {
      controller.abort();
      if (abortRef.current === controller) abortRef.current = null;
    };
  }, [initialSessionId]);

  const upsertAssistant = useCallback((turnKey: string, text: string) => {
    setEntries((prev) => {
      const idx = prev.findIndex((e) => e.id === turnKey);
      if (idx === -1)
        return [...prev, { id: turnKey, role: "assistant", text }];
      const next = [...prev];
      next[idx] = { ...next[idx], text };
      return next;
    });
  }, []);

  const consume = useCallback(
    async (id: string, signal: AbortSignal) => {
      liveStreamRef.current = signal;
      try {
        const response = await fetch(
          `/api/control/sessions/${encodeURIComponent(id)}/stream?format=ndjson`,
          { signal },
        );
        if (!response.ok || !response.body) {
          throw new Error(`Stream failed (${response.status})`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let ordinal = 0;
        let settled = false;
        const deliver = (line: string) => {
          if (signal.aborted || !line.trim()) return;
          let event;
          try {
            event = JSON.parse(line);
          } catch {
            return;
          }
          if (
            [
              "session.waiting",
              "session.completed",
              "session.failed",
              "turn.failed",
              "turn.cancelled",
              "input.requested",
            ].includes(event.type)
          )
            settled = true;
          if (["turn.started", "message.received"].includes(event.type))
            settled = false;
          handleEvent(id, { ...event, ordinal: ordinal++ });
        };

        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            buffer += decoder.decode();
            if (buffer.trim()) deliver(buffer);
            if (!settled) {
              setError(
                "The live connection ended before the task settled. Reconnect to check its state.",
              );
              setStatus("error");
            }
            break;
          }
          buffer += decoder.decode(value, { stream: true });

          // Newline-delimited JSON: keep the trailing partial line in the buffer
          // rather than trying to parse a half-received event.
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) deliver(line);
        }
      } finally {
        if (liveStreamRef.current === signal) liveStreamRef.current = null;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  consumeRef.current = consume;

  const handleEvent = useCallback(
    (
      id: string,
      event: {
        type?: string;
        data?: Record<string, unknown>;
        meta?: { id?: string };
        ordinal?: number;
      },
    ) => {
      const data = event.data ?? {};
      switch (event.type) {
        case "message.received": {
          const text = String(data.message ?? "");
          const entry: Entry = {
            id: `u-${event.meta?.id ?? event.ordinal}`,
            role: "user",
            text,
          };
          setEntries((prev) => {
            if (prev.some((item) => item.id === entry.id)) return prev;
            const optimistic = prev.findIndex(
              (item) =>
                item.role === "user" && item.pending && item.text === text,
            );
            if (optimistic < 0) return [...prev, entry];
            return prev.map((item, index) =>
              index === optimistic ? entry : item,
            );
          });
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
          upsertAssistant(
            `a-${data.turnId}-${data.stepIndex}`,
            String(data.message ?? ""),
          );
          break;
        case "actions.requested": {
          const actions = (data.actions ?? []) as {
            toolName?: string;
            callId?: string;
          }[];
          setEntries((prev) => [
            ...prev,
            ...actions
              .filter(
                (a) => !prev.some((entry) => entry.id === `t-${a.callId}`),
              )
              .map((a) => ({
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
          const result = (data.result ?? {}) as {
            callId?: string;
            output?: unknown;
          };
          setEntries((prev) =>
            prev.map((e) =>
              e.id === `t-${result.callId}`
                ? { ...e, pending: false, text: summarize(result.output) }
                : e,
            ),
          );
          setPending((prev) =>
            prev.filter(
              (request) =>
                request.requestId !== result.callId &&
                request.action?.callId !== result.callId,
            ),
          );
          break;
        }
        case "turn.started":
          setPending([]);
          setStatus("streaming");
          break;
        case "input.requested": {
          // The event that actually carries an approval. It arrives with the
          // full request — tool name, arguments, and the option ids to answer
          // with — so there is nothing to go back and fetch.
          const requests = (data.requests ?? []) as PendingRequest[];
          if (requests.length > 0) {
            setPending((prev) => {
              // Keyed by requestId: eve re-emits a request on stream replay, and
              // rejoining a parked session must not stack duplicate cards.
              const merged = new Map(prev.map((p) => [p.requestId, p]));
              for (const request of requests)
                merged.set(request.requestId, request);
              return [...merged.values()];
            });
            setStatus("waiting");
          }
          break;
        }
        case "input.resolved":
        case "input.completed":
          setPending([]);
          break;
        case "session.waiting":
          setStatus("waiting");
          // Deliberately does NOT touch `pending`.
          //
          // An earlier version cleared it whenever `wait` was
          // "next-user-message", on the assumption that anything else meant a
          // park. eve reports "next-user-message" for an approval park too, so
          // that heuristic wiped the approval card the instant it appeared —
          // the turn sat visibly stuck with no way to answer it. `input.*` is
          // the only honest signal for this; `wait` cannot distinguish them.
          break;
        case "turn.completed":
          setStatus((s) => (s === "cancelling" ? "cancelling" : "waiting"));
          break;
        case "turn.cancelled":
          setStatus("waiting");
          setEntries((prev) => [
            ...prev,
            {
              id: `sys-${prev.length}`,
              role: "system",
              text: "Run cancelled.",
            },
          ]);
          break;
        case "session.completed":
          setStatus("completed");
          setPending([]);
          break;
        case "session.failed":
          setStatus("error");
          setError(
            "This task ended with a failure. Open its evidence to inspect the cause before repeating work.",
          );
          break;
        case "step.failed":
        case "turn.failed": {
          // Without this the UI sat on "running" forever with an empty
          // transcript whenever a turn died — which is exactly what a provider
          // rate limit looks like, and the most likely failure a self-hoster
          // meets on day one. Silence is the worst possible answer there.
          const details = (data.details ?? {}) as { message?: string };
          setStatus("error");
          setError(
            explainFailure(String(data.code ?? "unknown"), details.message),
          );
          break;
        }
        default:
          break;
      }
    },
    [upsertAssistant],
  );

  const reconnect = useCallback(() => {
    if (!sessionId) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setEntries([]);
    setPending([]);
    setError(null);
    setStatus("streaming");
    void consume(sessionId, controller.signal).catch((error) => {
      if (controller.signal.aborted) return;
      setError(error instanceof Error ? error.message : String(error));
      setStatus("error");
    });
  }, [consume, sessionId]);

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
        const body = (await response.json()) as {
          sessionId?: string;
          error?: string;
        };
        if (!response.ok || !body.sessionId)
          throw new Error(body.error ?? "Could not start session");

        setSessionId(body.sessionId);
        setDraft((current) => (current.trim() === message ? "" : current));
        setEntries((prev) => [
          ...prev,
          {
            id: `sent-${Date.now()}`,
            role: "user",
            text: message,
            pending: true,
          },
        ]);
        window.history.replaceState(
          null,
          "",
          `/chat?session=${encodeURIComponent(body.sessionId)}`,
        );
        const controller = new AbortController();
        abortRef.current = controller;
        void consume(body.sessionId, controller.signal).catch((e) => {
          if (controller.signal.aborted) return;
          setError(e instanceof Error ? e.message : String(e));
          setStatus("error");
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setNotice(
          "Your draft is preserved. Delivery could not be confirmed; check recent tasks before sending again to avoid repeating work.",
        );
        setStatus("error");
      }
    },
    [consume],
  );

  const send = useCallback(async () => {
    const message = draft.trim();
    if (
      !message ||
      sendingRef.current ||
      status === "starting" ||
      status === "streaming" ||
      status === "cancelling" ||
      status === "completed"
    )
      return;
    sendingRef.current = true;
    setError(null);
    setNotice(null);

    if (!sessionId) {
      try {
        await start(message);
      } finally {
        sendingRef.current = false;
      }
      return;
    }

    setStatus("streaming");
    try {
      const response = await fetch(
        `/api/control/sessions/${encodeURIComponent(sessionId)}/message`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message }),
        },
      );
      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        throw new Error(body.error ?? `Send failed (${response.status})`);
      }
      setDraft((current) => (current.trim() === message ? "" : current));
      if (!liveStreamRef.current || liveStreamRef.current.aborted) reconnect();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setNotice(
        "Your draft is preserved. Reconnect and check the conversation before sending again; the agent may have received it.",
      );
      setStatus("error");
    } finally {
      sendingRef.current = false;
    }
  }, [draft, sessionId, start, status, reconnect]);

  const cancel = useCallback(async () => {
    if (!sessionId) return;
    setStatus("cancelling");
    setError(null);
    try {
      const response = await fetch(
        `/api/control/sessions/${encodeURIComponent(sessionId)}/cancel`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        },
      );
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        status?: string;
      };
      if (!response.ok)
        throw new Error(
          body.error ?? `Cancellation was not confirmed (${response.status}).`,
        );
      if (body.status === "no_active_turn") setStatus("waiting");
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Cancellation could not be confirmed.",
      );
      setNotice(
        "The task may still be running. Reconnect to check its state before requesting Stop again.",
      );
      setStatus("error");
    }
  }, [sessionId]);

  const busy = status === "starting" || status === "streaming";

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <div>
          <h1>{sessionId ? "Task workspace" : "New task"}</h1>
          <p className="page-sub">
            Describe the result you need. Follow progress and step in when a
            decision needs you.
          </p>
        </div>
        <div className={styles.headRight}>
          <a href="/tasks">Recent tasks</a>
          {sessionId && <a href="/chat">New task</a>}
          {entries.some((entry) => entry.role === "user" && !entry.pending) && (
            <button
              type="button"
              onClick={() => {
                const prompt = entries.find(
                  (entry) => entry.role === "user" && !entry.pending,
                )?.text;
                if (!prompt) return;
                if (prompt.length > 20000) {
                  setNotice(
                    "This request is longer than a routine accepts. Copy a shorter version into Routines.",
                  );
                  return;
                }
                try {
                  sessionStorage.setItem("evestack-routine-draft", prompt);
                  window.location.assign("/routines?draft=task");
                } catch {
                  setNotice(
                    "The browser could not save the draft. Copy your request into a new routine.",
                  );
                }
              }}
            >
              Save request as routine
            </button>
          )}
          <span
            className={`status status-${status === "error" ? "failed" : status === "completed" ? "completed" : "running"}`}
          >
            {STATUS_LABEL[status]}
          </span>
          {sessionId && (
            <a
              className={styles.sessionLink}
              href={`/sessions/${encodeURIComponent(sessionId)}`}
            >
              Cost &amp; evidence
            </a>
          )}
        </div>
      </div>

      {sessionId && <TaskBudget sessionId={sessionId} status={status} />}

      {error && (
        <div role="alert" className={styles.error}>
          {error}
          {sessionId && (
            <>
              {" "}
              <button type="button" onClick={reconnect}>
                Reconnect
              </button>
            </>
          )}
        </div>
      )}
      {notice && (
        <div role="status" className={styles.notice}>
          {notice}
        </div>
      )}
      {status === "completed" && (
        <p className={styles.notice}>
          This task is finished. <a href="/chat">Start a new task</a> for more
          work.
        </p>
      )}

      {status === "cancelling" && (
        <div className={styles.notice}>
          Cancellation is cooperative — the model call already in flight keeps
          streaming until it finishes on its own. This can take a while.
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
          <div
            key={entry.id}
            className={styles[entry.role] ?? styles.assistant}
          >
            {entry.role === "tool" ? (
              <div className={styles.toolCard}>
                <span className={styles.toolName}>{entry.toolName}</span>
                <span
                  className={
                    entry.pending ? styles.toolPending : styles.toolDone
                  }
                >
                  {entry.pending ? "running…" : entry.text || "done"}
                </span>
              </div>
            ) : (
              <div className={styles.bubble}>
                {entry.role === "assistant" ? (
                  <ResultMarkdown text={entry.text} />
                ) : (
                  entry.text
                )}
              </div>
            )}
          </div>
        ))}

        {sessionId &&
          pending.map((request) => (
            <DecisionCard
              key={request.requestId}
              sessionId={sessionId}
              request={request}
              onResolved={(warning) => {
                setPending((prev) =>
                  prev.filter((entry) => entry.requestId !== request.requestId),
                );
                setNotice(warning ?? null);
                setStatus("streaming");
                if (!liveStreamRef.current || liveStreamRef.current.aborted)
                  reconnect();
              }}
            />
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
          aria-label={sessionId ? "Task follow-up" : "Task request"}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              void send();
            }
          }}
          placeholder={sessionId ? "Reply…" : "Ask the agent something…"}
          rows={2}
          disabled={status === "completed"}
        />
        <div className={styles.composerButtons}>
          {busy && sessionId ? (
            <button
              type="button"
              className={styles.cancel}
              onClick={() => void cancel()}
            >
              Stop
            </button>
          ) : (
            <button
              type="submit"
              disabled={
                !draft.trim() ||
                busy ||
                status === "cancelling" ||
                status === "completed"
              }
            >
              {status === "starting" ? "Starting…" : "Send"}
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
