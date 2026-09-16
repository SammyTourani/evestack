"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { RegressionCase } from "@/lib/regressions";
import type { TaskRecovery } from "@/lib/task-recovery";
import { ResultMarkdown } from "@/components/markdown";

type Preview = { id: string; hash: string; evidence: TaskRecovery };
const verdicts: Record<string, string> = {
  observed_pass: "Operator observed a pass",
  observed_fail: "Operator observed a failure",
  needs_review: "Needs further review",
};
const stamp = (value: string | Date) =>
  new Date(value).toISOString().replace("T", " ").slice(0, 19) + " UTC";

function Evidence({
  evidence,
  label,
}: {
  evidence: TaskRecovery;
  label: string;
}) {
  return (
    <section
      className="workspace-section regression-evidence"
      aria-label={label}
    >
      <h3>{label}</h3>
      <p>
        <a href={`/chat?session=${encodeURIComponent(evidence.session.id)}`}>
          Open task
        </a>{" "}
        ·{" "}
        <a href={`/sessions/${encodeURIComponent(evidence.session.id)}`}>
          Inspect diagnostics
        </a>
      </p>
      <p>
        Captured {stamp(evidence.checkedAt)}. Runtime session state:{" "}
        {evidence.session.status}.
      </p>
      <p>
        {evidence.failure
          ? `Recorded failure: ${evidence.failure.code}.`
          : "No failed turn found in this window."}{" "}
        Recorded model: {evidence.completedTurn?.model ?? "not available"}.
      </p>
      <p className="page-sub">
        {evidence.coverage.turnsRead} workflow turns ({evidence.coverage.turns})
        {evidence.coverage.turnsTruncated ? " · older turns omitted" : ""};{" "}
        {evidence.coverage.tracesRead} matching spans (
        {evidence.coverage.traces})
        {evidence.coverage.tracesTruncated ? " · older spans omitted" : ""}.
        Agent build and execution isolation have not been verified.
      </p>
      {evidence.response ? (
        <details>
          <summary>
            Saved response text
            {evidence.response.truncated ? " · truncated" : ""}
          </summary>
          <p className="page-sub">
            May be partial or intermediate. Review the original task and
            external evidence.
          </p>
          <ResultMarkdown text={evidence.response.text} />
        </details>
      ) : (
        <p className="page-sub">
          No response text was found in the retained trace window. Use the task
          and your review notes for missing evidence.
        </p>
      )}
    </section>
  );
}

