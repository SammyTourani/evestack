"use client";
import { useRef, useState } from "react";
import type { MemoryRow } from "@/lib/memories";
import type { MemoryReview } from "@/lib/memory-reviews";
import { MEMORY_DRAFT_KEY } from "@/lib/task-examples";

const LABELS: Record<MemoryReview["verdict"], string> = {
  reviewed: "Reviewed",
  stale: "Stale",
  conflicting: "Conflicting",
  correction_proposed: "Correction proposed",
};
export function MemoryReviewPanel({
  memory,
  latest,
}: {
  memory: MemoryRow;
  latest?: MemoryReview;
}) {
  const [current, setCurrent] = useState(latest);
  const [history, setHistory] = useState<MemoryReview[] | null>(null);
  const [verdict, setVerdict] = useState<MemoryReview["verdict"]>("reviewed");
  const [note, setNote] = useState("");
  const [proposed, setProposed] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const locked = useRef(false);
  const loading = useRef(false);
  const revision = useRef(0);

  async function load() {
    if (loading.current) return;
    loading.current = true;
    const generation = revision.current;
    setError(null);
    try {
      const response = await fetch(`/api/memories/${memory.id}/review`, {
        signal: AbortSignal.timeout(10_000),
        cache: "no-store",
      });
      const body = await response.json();
      if (!response.ok)
        throw new Error(body.error ?? "Review history unavailable.");
      if (generation !== revision.current) return;
      setHistory(body.reviews);
      setCurrent(body.reviews[0]);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Review history unavailable.",
      );
    } finally {
      loading.current = false;
    }
  }
  async function save() {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/memories/${memory.id}/review`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          hash: memory.hash,
          verdict,
          note,
          ...(verdict === "correction_proposed"
            ? { proposedContent: proposed }
            : {}),
        }),
      });
      const body = await response.json();
      if (!response.ok)
        throw new Error(body.error ?? "Review could not be saved.");
      revision.current++;
      setCurrent(body.review);
      setHistory((rows) => [body.review, ...(rows ?? [])].slice(0, 20));
      setNotice(
        verdict === "correction_proposed"
          ? "Proposal recorded. The original memory is still in recall; the correction has not been applied."
          : "Review recorded. This label does not remove the memory from recall.",
      );
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Review could not be confirmed. Check history before repeating it.",
      );
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  function draftCorrection() {
    if (!current?.proposedContent || current.memoryHash !== memory.hash) return;
    const prompt = `Review the proposed correction to memory #${memory.id}. Recorded owner: ${memory.principalId ?? "unknown (legacy record)"}. Check the current record and caller's memory permissions before changing it. Do not change its owner or sharing. If this caller cannot modify it, explain what the operator needs to do.\n\nOperator's proposed correction:\n${current.proposedContent}\n\nReason:\n${current.note}\n\nUse the supported memory tools to compute a new embedding. Preserve the original until the replacement is confirmed. Report what actually changed, including memory IDs, and verify the result. A saved proposal is not an applied correction.`;
    if (prompt.length > 20_000) {
      setError(
        "Shorten the proposal before opening a task; task drafts accept 20,000 characters.",
      );
      return;
    }
    try {
      sessionStorage.setItem(MEMORY_DRAFT_KEY, prompt);
      window.location.assign("/chat?draft=memory");
    } catch {
      setError(
        "Browser draft storage is unavailable. Copy the proposal into a new task.",
      );
    }
  }
  const stale = current && current.memoryHash !== memory.hash;
  return (
    <details
      className="memory-review"
      onToggle={(event) => {
        if (event.currentTarget.open && history === null) void load();
      }}
    >
      <summary>
        {stale
          ? "Changed since review"
          : current
            ? LABELS[current.verdict]
            : "Review or propose a correction"}
      </summary>
      <p>
        Reviews describe the exact record you saw. Text corrections need a new
        embedding; a proposal leaves the original unchanged.
      </p>
      {current && (
        <div className="workspace-section">
          <strong>
            {LABELS[current.verdict]}
            {stale ? " · earlier version" : ""}
          </strong>
          <p>{current.note}</p>
          {current.proposedContent && (
            <>
              <h4>Proposed replacement</h4>
              <p style={{ whiteSpace: "pre-wrap" }}>
                {current.proposedContent}
              </p>
              {!stale && (
                <button type="button" onClick={draftCorrection}>
                  Prepare correction task
                </button>
              )}
            </>
          )}
        </div>
      )}
      <div className="routine-form">
        <label>
          Review
          <select
            value={verdict}
            onChange={(event) =>
              setVerdict(event.target.value as MemoryReview["verdict"])
            }
          >
            {Object.entries(LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Reason and evidence
          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            minLength={10}
            maxLength={2000}
            rows={3}
          />
        </label>
        {verdict === "correction_proposed" && (
          <label>
            Proposed replacement
            <textarea
              value={proposed}
              onChange={(event) => setProposed(event.target.value)}
              maxLength={20_000}
              rows={4}
            />
          </label>
        )}
        <button
          type="button"
          onClick={() => void save()}
          disabled={
            busy ||
            note.trim().length < 10 ||
            (verdict === "correction_proposed" && !proposed.trim())
          }
        >
          {busy ? "Saving…" : "Record memory review"}
        </button>
      </div>
      {error && (
        <p role="alert">
          {error} <a href="/memory">Refresh memory records</a>.
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <details>
        <summary>Review history</summary>
        {history === null ? (
          <p>History has not loaded.</p>
        ) : history.length === 0 ? (
          <p>No reviews recorded.</p>
        ) : (
          <ul>
            {history.map((row) => (
              <li key={row.id}>
                <strong>{LABELS[row.verdict]}</strong> ·{" "}
                {new Date(row.createdAt).toLocaleString()} ·{" "}
                {row.actor ?? "unidentified"} ({row.actorVia})<p>{row.note}</p>
              </li>
            ))}
          </ul>
        )}
        <p className="page-sub">
          Latest 20 reviews. Stored proposals and source snapshots remain in
          Postgres after a memory is removed. Shared credentials identify the
          installation.
        </p>
        <button type="button" onClick={() => void load()}>
          Refresh review history
        </button>
      </details>
    </details>
  );
}
