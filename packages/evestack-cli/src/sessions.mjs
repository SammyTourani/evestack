/**
 * Which sessions are stuck, and which are merely waiting for a person.
 *
 * This is a port of packages/dashboard/lib/fleet.ts — same candidate query,
 * same thresholds, same decision order — because that file already paid for the
 * lesson this one must not relearn. Its comments record that its first version
 * classified from SQL alone and called 22 healthy sessions wedged the first time
 * it ran. Three states are indistinguishable in the workflow tables:
 *
 *   idle            its last turn finished; it waits for the next message
 *   awaiting-human  parked on an approval nobody has answered
 *   wedged          a turn started and never reached a terminal state
 *
 * Only the third is a fault, and eve leaves a session's run row `running` and
 * its stream `waiting` for the life of the session — so "idle for a day"
 * describes a healthy conversation far more often than a broken one.
 *
 * The consequence for a CLI is the part that differs from the dashboard, and it
 * is deliberate: telling them apart is only possible from the agent's event
 * stream, so when the agent is not reachable this module returns candidates and
 * REFUSES to classify them. A doctor command that guesses here would be wrong in
 * exactly the direction that trains its reader to ignore it.
 *
 * Duplicated rather than imported: the dashboard is containerised from an
 * isolated build context where a `workspace:*` dependency fails the image build,
 * and this package publishes standalone. Same forced duplication, and same risk,
 * as the pricing table described in packages/evestack-budget/README.md — if the
 * classification changes in one place it must change in both.
 *
 * THAT LAST SENTENCE WAS A HOPE, AND IT WAS ALREADY BROKEN WHEN IT WAS WRITTEN.
 * The candidate query below shipped without fleet.ts's unfinished-turn filter —
 * the one line its comment credits with removing 166 of 174 false positives —
 * so `evestack doctor` reported finished conversations as `wedged`. The unit
 * tests could not see it: they cover classifySession, which was never wrong,
 * while the query that decides who reaches it needs a database and had none.
 * contract/contracts/20-fleet-port.contract.mjs now reads both files and fails
 * when they disagree, which is the only thing that can hold two copies of one
 * query together.
 */

/**
 * How long a session may sit still before it is worth probing. Deliberately
 * generous: eve keeps a session's run open until it times out, so an idle
 * conversation is the normal steady state, not a fault.
 */
export const IDLE_BEFORE_SUSPECT_MS = 30 * 60 * 1000;

/**
 * How long a turn may be in flight before it is presumed dead. Generous on
 * purpose: a turn doing real work through a sandbox can legitimately run for
 * many minutes, and eve's cancellation is cooperative — a cancelled turn's model
 * call keeps streaming for up to ~90s. An hour is far past anything legitimate
 * and far short of a working day.
 */
export const STUCK_TURN_MS = 60 * 60 * 1000;

/** Probing costs a round trip each, so the sweep is bounded rather than complete. */
export const MAX_PROBES = 25;

/** What `eve dev` binds when nothing says otherwise, and what it auto-increments from. */
const DEFAULT_AGENT_PORT = "2000";
/** eve's stream is newline-delimited JSON. It is NOT text/event-stream. */
const EVE_STREAM_CONTENT_TYPE = "application/x-ndjson; charset=utf-8";
const EVE_STREAM_TAIL_INDEX_HEADER = "x-eve-stream-tail-index";

/**
 * Where to look for the agent, in the order every other command looks.
 *
 * `env` is an accessor — `projectEnv(found)` from project.mjs, which merges the
 * project's `.env` and `.env.local` in eve's own load order with the real
 * environment winning — and it defaults to the process environment alone so a
 * caller that has no project still works.
 *
 * TWO THINGS WERE MISSING, and they had the same cause: this read
 * `process.env.EVESTACK_AGENT_URL` and nothing else.
 *
 *   EVESTACK_AGENT_PORT was never consulted. It is the variable the scaffolder
 *   WRITES — EVESTACK_AGENT_URL is not written to a scaffolded .env.local at
 *   all — and `status`, `tour` and the template's own `verify` all read it,
 *   because `eve dev` takes 2000 and silently auto-increments when 2000 is
 *   busy. So on a machine with two projects, doctor probed 127.0.0.1:2000,
 *   which is the FIRST project's agent, and reported this project's sessions
 *   against it: at best "the agent does not know this session id" for every
 *   candidate, at worst a confident classification read off a different
 *   conversation.
 *
 *   And the project's env files were never read, so even an operator who did
 *   set EVESTACK_AGENT_URL in .env.local got the default unless they had also
 *   exported it into the shell they typed `evestack doctor` in.
 *
 * `--agent-url` still wins over both, which is what an operator pointing this
 * at a remote agent expects.
 *
 * Trailing slashes are trimmed and nothing else is: a base URL carrying a path
 * prefix (`http://host/agents/a`) is preserved, because the callers below build
 * on it with string concatenation and `new URL(...).origin` would silently drop
 * the prefix from a configuration that works today.
 */