function EvidencePicker({
  label,
  initialId = "",
  onReady,
}: {
  label: string;
  initialId?: string;
  onReady: (preview: Preview | null) => void;
}) {
  const [id, setId] = useState(initialId),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null),
    generation = useRef(0);
  const [search, setSearch] = useState(""),
    [choices, setChoices] = useState<
      { id: string; title: string | null; outcome: string }[]
    >([]),
    [choosing, setChoosing] = useState(false),
    [choiceError, setChoiceError] = useState<string | null>(null),
    [didFind, setDidFind] = useState(false);
  const choiceRequest = useRef<AbortController | null>(null);
  async function findTasks() {
    choiceRequest.current?.abort();
    const controller = new AbortController();
    choiceRequest.current = controller;
    setChoosing(true);
    setChoiceError(null);
    try {
      const response = await fetch(
        `/api/tasks?limit=20&q=${encodeURIComponent(search)}`,
        {
          cache: "no-store",
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(15000),
          ]),
        },
      );
      const body = await response.json();
      if (!response.ok || !Array.isArray(body.tasks))
        throw new Error("Task search is unavailable.");
      if (!controller.signal.aborted) {
        setChoices(body.tasks.slice(0, 20));
        setDidFind(true);
      }
    } catch (cause) {
      if (!controller.signal.aborted)
        setChoiceError(
          cause instanceof Error
            ? cause.message
            : "Task search is unavailable.",
        );
    } finally {
      if (!controller.signal.aborted) setChoosing(false);
    }
  }
  async function load(value: string) {
    const turn = ++generation.current;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError(null);
    onReady(null);
    try {
      const response = await fetch(
        `/api/tasks/${encodeURIComponent(value.trim())}/recovery`,
        {
          cache: "no-store",
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(15000),
          ]),
        },
      );
      const body = await response.json();
      if (!response.ok || !body.ok || !body.recovery || !body.evidenceHash)
        throw new Error(body.error ?? "Task evidence is unavailable.");
      if (turn === generation.current)
        onReady({
          id: value.trim(),
          hash: body.evidenceHash,
          evidence: body.recovery,
        });
    } catch (cause) {
      if (turn === generation.current && !controller.signal.aborted)
        setError(
          cause instanceof Error
            ? cause.message
            : "Task evidence is unavailable.",
        );
    } finally {
      if (turn === generation.current) setBusy(false);
    }
  }
  useEffect(() => {
    if (initialId) void load(initialId);
    return () => {
      generation.current++;
      request.current?.abort();
      choiceRequest.current?.abort();
    };
  }, [initialId]);
  const inputId = `regression-${label.toLowerCase().replaceAll(" ", "-")}`;
  return (
    <div className="regression-picker">
      <label htmlFor={`${inputId}-search`}>
        Find {label.toLowerCase()} task by title
      </label>
      <input
        id={`${inputId}-search`}
        type="search"
        maxLength={200}
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder="Search tasks, or leave blank for recent work"
      />
      <button
        type="button"
        disabled={choosing}
        onClick={() => void findTasks()}
      >
        {choosing ? "Finding tasks…" : "Find tasks"}
      </button>
      {choiceError && <p role="alert">{choiceError}</p>}
      {didFind && !choosing && !choiceError && choices.length === 0 && (
        <p>
          No matching tasks. Try a shorter title or open{" "}
          <a href="/tasks">Tasks</a>.
        </p>
      )}
      {choices.length > 0 && (
        <>
          <label htmlFor={`${inputId}-choice`}>
            Choose {label.toLowerCase()} task
          </label>
          <select
            id={`${inputId}-choice`}
            value={choices.some((task) => task.id === id) ? id : ""}
            onChange={(event) => {
              setId(event.target.value);
              if (event.target.value) void load(event.target.value);
            }}
          >
            <option value="">Select a task…</option>
            {choices.map((task) => (
              <option key={task.id} value={task.id}>
                {(task.title ?? task.id).slice(0, 100)} · {task.outcome}
              </option>
            ))}
          </select>
          <p className="page-sub">
            Up to 20 most recent matches. Narrow the title search to find older
            work.
          </p>
        </>
      )}
      <details>
        <summary>Use a task ID</summary>
        <label htmlFor={inputId}>{label} task ID</label>
        <input
          id={inputId}
          value={id}
          maxLength={300}
          onChange={(event) => {
            generation.current++;
            request.current?.abort();
            setBusy(false);
            setId(event.target.value);
            onReady(null);
            setError(null);
          }}
        />
      </details>
      <button
        type="button"
        disabled={busy || !id.trim()}
        onClick={() => void load(id)}
      >
        {busy ? "Reading evidence…" : `Load ${label.toLowerCase()} evidence`}
      </button>
      {error && <p role="alert">{error}</p>}
      <p className="page-sub">
        Loading reads saved storage; it does not run the task.
      </p>
    </div>
  );
}

function CaseFields({
  title,
  correction,
  expected,
  setTitle,
  setCorrection,
  setExpected,
}: {
  title: string;
  correction: string;
  expected: string;
  setTitle: (value: string) => void;
  setCorrection: (value: string) => void;
  setExpected: (value: string) => void;
}) {
  return (
    <div className="regression-fields">
      <label htmlFor="case-title">Case title</label>
      <input
        id="case-title"
        required
        minLength={3}
        maxLength={120}
        value={title}
        onChange={(event) => setTitle(event.target.value)}
      />
      <label htmlFor="case-correction">What needs correction?</label>
      <textarea
        id="case-correction"
        required
        minLength={10}
        maxLength={4000}
        rows={4}
        value={correction}
        onChange={(event) => setCorrection(event.target.value)}
      />
      <label htmlFor="case-expected">
        Expected behavior and evidence to check
      </label>
      <textarea
        id="case-expected"
        required
        minLength={10}
        maxLength={8000}
        rows={5}
        value={expected}
        onChange={(event) => setExpected(event.target.value)}
      />
    </div>
  );
}
async function save(url: string, body: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const result = await response.json();
  if (!response.ok || !result.ok)
    throw new Error(
      result.error ??
        "The write is not confirmed. Inspect the saved case before retrying.",
    );
  return result;
}

