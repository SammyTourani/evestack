"use client";
import { useEffect, useRef, useState } from "react";
import type { SkillChanges } from "@/lib/skill-fingerprint";

type Review = {
  content_hash: string;
  verdict: string;
  note: string;
  actor: string | null;
  actor_via: string;
  created_at: string;
};
export function SkillReview({
  name,
  hash,
  reviewable,
}: {
  name: string;
  hash: string;
  reviewable: boolean;
}) {
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [verdict, setVerdict] = useState("reviewed");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [changes, setChanges] = useState<SkillChanges | null>(null);
  const [observedHash, setObservedHash] = useState<string | null>(null);
  const lock = useRef(false);
  const path = `/api/skills/${encodeURIComponent(name)}/review`;
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setReview(null);
    setChanges(null);
    setObservedHash(null);
    void fetch(path, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
      cache: "no-store",
    })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error);
        if (!controller.signal.aborted) {
          setReview(body.review);
          setChanges(body.changes ?? null);
          setObservedHash(body.fingerprint?.hash ?? null);
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [path, hash]);
  const pageChanged = observedHash !== null && observedHash !== hash;
  return (
    <details className="skill-review">
      <summary>
        Content review ·{" "}
        {loading
          ? "checking…"
          : pageChanged
            ? "page is out of date"
            : error
              ? "needs attention"
              : review
                ? review.content_hash !== hash
                  ? "changed since review"
                  : review.verdict === "reviewed"
                    ? "context reviewed"
                    : "needs changes"
                : "not reviewed"}
      </summary>
      <p className="page-sub">
        A review records your interpretation of this exact content. It does not
        grant permissions, suppress scanner findings or prove a skill safe. File
        changes reopen the review.
      </p>
      <p className="mono">SHA-256: {hash}</p>
      {pageChanged && (
        <p role="status">
          The files changed after this page loaded. Refresh to inspect their
          current content before saving a review.
        </p>
      )}
      {review && (
        <p>
          {review.note}
          <br />
          <span className="page-sub">
            {review.actor ?? "Unidentified"} via {review.actor_via} ·{" "}
            {new Date(review.created_at).toLocaleString()}
            {review.content_hash !== hash ? " · previous version" : ""}
          </span>
        </p>
      )}
      {review && !pageChanged && changes && (
        <details>
          <summary>Changes since the last review</summary>
          {!changes.available ? (
            <p>
              This review has no usable per-file baseline. Its whole-content
              hash is retained, but individual file changes cannot be
              reconstructed.
            </p>
          ) : (
            <>
              <p>
                {changes.added.length} added · {changes.changed.length} changed
                · {changes.removed.length} removed. This compares file
                fingerprints; previous file contents are not stored by this
                review.
              </p>
              {(["added", "changed", "removed"] as const).map(
                (kind) =>
                  changes[kind].length > 0 && (
                    <div key={kind}>
                      <h4>{kind[0].toUpperCase() + kind.slice(1)}</h4>
                      <ul>
                        {changes[kind].map((path) => (
                          <li key={path} style={{ overflowWrap: "anywhere" }}>
                            <code>{path}</code>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ),
              )}
              {!changes.added.length &&
                !changes.changed.length &&
                !changes.removed.length && (
                  <p>
                    No file changes were found against this review. Review
                    status still depends on the complete content hash above.
                  </p>
                )}
            </>
          )}
        </details>
      )}
      {error && <p role="alert">{error}</p>}
      {!reviewable ? (
        <p>
          A complete review is unavailable while files are unscanned, unreadable
          or executable.
        </p>
      ) : (
        <form
          className="routine-form"
          onSubmit={async (event) => {
            event.preventDefault();
            if (lock.current) return;
            lock.current = true;
            setBusy(true);
            setError(null);
            try {
              if (pageChanged || loading)
                throw new Error(
                  "Refresh and inspect the current content before saving.",
                );
              const response = await fetch(path, {
                method: "POST",
                signal: AbortSignal.timeout(15000),
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ hash, note, verdict }),
              });
              const body = await response.json();
              if (!response.ok) throw new Error(body.error);
              setReview(body.review);
              setChanges(body.changes ?? null);
              setObservedHash(body.fingerprint?.hash ?? null);
            } catch (error) {
              setError(error instanceof Error ? error.message : String(error));
            } finally {
              lock.current = false;
              setBusy(false);
            }
          }}
        >
          <label>
            Review outcome
            <select
              value={verdict}
              onChange={(event) => setVerdict(event.target.value)}
            >
              <option value="reviewed">Context reviewed</option>
              <option value="needs_changes">Needs changes</option>
            </select>
          </label>
          <label>
            Reason and relevant context
            <textarea
              minLength={10}
              maxLength={4000}
              required
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
          <button type="submit" disabled={busy || loading || pageChanged}>
            {busy ? "Saving…" : "Record review"}
          </button>
        </form>
      )}
    </details>
  );
}