export function agentBaseUrl(override, env = (key) => process.env[key]) {
  const explicit = (override ?? env("EVESTACK_AGENT_URL") ?? "").trim();
  const port = (env("EVESTACK_AGENT_PORT") ?? "").trim() || DEFAULT_AGENT_PORT;
  const raw = explicit.length > 0 ? explicit : `http://127.0.0.1:${port}`;
  return raw.replace(/\/+$/, "");
}

/**
 * `localDev()` in the agent's channel config waves through loopback with no
 * credentials, so Basic auth is only attached when both vars are set — sending
 * an empty Basic header would be worse than sending none.
 *
 * Read through the same accessor as the URL, for the reason `tour` records
 * beside its own copy of this: from eve 0.30 `localDev()` grants only inside
 * `eve dev`, so a BUILT server refuses loopback too. Reading `process.env`
 * alone meant doctor sent no credentials at all to a project whose password
 * lives — as the scaffolder writes it — in .env.local and nowhere else. Every
 * probe came back 401, `inspectSessions` stops the sweep on the first
 * unreachable probe, and the report said the agent was unreachable about an
 * agent that was answering perfectly well and had just declined to talk to
 * someone with no password.
 */
function authHeader(env) {
  const user = env("EVESTACK_AUTH_USER");
  const password = env("EVESTACK_AUTH_PASSWORD");
  if (!user || !password) return undefined;
  return `Basic ${Buffer.from(`${user}:${password}`, "utf8").toString("base64")}`;
}

/* -------------------------------------------------------------------------- */
/* candidates                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Open sessions whose most recent child turn finished a while ago. The join is
 * to turns rather than to the session row because the session row's own
 * timestamps do not move as turns run — without it, "quiet for an hour" and
 * "created an hour ago and busy ever since" are the same query.
 *
 * The idle window is cut against `now() at time zone 'utc'`, not `now()`. eve's
 * workflow tables hold UTC in `timestamp without time zone` columns, so
 * comparing one to a timestamptz makes Postgres cast it using the SERVER's
 * TimeZone — which reads a stored UTC value as local wall clock and moves the
 * whole window by that offset. Measured: on a server at Etc/GMT+8 (this is the
 * pglite default and it is what a laptop Postgres does), the plain `now()` form
 * of this query returned zero candidates for a session that had genuinely been
 * quiet for three hours, because its last activity looked five hours in the
 * future. Both sides naive removes the server's zone from the answer entirely.
 */
/**
 * A whole number of milliseconds Postgres will accept in an interval cast.
 *
 * `String(idleMs)` went straight into `($1 || ' milliseconds')::interval`, and
 * JS renders small or very large numbers in exponent form: `String(6e-7)` is
 * `"6e-7"`, which Postgres rejects with `invalid input syntax for type
 * interval`. That surfaced as a crash with raw SQL in the message where the
 * honest answer is "an interval of about zero". Rounded and clamped instead, so
 * the cast can never be handed something it cannot parse. The dashboard's
 * lib/fleet.ts carries the same guard for the same query.
 */
const MAX_IDLE_MS = 30 * 24 * 60 * 60 * 1000;

function intervalMilliseconds(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value)) return String(MAX_IDLE_MS);
  return String(Math.min(MAX_IDLE_MS, Math.max(0, Math.round(value))));
}

