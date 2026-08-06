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

const DEFAULT_AGENT_URL = "http://127.0.0.1:2000";
/** eve's stream is newline-delimited JSON. It is NOT text/event-stream. */
const EVE_STREAM_CONTENT_TYPE = "application/x-ndjson; charset=utf-8";
const EVE_STREAM_TAIL_INDEX_HEADER = "x-eve-stream-tail-index";

export function agentBaseUrl(override) {
  const raw = (override ?? process.env.EVESTACK_AGENT_URL ?? "").trim();
  return (raw.length > 0 ? raw : DEFAULT_AGENT_URL).replace(/\/+$/, "");
}

/**
 * `localDev()` in the agent's channel config waves through loopback with no
 * credentials, so Basic auth is only attached when both vars are set — sending
 * an empty Basic header would be worse than sending none.
 */
function authHeader() {
  const user = process.env.EVESTACK_AUTH_USER;
  const password = process.env.EVESTACK_AUTH_PASSWORD;
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
export async function quietSessions(client, { workflowSchema, idleMs, limit }) {
  const { rows } = await client.query(
    `
    select s.id                            as session_id,
           s.attributes->>'$eve.title'     as title,
           s.attributes->>'$eve.trigger'   as trigger,
           s.created_at,
           greatest(s.updated_at, coalesce(max(t.updated_at), s.updated_at)) as last_activity
      from ${workflowSchema}.workflow_runs s
      left join ${workflowSchema}.workflow_runs t
        on t.attributes->>'$eve.root' = s.id
     where s.attributes->>'$eve.type' = 'session'
       and s.status = 'running'
     group by s.id, s.attributes, s.created_at, s.updated_at
    having greatest(s.updated_at, coalesce(max(t.updated_at), s.updated_at))
           < (now() at time zone 'utc') - ($1 || ' milliseconds')::interval
     order by last_activity asc
     limit $2`,
    [String(idleMs), limit + 1],
  );

  return {
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
    unchecked: Math.max(0, rows.length - limit),
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
async function readRecentEvents(baseUrl, sessionId, { lookback = 512, timeoutMs = 10_000 } = {}) {
  const params = new URLSearchParams({ startIndex: String(-lookback), includeTailIndex: "1" });
  const url = `${baseUrl}/eve/v1/session/${encodeURIComponent(sessionId)}/stream?${params}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const headers = { accept: EVE_STREAM_CONTENT_TYPE };
  const auth = authHeader();
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
export async function inspectSessions(candidates, { baseUrl, timeoutMs = 10_000 } = {}) {
  const entries = [];
  let agentReachable = true;
  let agentError = null;

  for (const candidate of candidates) {
    if (!agentReachable) break;
    try {
      const events = await readRecentEvents(baseUrl, candidate.sessionId, { timeoutMs });
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