export function NewRegressionCase({ initialTask }: { initialTask?: string }) {
  const router = useRouter(),
    [baseline, setBaseline] = useState<Preview | null>(null);
  const [title, setTitle] = useState(""),
    [correction, setCorrection] = useState(""),
    [expected, setExpected] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const lock = useRef(false),
    requestId = useRef<string | null>(null);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (lock.current || !baseline) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    requestId.current ??= crypto.randomUUID();
    try {
      await save("/api/regressions", {
        id: requestId.current,
        title,
        correction,
        expected,
        baselineId: baseline.id,
        baselineHash: baseline.hash,
      });
      router.push(`/regressions/${requestId.current}`);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "The save is not confirmed.",
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      <EvidencePicker
        label="Original"
        initialId={initialTask}
        onReady={setBaseline}
      />
      {baseline && (
        <Evidence
          evidence={baseline.evidence}
          label="Original evidence preview"
        />
      )}
      <form onSubmit={submit} className="workspace-section regression-form">
        <CaseFields
          {...{
            title,
            correction,
            expected,
            setTitle,
            setCorrection,
            setExpected,
          }}
        />
        <p>
          Saving retains this evidence snapshot, correction and attribution in
          Postgres. It creates no new agent task and applies no model or tool
          changes.
        </p>
        {error && (
          <p role="alert">
            {error}
            {requestId.current && (
              <>
                {" "}
                <a href={`/regressions/${requestId.current}`}>
                  Check whether this case was saved
                </a>
              </>
            )}
          </p>
        )}
        <button
          className="primary-action"
          type="submit"
          disabled={
            busy ||
            !baseline ||
            baseline.evidence.coverage.turns !== "available"
          }
        >
          {busy ? "Saving…" : "Save regression case"}
        </button>
      </form>
    </>
  );
}

