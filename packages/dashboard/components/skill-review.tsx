"use client";
import { useEffect, useRef, useState } from "react";

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
  const lock = useRef(false);
  const path = `/api/skills/${encodeURIComponent(name)}/review`;
  useEffect(() => {
    const controller = new AbortController();
    void fetch(path, { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error);
        setReview(body.review);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message);
      });
    return () => controller.abort();
  }, [path]);
  return (
    <details className="skill-review">
      <summary>
        Content review ·{" "}
        {review
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
              const response = await fetch(path, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ hash, note, verdict }),
              });
              const body = await response.json();
              if (!response.ok) throw new Error(body.error);
              setReview(body.review);
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
          <button type="submit" disabled={busy}>
            {busy ? "Saving…" : "Record review"}
          </button>
        </form>
      )}
    </details>
  );
}
