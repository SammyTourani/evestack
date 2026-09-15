"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Routine, RoutineRun } from "@/lib/routines";

const EXAMPLE =
  "Prepare a repository maintenance brief for [owner/repository]. Review recent changes, failing checks and issues needing attention. Include supporting links and suggested next steps. Read and report only; do not change files, issues or settings, and do not send messages. If access is unavailable, explain what is missing.";
const empty = () => ({
  name: "",
  prompt: "",
  cron: "0 9 * * 1-5",
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  enabled: false,
  resultReviewed: false,
});
type Editor = ReturnType<typeof empty>;
type Clock = {
  running: boolean;
  lastTick: string | null;
  error: string | null;
};

async function request(path: string, options?: RequestInit) {
  const response = await fetch(
    path,
    options ?? { signal: AbortSignal.timeout(10000) },
  );
  const body = await response.json();
  if (!response.ok)
    throw new Error(body.error ?? `Request failed (${response.status}).`);
  return body;
}
const write = (method: string, body: unknown) => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export function RoutinesClient() {
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [selected, setSelected] = useState<Routine | null>(null);
  const [editor, setEditor] = useState<Editor>({
    name: "",
    prompt: "",
    cron: "0 9 * * 1-5",
    timeZone: "UTC",
    enabled: false,
    resultReviewed: false,
  });
  const [runs, setRuns] = useState<RoutineRun[]>([]);
  const [clock, setClock] = useState<Clock | null>(null);
  const [times, setTimes] = useState<{ utc: string; local: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [changedElsewhere, setChangedElsewhere] = useState(false);
  const lock = useRef(false);
  const requestKey = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    const body = await request("/api/routines");
    setRoutines(body.routines);
    setClock(body.clock);
  }, []);
  useEffect(() => {
    let initial = empty();
    if (new URLSearchParams(window.location.search).get("draft") === "task") {
      try {
        const prompt = sessionStorage.getItem("evestack-routine-draft");
        if (prompt && prompt.length <= 20000) {
          initial = { ...initial, prompt };
          setNotice(
            "Request copied into a new routine draft. Give it a name, save, and test before enabling.",
          );
        }
        sessionStorage.removeItem("evestack-routine-draft");
      } catch {
        setError(
          "The browser could not load the draft. Copy your task request into the form.",
        );
      }
    }
    setEditor(initial);
    void (async () => {
      await refresh();
      const id = new URLSearchParams(window.location.search).get("routine");
      if (id && /^[0-9a-f-]{36}$/i.test(id)) {
        const body = await request(`/api/routines/${id}`);
        fill(body.routine);
        setRuns(body.runs);
        setClock(body.clock);
      }
    })()
      .catch((error) => setError(error.message))
      .finally(() => setLoading(false));
  }, [refresh]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (!lock.current)
        void refresh().catch((error) =>
          setError(
            `Clock and routine list could not be refreshed: ${error.message}`,
          ),
        );
    }, 15000);
    return () => clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    if (!selected) return;
    const id = selected.id;
    let stopped = false;
    const timer = setInterval(() => {
      if (lock.current) return;
      void request(`/api/routines/${id}`)
        .then((body) => {
          if (!stopped) {
            setRuns(body.runs);
            setClock(body.clock);
            setHistoryError(null);
            setChangedElsewhere(body.routine.revision !== selected.revision);
          }
        })
        .catch((error) => {
          if (!stopped)
            setHistoryError(
              `Run history is stale: ${error.message}. Use Refresh history to check again.`,
            );
        });
    }, 5000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [selected?.id, selected?.revision]);

  async function action(work: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await work();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  function fill(routine: Routine) {
    setHistoryError(null);
    setChangedElsewhere(false);
    setSelected(routine);
    requestKey.current = null;
    setTimes([]);
    setEditor({
      name: routine.name,
      prompt: routine.prompt,
      cron: routine.cron,
      timeZone: routine.time_zone,
      enabled: routine.enabled,
      resultReviewed: false,
    });
  }
  async function open(routine: Routine) {
    await action(async () => {
      const body = await request(`/api/routines/${routine.id}`);
      fill(body.routine);
      setRuns(body.runs);
      setClock(body.clock);
    });
  }
  async function save(override: Partial<Editor> & { archived?: boolean } = {}) {
    await action(async () => {
      const body = await request(
        selected ? `/api/routines/${selected.id}` : "/api/routines",
        write(selected ? "PATCH" : "POST", {
          ...editor,
          revision: selected?.revision,
          ...override,
        }),
      );
      await refresh();
      if (body.routine.archived) {
        setSelected(null);
        setEditor(empty());
        setRuns([]);
        setNotice(
          "Routine archived. Already dispatched work keeps its task and history.",
        );
      } else {
        fill(body.routine);
        setNotice(
          body.routine.enabled
            ? "Schedule enabled. Inspect upcoming runs and keep the dashboard running."
            : "Saved paused. Run once, inspect the result, then enable the schedule.",
        );
      }
    });
  }
  function change<K extends keyof Editor>(key: K, value: Editor[K]) {
    setEditor((current) => ({ ...current, [key]: value }));
    if (key === "cron" || key === "timeZone") setTimes([]);
  }
  const active = runs.some((run) =>
    [
      "claimed",
      "dispatching",
      "running",
      "awaiting_approval",
      "unknown",
    ].includes(run.state),
  );

  return (
    <>
      <div className="workspace-heading">
        <div>
          <h1>Routines</h1>
          <p className="page-sub">
            Test useful work once, then run it on a schedule.
          </p>
        </div>
        <button
          className="primary-action"
          disabled={busy}
          onClick={() => {
            setSelected(null);
            setEditor(empty());
            setRuns([]);
            setTimes([]);
            setError(null);
            setNotice(null);
          }}
        >
          New routine
        </button>
      </div>
      <p className="page-sub">
        <a href="/schedules">Developer schedules &amp; heartbeat history</a> use
        the agent's own scheduling path.
      </p>
      {clock && (
        <p role="status" className="routine-clock">
          Dashboard clock:{" "}
          {clock.running
            ? clock.error
              ? `needs attention — ${clock.error}`
              : clock.lastTick
                ? "running"
                : "starting"
            : "stopped"}
          . It must remain running to dispatch and reconcile routines. Last
          successful tick:{" "}
          {clock.lastTick
            ? new Date(clock.lastTick).toLocaleString()
            : "not yet confirmed"}
          .
        </p>
      )}
      {error && (
        <p className="routine-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="workspace-section" role="status">
          {notice}
        </p>
      )}
      {changedElsewhere && (
        <p className="routine-error" role="status">
          This routine changed since you opened it. Your unsaved edits are
          preserved. Select the routine again to load its current saved version
          before editing.
        </p>
      )}
      <div className="routine-layout">
        <section aria-label="Saved routines">
          <h2>Your routines</h2>
          {loading ? (
            <p>Loading routines…</p>
          ) : routines.length === 0 ? (
            <p>No routines yet. Start with an editable brief.</p>
          ) : (
            routines.map((routine) => (
              <button
                className={`routine-item${selected?.id === routine.id ? " routine-selected" : ""}`}
                key={routine.id}
                disabled={busy}
                onClick={() => void open(routine)}
              >
                <strong>{routine.name}</strong>
                <span>
                  {routine.enabled ? "Scheduled" : "Paused"} ·{" "}
                  {routine.time_zone}
                </span>
                <span>
                  {routine.enabled
                    ? `Next: ${new Date(routine.next_due).toLocaleString(undefined, { timeZone: routine.time_zone, timeZoneName: "short" })}`
                    : "Open to test or enable"}
                </span>
              </button>
            ))
          )}
          <button
            className="routine-item"
            disabled={busy}
            onClick={() => {
              setSelected(null);
              setEditor({
                ...empty(),
                name: "Repository maintenance brief",
                prompt: EXAMPLE,
              });
              setRuns([]);
              setTimes([]);
            }}
          >
            Use repository brief example
          </button>
        </section>
        <section className="workspace-section">
          <h2>{selected ? "Edit routine" : "Create a routine"}</h2>
          <form
            className="routine-form"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <label>
              Name
              <input
                required
                value={editor.name}
                maxLength={120}
                onChange={(event) => change("name", event.target.value)}
              />
            </label>
            <label>
              Task request
              <textarea
                required
                rows={7}
                value={editor.prompt}
                maxLength={20000}
                onChange={(event) => change("prompt", event.target.value)}
                placeholder="Describe the result, repository or resources, and what needs your decision."
              />
            </label>
            <p className="page-sub">
              The agent's tool permissions and budget settings govern execution.
              A request saying “read only” is guidance; verify the connected
              account and tool permissions before enabling unattended work.
            </p>
            <label>
              Schedule preset
              <select
                value=""
                onChange={(event) => {
                  if (event.target.value) change("cron", event.target.value);
                }}
              >
                <option value="">Choose a preset or edit cron below</option>
                <option value="0 9 * * *">Daily at 09:00</option>
                <option value="0 9 * * 1-5">Weekdays at 09:00</option>
                <option value="0 9 * * 1">Weekly on Monday at 09:00</option>
                <option value="0 * * * *">Every hour</option>
              </select>
            </label>
            <div className="workspace-grid">
              <label>
                Five-field cron
                <input
                  required
                  value={editor.cron}
                  maxLength={120}
                  onChange={(event) => change("cron", event.target.value)}
                />
              </label>
              <label>
                Time zone
                <input
                  required
                  value={editor.timeZone}
                  maxLength={100}
                  onChange={(event) => change("timeZone", event.target.value)}
                  placeholder="America/Toronto"
                />
              </label>
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  const body = await request(
                    "/api/routines/preview",
                    write("POST", {
                      cron: editor.cron,
                      timeZone: editor.timeZone,
                    }),
                  );
                  setTimes(body.times);
                })
              }
            >
              Preview next 3 runs
            </button>
            {times.length > 0 && (
              <ol>
                {times.map((time) => (
                  <li key={time.utc}>
                    {time.local}
                    <br />
                    <span className="page-sub">{time.utc} UTC</span>
                  </li>
                ))}
              </ol>
            )}
            <p className="page-sub">
              After downtime, only the latest missed occurrence runs. Earlier
              occurrences are skipped. An active or uncertain run blocks another
              run of this routine. During daylight-saving changes, a skipped
              local time runs at the first valid minute; repeated local times
              run once.
            </p>
            <label className="routine-check">
              <input
                type="checkbox"
                checked={editor.enabled}
                onChange={(event) => change("enabled", event.target.checked)}
              />
              Enable schedule after a successful test
            </label>
            {editor.enabled && (
              <label className="routine-check">
                <input
                  type="checkbox"
                  checked={editor.resultReviewed}
                  onChange={(event) =>
                    change("resultReviewed", event.target.checked)
                  }
                />
                I inspected this prompt's test result and its account
                permissions.
              </label>
            )}
            <div className="workspace-actions">
              <button className="primary-action" disabled={busy} type="submit">
                {busy ? "Working…" : "Save routine"}
              </button>
              {selected && (
                <>
                  <button
                    type="button"
                    disabled={busy || active || !clock?.running}
                    onClick={() =>
                      void action(async () => {
                        requestKey.current ??= crypto.randomUUID();
                        const body = await request(
                          `/api/routines/${selected.id}/run`,
                          write("POST", { requestId: requestKey.current }),
                        );
                        requestKey.current = null;
                        setRuns((current) => [
                          body.run,
                          ...current.filter((run) => run.id !== body.run.id),
                        ]);
                        setNotice(
                          "Test queued using the saved prompt. Follow its task below; the dashboard clock will dispatch it.",
                        );
                      })
                    }
                  >
                    Run saved prompt now
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void save({ enabled: false })}
                  >
                    Pause
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void save({ enabled: false, archived: true })
                    }
                  >
                    Archive
                  </button>
                </>
              )}
            </div>
          </form>
        </section>
      </div>
      {selected && (
        <section className="workspace-section">
          <div className="workspace-heading">
            <h2>Run history · {selected.name}</h2>
            <button
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  const body = await request(`/api/routines/${selected.id}`);
                  setRuns(body.runs);
                  setClock(body.clock);
                  setHistoryError(null);
                  setChangedElsewhere(
                    body.routine.revision !== selected.revision,
                  );
                  await refresh();
                })
              }
            >
              Refresh history
            </button>
          </div>
          {historyError && (
            <p role="alert" className="routine-error">
              {historyError}
            </p>
          )}
          {runs.length === 0 ? (
            <p>
              No runs yet. Run the saved prompt once before enabling the
              schedule.
            </p>
          ) : (
            runs.map((run) => (
              <article className="task-card" key={run.id}>
                <div className="workspace-heading">
                  <strong>{run.state.replaceAll("_", " ")}</strong>
                  <span>
                    {run.trigger} ·{" "}
                    {new Date(run.scheduled_at).toLocaleString()} · revision{" "}
                    {run.revision}
                  </span>
                </div>
                {run.snapshot.catchupFrom && (
                  <p>
                    Earlier missed occurrences since{" "}
                    {new Date(run.snapshot.catchupFrom).toLocaleString()} were
                    skipped.
                  </p>
                )}
                {run.error && <p role="status">{run.error}</p>}
                {run.session_id && (
                  <div className="workspace-actions">
                    <a
                      href={`/chat?session=${encodeURIComponent(run.session_id)}`}
                    >
                      Open result / respond
                    </a>
                    <a href={`/sessions/${encodeURIComponent(run.session_id)}`}>
                      Cost &amp; evidence
                    </a>
                  </div>
                )}
                {run.state === "unknown" && (
                  <>
                    <p>
                      Automatic repeats are blocked. Inspect{" "}
                      <a href="/tasks">recent tasks</a> and the dispatcher logs
                      before resolving this run.
                    </p>
                    <ResolveRun
                      busy={busy}
                      onResolve={(note) =>
                        action(async () => {
                          const body = await request(
                            `/api/routines/${selected.id}/resolve`,
                            write("POST", {
                              runId: run.id,
                              note,
                              confirmation: "I checked for an active task",
                            }),
                          );
                          fill(body.routine);
                          setRuns(
                            (await request(`/api/routines/${selected.id}`))
                              .runs,
                          );
                          await refresh();
                          setNotice(
                            "Investigation recorded. The routine remains paused. Resolving the record does not stop any task that may already have started.",
                          );
                        })
                      }
                    />
                  </>
                )}
                <details>
                  <summary>Saved request &amp; dispatch ID</summary>
                  <p className="mono">{run.id}</p>
                  <pre className="routine-prompt">{run.snapshot.prompt}</pre>
                </details>
              </article>
            ))
          )}
        </section>
      )}
    </>
  );
}

function ResolveRun({
  busy,
  onResolve,
}: {
  busy: boolean;
  onResolve: (note: string) => Promise<void>;
}) {
  const [note, setNote] = useState("");
  const [checked, setChecked] = useState(false);
  return (
    <details>
      <summary>Resolve after investigation</summary>
      <form
        className="routine-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (checked) void onResolve(note);
        }}
      >
        <label>
          What did you find?
          <textarea
            required
            minLength={10}
            maxLength={2000}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </label>
        <label className="routine-check">
          <input
            type="checkbox"
            required
            checked={checked}
            onChange={(event) => setChecked(event.target.checked)}
          />
          I checked for an active task. I understand that resolving this record
          does not cancel any task.
        </label>
        <button
          type="submit"
          disabled={busy || !checked || note.trim().length < 10}
        >
          Record investigation and keep paused
        </button>
      </form>
    </details>
  );
}