export function CaseWorkspace({ regression }: { regression: RegressionCase }) {
  const current = regression.current,
    router = useRouter();
  const [title, setTitle] = useState(current.title),
    [correction, setCorrection] = useState(current.correction),
    [expected, setExpected] = useState(current.expected);
  const [candidate, setCandidate] = useState<Preview | null>(null),
    [verdict, setVerdict] = useState("needs_review"),
    [note, setNote] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [notice, setNotice] = useState<string | null>(null);
  const lock = useRef(false),
    reviewId = useRef<string | null>(null);
  async function mutate(kind: "revision" | "review", event: React.FormEvent) {
    event.preventDefault();
    if (lock.current) return;
    if (kind === "review" && !candidate) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (kind === "revision")
        await save(`/api/regressions/${current.case_id}`, {
          revision: current.revision,
          title,
          correction,
          expected,
        });
      else {
        reviewId.current ??= crypto.randomUUID();
        await save(`/api/regressions/${current.case_id}/reviews`, {
          id: reviewId.current,
          revision: current.revision,
          candidateId: candidate!.id,
          candidateHash: candidate!.hash,
          verdict,
          note,
        });
        reviewId.current = null;
      }
      setNotice(
        kind === "revision"
          ? "A new case revision was saved."
          : "Manual observation recorded. No automated test was run.",
      );
      router.refresh();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "The save is not confirmed.",
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const currentReviews = regression.reviews.filter(
    (review) => review.revision === current.revision,
  );
  return (
    <>
      <div className="workspace-heading">
        <div>
          <h1>{current.title}</h1>
          <p className="page-sub">
            Case revision {current.revision} ·{" "}
            {currentReviews.length
              ? "Manual observations recorded"
              : "No candidate reviewed for this revision"}
          </p>
        </div>
        <a href="/regressions">All cases</a>
      </div>
      <section className="workspace-section">
        <h2>Correction to check</h2>
        <p className="regression-text">{current.correction}</p>
        <h3>Expected behavior</h3>
        <p className="regression-text">{current.expected}</p>
        <p className="page-sub">
          Recorded by {current.actor ?? "unidentified"} ({current.actor_via}) at{" "}
          {stamp(current.created_at)}. Shared credentials identify an
          installation; proxy identities depend on the proxy's trust
          configuration.
        </p>
      </section>
      {error && (
        <p role="alert">
          {error}{" "}
          <a href={`/regressions/${current.case_id}`}>Reload saved history</a>
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <details className="workspace-section">
        <summary>Edit the expected behavior</summary>
        <form
          className="regression-form"
          onSubmit={(event) => void mutate("revision", event)}
        >
          <CaseFields
            {...{
              title,
              correction,
              expected,
              setTitle,
              setCorrection,
              setExpected,
            }}
          />
          <p>
            A new revision preserves the original evidence and earlier reviews.
            Earlier observations do not verify the edited expectation.
          </p>
          <button type="submit" disabled={busy}>
            Save new case revision
          </button>
        </form>
      </details>
      <section className="workspace-section">
        <h2>Compare a later task</h2>
        <p>
          Run a corrected task separately, inspect its result, then load it
          here. This comparison does not start a replay or provide an isolated
          test environment.
        </p>
        <EvidencePicker label="Candidate" onReady={setCandidate} />
      </section>
      <div className="workspace-grid">
        <Evidence
          evidence={current.baseline}
          label="Original baseline snapshot"
        />
        {candidate && (
          <Evidence
            evidence={candidate.evidence}
            label="Candidate snapshot preview"
          />
        )}
      </div>
      {candidate && (
        <form
          className="workspace-section regression-form"
          onSubmit={(event) => void mutate("review", event)}
        >
          <h2>Record a manual observation for revision {current.revision}</h2>
          <label htmlFor="candidate-verdict">Your observation</label>
          <select
            id="candidate-verdict"
            value={verdict}
            onChange={(event) => setVerdict(event.target.value)}
          >
            {Object.entries(verdicts).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <label htmlFor="candidate-note">
            Evidence and remaining uncertainty
          </label>
          <textarea
            id="candidate-note"
            required
            minLength={10}
            maxLength={4000}
            rows={4}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
          <p>
            This is your judgment about the captured candidate, not an automated
            eval result. Include source links and checks that support it.
          </p>
          {candidate.id === current.baseline_session_id && (
            <p role="alert">
              Choose a different task from the original baseline.
            </p>
          )}
          <button
            type="submit"
            disabled={
              busy ||
              candidate.id === current.baseline_session_id ||
              candidate.evidence.coverage.turns !== "available"
            }
          >
            {busy ? "Saving…" : "Record manual observation"}
          </button>
        </form>
      )}
      <section className="workspace-section">
        <h2>Review history</h2>
        <p className="page-sub">
          Latest {regression.historyLimit} observations. Snapshots and notes
          remain in Postgres and backups until removed under your retention
          policy.
        </p>
        {regression.reviews.length === 0 ? (
          <p>No candidate observations recorded.</p>
        ) : (
          regression.reviews.map((review) => (
            <details key={review.id}>
              <summary>
                Revision {review.revision} ·{" "}
                {verdicts[review.verdict] ?? review.verdict} ·{" "}
                {stamp(review.created_at)}
              </summary>
              <p className="regression-text">{review.note}</p>
              <p className="page-sub">
                Manual judgment by {review.actor ?? "unidentified"} (
                {review.actor_via}).
              </p>
              <Evidence
                evidence={review.candidate}
                label="Reviewed candidate snapshot"
              />
            </details>
          ))
        )}
      </section>
      <details className="workspace-section">
        <summary>Case revisions · latest {regression.historyLimit}</summary>
        {regression.versions.map((version) => (
          <section key={version.revision}>
            <h3>Revision {version.revision}</h3>
            <p>
              {stamp(version.created_at)} · {version.actor ?? "unidentified"} (
              {version.actor_via})
            </p>
            <p className="regression-text">{version.correction}</p>
            <p className="regression-text">Expected: {version.expected}</p>
          </section>
        ))}
      </details>
      <a href={`/api/regressions/${current.case_id}`}>
        Open case JSON with captured evidence
      </a>
    </>
  );
}
