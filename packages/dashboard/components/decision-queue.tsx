"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DecisionQueue as Queue } from "@/lib/pending-decisions";
import { DecisionCard } from "./decision-card";

export function DecisionQueue() {
  const [queue, setQueue] = useState<Queue | null>(null);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const active = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/approvals/pending?offset=${offset}`, {
        signal: controller.signal,
      });
      const body = await response.json();
      if (!response.ok)
        throw new Error(body.error ?? "Pending decisions are unavailable.");
      setQueue(body.queue);
    } catch (error) {
      if (!controller.signal.aborted)
        setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }, [offset]);
  useEffect(() => {
    void refresh();
    return () => active.current?.abort();
  }, [refresh]);
  return (
    <section className="workspace-section" aria-label="Pending decisions">
      <div className="workspace-heading">
        <h2>
          Needs your decision{" "}
          {queue ? `(${queue.items.length} on this page)` : ""}
        </h2>
        <button type="button" onClick={() => void refresh()} disabled={busy}>
          {busy ? "Checking…" : "Refresh decisions"}
        </button>
      </div>
      {error && (
        <p role="alert">
          {error} The queue could not be refreshed; previously shown requests
          may have changed.
        </p>
      )}
      {warning && <p role="status">{warning}</p>}
      {!queue && !error && (
        <p role="status">Checking open tasks for requests…</p>
      )}
      {queue && (
        <>
          {queue.unknown.length > 0 && (
            <p className="page-sub">
              State could not be confirmed for {queue.unknown.length} tasks on
              this page. Check agent health in <a href="/settings">Settings</a>.
            </p>
          )}
          {queue.items.length === 0 && (
            <p>
              {queue.unknown.length > 0
                ? "No decisions confirmed in the reachable tasks on this page."
                : "No pending decisions in the tasks checked on this page."}
            </p>
          )}
          {queue.items.map(({ sessionId, title, request }) => (
            <div
              key={`${sessionId}/${request.requestId}`}
              className="decision-entry"
            >
              <a href={`/chat?session=${encodeURIComponent(sessionId)}`}>
                {title ?? sessionId}
              </a>
              <DecisionCard
                sessionId={sessionId}
                request={request}
                onResolved={(notice) => {
                  setWarning(notice ?? null);
                  setQueue(
                    (current) =>
                      current && {
                        ...current,
                        items: current.items.filter(
                          (entry) =>
                            entry.sessionId !== sessionId ||
                            entry.request.requestId !== request.requestId,
                        ),
                      },
                  );
                }}
              />
            </div>
          ))}
          <p className="page-sub">
            {queue.checked} tasks checked · {queue.candidates} open sessions in
            this installation. Idle conversations can remain open.
          </p>
          <div className="workspace-actions">
            {offset > 0 && (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setQueue(null);
                  setOffset(Math.max(0, offset - 20));
                }}
              >
                Previous tasks
              </button>
            )}
            {queue.nextOffset !== null && (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setQueue(null);
                  setOffset(queue.nextOffset!);
                }}
              >
                Check next tasks
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