export async function quietSessions(client, { workflowSchema, idleMs, limit }) {
  const { rows } = await client.query(
    `
    select s.id                            as session_id,
           s.attributes->>'$eve.title'     as title,
           s.attributes->>'$eve.trigger'   as trigger,
           s.created_at,
           greatest(s.updated_at, coalesce(max(t.updated_at), s.updated_at)) as last_activity,
           -- Window functions run after GROUP BY/HAVING and before LIMIT, so this
           -- is the true number of stale sessions while the rows stay bounded.
           count(*) over ()                as total_candidates
      from ${workflowSchema}.workflow_runs s
      left join ${workflowSchema}.workflow_runs t
        on t.attributes->>'$eve.root' = s.id
     where s.attributes->>'$eve.type' = 'session'
       and s.status = 'running'
     group by s.id, s.attributes, s.created_at, s.updated_at
    having greatest(s.updated_at, coalesce(max(t.updated_at), s.updated_at))
           < (now() at time zone 'utc') - ($1 || ' milliseconds')::interval

       -- AND at least one turn is genuinely unfinished. THIS LINE WAS MISSING,
       -- and the header above claimed "same candidate query" while it was.
       --
       -- Nothing downstream re-checks the question. A session whose turns have
       -- all closed stays 'running' in the run row, so it was still a candidate;
       -- eve answers a pruned stream with 200 and x-eve-stream-tail-index: -1,
       -- readRecentEvents returns [], foldSnapshot([]) gives
       -- {waiting:false, terminal:false, pendingRequests:[]}, and classifySession
       -- reads "not waiting and not terminal" as a turn in flight. Past
       -- STUCK_TURN_MS that is reported as 'wedged' — "a turn started and never
       -- finished" — about a conversation that finished normally. Measured
       -- directly: foldSnapshot([]) with a 3h idle classifies wedged.
       --
       -- lib/fleet.ts carries this term and its comment names the cost of
       -- dropping it: "That is the 166-of-174 false positive." The dashboard
       -- learned it and the port did not, which is exactly what the header
       -- warned would happen if the classification changed in one place only.
       --
       -- COUNT, not "in_flight_since IS NOT NULL": a run created and never
       -- picked up has completed_at AND started_at null, so MIN() is null on a
       -- turn that is genuinely open.
       --
       -- The type filter is the unit of work. eve writes an untagged companion
       -- run per session that never completes, and one counted here would report
       -- the whole fleet as wedged.
       --
       -- completed_at IS NULL, never status: a cancelled turn, a failed turn and
       -- a turn that never reached the provider have all FINISHED.
       and count(t.id) filter (
             where t.attributes->>'$eve.type' in ('turn', 'subagent')
               and t.completed_at is null
           ) > 0
     order by last_activity asc
     limit $2`,
    [intervalMilliseconds(idleMs), limit],
  );

  return {
    // `unchecked` is the candidates this sweep did NOT probe. It used to be
    // `rows.length - limit` against a `limit + 1` query, so it could only ever
    // be 0 or 1: 100 stale sessions with --limit 25 reported 1 rather than 75.
    // The same defect existed in the dashboard's lib/fleet.ts.
    //
    // Read from the window count rather than by dropping the LIMIT: an unbounded
    // read would trade a wrong number for a query whose cost grows with the
    // table, which is the other bug this sweep has been fixing all over.
    unchecked: Math.max(0, Number(rows[0]?.total_candidates ?? rows.length) - rows.slice(0, limit).length),
    candidates: rows.slice(0, limit).map((raw) => ({
      sessionId: String(raw.session_id),
      title: raw.title ?? null,
      trigger: raw.trigger ?? null,
      // Already a Date: src/db.mjs installs the type parser that reads eve's
      // zone-less `timestamp` columns as the UTC they actually are. Re-parsing
      // from a string here would put every idle time out by the host's offset.
      createdAt: raw.created_at,
      idleMs: Date.now() - raw.last_activity.getTime(),
    })),
  };
}

/* -------------------------------------------------------------------------- */
/* the agent probe                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Read the tail of a session's durable stream and stop, instead of following it
 * live. The stream never ends on its own, so the bound has to come from
 * somewhere: `includeTailIndex=1` returns the index of the last recorded event,
 * which turns "read the recent history" into a read of a known number of lines.
 */
async function readRecentEvents(
  baseUrl,
  sessionId,
  { lookback = 512, timeoutMs = 10_000, env = (key) => process.env[key] } = {},
) {
  const params = new URLSearchParams({ startIndex: String(-lookback), includeTailIndex: "1" });
  const url = `${baseUrl}/eve/v1/session/${encodeURIComponent(sessionId)}/stream?${params}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const headers = { accept: EVE_STREAM_CONTENT_TYPE };
  const auth = authHeader(env);
  if (auth) headers.authorization = auth;

  try {
    const response = await fetch(url, {
      headers,
      signal: controller.signal,
      cache: "no-store",
      redirect: "manual",
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      const error = new Error(`the agent returned ${response.status} for the event stream`);
      error.status = response.status;
      throw error;
    }

    const rawTail = Number(response.headers.get(EVE_STREAM_TAIL_INDEX_HEADER));
    // eve reports -1 for a stream with no events yet.
    const tailIndex = Number.isSafeInteger(rawTail) ? rawTail : -1;
    const count = Math.min(lookback, Math.max(0, tailIndex + 1));
    if (count === 0 || !response.body) {
      await response.body?.cancel().catch(() => {});
      return [];
    }
    return await readNdjson(response.body, count);
  } finally {
    clearTimeout(timer);
    // Always hang up: a successful bounded read still leaves the socket open.
    controller.abort();
  }
}

async function readNdjson(body, limit) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffered = "";
  try {
    while (events.length < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      let newline = buffered.indexOf("\n");
      while (newline !== -1 && events.length < limit) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        // eve primes the stream with a bare newline to flush response headers.
        if (line.length > 0) {
          try {
            const parsed = JSON.parse(line);
            if (parsed && typeof parsed.type === "string") {
              events.push({
                type: parsed.type,
                data: parsed.data && typeof parsed.data === "object" ? parsed.data : {},
              });
            }
          } catch {
            /* a truncated tail line is not worth failing a diagnosis over */
          }
        }
        newline = buffered.indexOf("\n");
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return events;
}

/**
 * Fold the stream tail into the three facts classification needs. Ported from
 * the dashboard's `getSessionSnapshot`, including the ordering subtleties it
 * verified against eve 0.29.5: a HITL pause emits `turn.completed` BEFORE
 * `session.waiting`, so turn completion cannot mean "answered", and answering an
 * `ask_question` emits no `action.result` at all. A new `turn.started` is the
 * one signal that reliably means the parked request moved on.
 */
export function foldSnapshot(events) {
  const snapshot = { waiting: false, terminal: false, pendingRequests: [], lastEventType: undefined };
  const pending = new Map();

  for (const event of events) {
    switch (event.type) {
      case "turn.started":
        snapshot.waiting = false;
        pending.clear();
        break;
      case "input.requested":
        for (const entry of Array.isArray(event.data.requests) ? event.data.requests : []) {
          if (entry && typeof entry.requestId === "string" && typeof entry.kind === "string") {
            pending.set(entry.requestId, entry);
          }
        }
        break;
      case "action.result": {
        const callId =
          event.data.result && typeof event.data.result === "object"
            ? event.data.result.callId
            : undefined;
        if (typeof callId === "string") {
          for (const [requestId, entry] of pending) {
            if (requestId === callId || entry.action?.callId === callId) pending.delete(requestId);
          }
        }
        break;
      }
      case "session.waiting":
        snapshot.waiting = true;
        snapshot.terminal = false;
        break;
      case "session.completed":
      case "session.failed":
        snapshot.waiting = false;
        snapshot.terminal = true;
        pending.clear();
        break;
      default:
        break;
    }
    snapshot.lastEventType = event.type;
  }

  snapshot.pendingRequests = [...pending.values()];
  return snapshot;
}

/**
 * The classification itself, kept pure so the 22-false-positives case is a unit
 * test rather than a thing we hope about. Decision order matters and is the
 * dashboard's: terminal, then parked, then waiting, then in flight.
 */
export function classifySession(snapshot, idleMs) {
  if (snapshot.terminal) {
    // The run row says running, the stream says finished. Not wedged — the row
    // is just stale bookkeeping, which is normal for eve.
    return { health: "active", pendingCount: 0, reason: "already finished" };
  }
  if (snapshot.pendingRequests.length > 0) {
    const n = snapshot.pendingRequests.length;
    return {
      health: "awaiting-human",
      pendingCount: n,
      reason:
        n === 1
          ? "parked on a decision nobody has made"
          : `parked on ${n} decisions nobody has made`,
    };
  }
  if (snapshot.waiting) {
    // Waiting with nothing outstanding is a FINISHED conversation, not a broken
    // one. Calling this wedged is the mistake that produced 22 false positives.
    return {
      health: "idle",
      pendingCount: 0,
      reason: "finished its last turn, waiting for the next message",
    };
  }
  // Not waiting and not terminal means a turn is in flight. Healthy for a few
  // seconds, deeply suspicious after an hour: it is the shape of a turn whose
  // process died mid-flight, which eve does not detect or retry.
  return idleMs > STUCK_TURN_MS
    ? {
        health: "wedged",
        pendingCount: 0,
        reason: "a turn started and never finished — nothing in eve will resume it",
      }
    : { health: "active", pendingCount: 0, reason: "a turn is running" };
}

/**
 * Probe the candidates, or explain why nothing can be said about them.
 *
 * The first unreachable probe stops the sweep. Twenty-five failing round trips
 * would say nothing more than one does, and the whole point of this branch is
 * that the answer is "unknown" — not a slower "unknown".
 */
export async function inspectSessions(
  candidates,
  { baseUrl, timeoutMs = 10_000, env = (key) => process.env[key] } = {},
) {
  const entries = [];
  let agentReachable = true;
  let agentError = null;

  for (const candidate of candidates) {
    if (!agentReachable) break;
    try {
      const events = await readRecentEvents(baseUrl, candidate.sessionId, { timeoutMs, env });
      entries.push({ ...candidate, ...classifySession(foldSnapshot(events), candidate.idleMs) });
    } catch (error) {
      // A 404 is about this session, not about the agent; keep going.
      if (error.status === 404) {
        entries.push({
          ...candidate,
          health: "unknown",
          pendingCount: 0,
          reason: "the agent does not know this session id",
        });
        continue;
      }
      agentReachable = false;
      agentError = error;
    }
  }

  return { entries, agentReachable, agentError, probed: entries.length };
}
