/**
 * The chat stream, driven end to end for the first time.
 *
 * `/api/control/sessions/[id]/stream` transcodes eve's NDJSON into SSE and
 * promises something specific about it: every frame carries its ABSOLUTE index
 * as `id:`, so a reconnecting `EventSource` sends the last one back as
 * `Last-Event-ID` and resumes with "no replayed events, no dropped ones". That
 * sentence is in the route's own header and nothing has ever checked it.
 *
 * It cannot be checked from either end alone. The agent serves NDJSON with no
 * ids at all — the indices are minted by the route as it transcodes — so a unit
 * test would be asserting against the same code that produces the answer, and a
 * probe against the agent never sees the SSE layer that the browser consumes.
 * The seam is the only place the property exists.
 *
 * ── No model key, and that is fine here ──────────────────────────────────────
 *
 * CI boots the agent without a provider key, so the turn this probe starts
 * fails at the model call. Every assertion below is about the transport: a
 * failing turn still opens a durable stream, still emits terminal events, and
 * still indexes them. If anything, it is the better fixture — the events arrive
 * in under a second and the sequence is short enough to compare exactly.
 *
 * What that DOES cost is stated rather than hidden: this probe does not observe
 * a model token arriving, so it cannot catch a transcoder that mangles a
 * `message.delta`. It catches framing, indexing, resumption, refusal and the
 * content types. Token-level behaviour needs a key and belongs to `eve eval`.
 */

const DASHBOARD = process.env.EVESTACK_PROBE_DASHBOARD_URL?.replace(/\/$/, "") ?? null;
const USER = process.env.EVESTACK_PROBE_DASHBOARD_USER ?? null;
const PASSWORD = process.env.EVESTACK_PROBE_DASHBOARD_PASSWORD ?? null;

function auth() {
  return `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString("base64")}`;
}

async function call(path, init = {}) {
  return fetch(`${DASHBOARD}${path}`, {
    ...init,
    headers: { authorization: auth(), "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

/**
 * Read an SSE (or NDJSON) body until it goes quiet or the budget runs out.
 *
 * Deliberately not "until a terminal event": the point is to observe what the
 * route actually emits, and stopping at a name this probe chose would hide the
 * case where nothing after it ever arrives. `quietMs` is what ends it, so a
 * stream that stalls mid-turn is reported as the frames it managed rather than
 * hanging the job to its timeout.
 */
async function drain(response, { budgetMs = 20_000, quietMs = 2_500 } = {}) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + budgetMs;
  let buffer = "";
  let lastChunk = Date.now();

  const timer = setTimeout(() => reader.cancel().catch(() => {}), budgetMs);
  try {
    for (;;) {
      if (Date.now() > deadline) break;
      const read = await Promise.race([
        reader.read(),
        new Promise((resolve) => setTimeout(() => resolve({ quiet: true }), quietMs)),
      ]);
      if (read.quiet) {
        if (Date.now() - lastChunk >= quietMs) break;
        continue;
      }
      if (read.done) break;
      buffer += decoder.decode(read.value, { stream: true });
      lastChunk = Date.now();
    }
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => {});
  }
  return buffer;
}

/** SSE frames, as {id, event, data} — id kept as the raw string it arrived as. */
function parseSse(text) {
  const frames = [];
  for (const block of text.split(/\n\n+/)) {
    if (!block.trim()) continue;
    const frame = { id: null, event: null, data: "" };
    for (const line of block.split("\n")) {
      if (line.startsWith("id:")) frame.id = line.slice(3).trim();
      else if (line.startsWith("event:")) frame.event = line.slice(6).trim();
      else if (line.startsWith("data:")) frame.data += line.slice(5).trim();
      // A `:` comment is the keep-alive. Not a frame; deliberately ignored.
    }
    if (frame.id !== null || frame.data !== "") frames.push(frame);
  }
  return frames;
}

export default {
  id: "seam/chat-stream-indexes-and-resumes",
  title: "the chat stream frames, indexes and resumes exactly, against a live agent",
  needs: ["dashboard", "agent"],
  why:
    "The route promises exact resumption — 'no replayed events, no dropped ones' — and that " +
    "property lives entirely in the seam between the dashboard and the agent. eve serves NDJSON " +
    "with no indices; the route mints them while transcoding. A unit test would check the " +
    "transcoder against itself, and an agent probe never sees SSE at all. Getting it wrong is " +
    "silent: a browser that reconnects would replay events the user already read, or skip the " +
    "one that said the turn failed, and both look like a working chat.",

  async available() {
    const missing = [];
    if (!DASHBOARD) missing.push("EVESTACK_PROBE_DASHBOARD_URL is not set");
    if (!USER || !PASSWORD) missing.push("EVESTACK_PROBE_DASHBOARD_{USER,PASSWORD} are not set");
    if (missing.length > 0) return missing;
    try {
      const response = await fetch(`${DASHBOARD}/api/health`, { signal: AbortSignal.timeout(5_000) });
      if (!response.ok) return [`dashboard health answered ${response.status}`];
      return [];
    } catch (error) {
      return [`cannot reach the dashboard: ${error.message}`];
    }
  },

  async run(t) {
    /* ── an unknown session is refused, not absorbed ───────────────────────── */

    // eve answers 200 with a tail index of -1 for an id it has never seen, and
    // that empty fold is indistinguishable from a turn in flight. A route that
    // passed it through would hand a browser an SSE stream that simply never
    // says anything, forever.
    const unknown = await call("/api/control/sessions/wrun_probe_does_not_exist/stream");
    t.ok(
      unknown.status === 404,
      "a session id the agent has never heard of is refused with 404, not opened as a silent stream",
      unknown.status === 404
        ? {}
        : {
            expected: 404,
            actual: `${unknown.status} — eve's tail index of -1 is being read as an open stream, which a browser cannot tell from a turn that is thinking`,
          },
    );

    /* ── start a real session ──────────────────────────────────────────────── */

    const created = await call("/api/control/sessions", {
      method: "POST",
      body: JSON.stringify({ message: "probe: this turn is expected to fail at the model call" }),
    });
    const body = await created.json().catch(() => ({}));

    t.ok(
      created.status === 202 && typeof body.sessionId === "string",
      "the dashboard starts a real durable session on the live agent",
      created.status === 202 && typeof body.sessionId === "string"
        ? {}
        : { expected: "202 carrying a sessionId", actual: `${created.status} ${JSON.stringify(body).slice(0, 200)}` },
    );

    if (typeof body.sessionId !== "string") {
      // Everything below is about that session. Continuing would emit a run of
      // assertions that pass by having nothing to look at.
      t.ok(false, "no session was created, so nothing below could be checked", {
        expected: "a sessionId to stream",
        actual: "none — the remaining assertions in this probe did not run",
      });
      return;
    }

    const id = body.sessionId;
    t.note(`session ${id}`);

    /* ── the stream itself ─────────────────────────────────────────────────── */

    const stream = await call(`/api/control/sessions/${encodeURIComponent(id)}/stream`, {
      headers: { accept: "text/event-stream" },
    });

    const contentType = stream.headers.get("content-type") ?? "";
    t.ok(
      stream.ok && contentType.includes("text/event-stream"),
      "the stream is served as SSE, which is the only thing EventSource can read",
      stream.ok && contentType.includes("text/event-stream")
        ? {}
        : { expected: "200 text/event-stream", actual: `${stream.status} ${contentType}` },
    );

    const frames = parseSse(await drain(stream));
    t.note(`${frames.length} frames: ${frames.map((f) => f.event ?? "?").join(", ") || "(none)"}`);

    // ANTI-VACUITY. Every assertion below compares frames to each other, so with
    // fewer than two of them they all pass without testing anything. A turn that
    // fails at the provider still emits several, so this failing means the seam
    // is broken rather than the fixture being thin.
    t.ok(
      frames.length >= 2,
      "the live agent produced at least two indexed frames, so the ordering and resumption checks below have something to compare",
      frames.length >= 2
        ? {}
        : {
            expected: ">= 2 SSE frames from a real turn",
            actual: `${frames.length} — with fewer than two, every assertion after this one passes vacuously`,
          },
    );

    const ids = frames.map((f) => Number(f.id));
    const allIntegers = ids.every((n) => Number.isSafeInteger(n) && n >= 0);
    t.ok(
      allIntegers,
      "every frame carries a non-negative integer id, which is what Last-Event-ID sends back",
      allIntegers ? {} : { expected: "integer ids", actual: frames.map((f) => f.id).join(", ") },
    );

    const strictlyIncreasing = ids.every((n, i) => i === 0 || n > ids[i - 1]);
    t.ok(
      strictlyIncreasing,
      "ids strictly increase, so no two frames can resume to the same position",
      strictlyIncreasing
        ? {}
        : {
            expected: "a strictly increasing sequence",
            actual: `${ids.join(", ")} — a repeated id makes a reconnect resume from a position that never advanced`,
          },
    );

    const everyFrameParses = frames.every((f) => {
      try {
        JSON.parse(f.data);
        return true;
      } catch {
        return false;
      }
    });
    t.ok(
      everyFrameParses,
      "every frame's data is one complete JSON object — the transcoder never splits an event across frames",
      everyFrameParses
        ? {}
        : { expected: "parseable JSON in every data field", actual: "at least one frame did not parse" },
    );

    /* ── resumption: the property the header promises ──────────────────────── */

    if (frames.length >= 2) {
      const resumeFrom = ids[0];
      const resumed = await call(
        `/api/control/sessions/${encodeURIComponent(id)}/stream?startIndex=${resumeFrom}`,
        { headers: { accept: "text/event-stream" } },
      );
      const resumedIds = parseSse(await drain(resumed, { budgetMs: 10_000 })).map((f) => Number(f.id));

      const noReplay = resumedIds.every((n) => n > resumeFrom);
      t.ok(
        noReplay,
        "resuming past an index replays nothing at or before it",
        noReplay
          ? {}
          : {
              expected: `every id > ${resumeFrom}`,
              actual: `${resumedIds.join(", ")} — a reconnecting browser would re-render events the reader already saw`,
            },
      );

      // The other half, and the one that actually loses information: the frames
      // that came after the resume point must all still be there.
      const expectedAfter = ids.filter((n) => n > resumeFrom);
      const nothingDropped = expectedAfter.every((n) => resumedIds.includes(n));
      t.ok(
        nothingDropped,
        "and drops nothing that came after it",
        nothingDropped
          ? {}
          : {
              expected: `${expectedAfter.join(", ")}`,
              actual: `${resumedIds.join(", ")} — a reconnect would silently lose the event that said how the turn ended`,
            },
      );
    }

    /* ── the passthrough format ────────────────────────────────────────────── */

    const ndjson = await call(`/api/control/sessions/${encodeURIComponent(id)}/stream?format=ndjson`);
    const ndjsonType = ndjson.headers.get("content-type") ?? "";
    t.ok(
      ndjson.ok && ndjsonType.includes("ndjson"),
      "?format=ndjson passes the agent's own content type through for non-browser readers",
      ndjson.ok && ndjsonType.includes("ndjson")
        ? {}
        : { expected: "application/x-ndjson", actual: `${ndjson.status} ${ndjsonType}` },
    );

    const lines = (await drain(ndjson, { budgetMs: 10_000 }))
      .split("\n")
      .filter((l) => l.trim().length > 0);
    const everyLineIsJson = lines.length > 0 && lines.every((l) => {
      try {
        JSON.parse(l);
        return true;
      } catch {
        return false;
      }
    });
    t.ok(
      everyLineIsJson,
      "and every line of it is one JSON object, with no SSE framing leaking in",
      everyLineIsJson
        ? {}
        : {
            expected: "one JSON object per line",
            actual: `${lines.length} line(s); first: ${JSON.stringify(lines[0] ?? "").slice(0, 120)}`,
          },
    );

    /* ── a bad resume position is refused ──────────────────────────────────── */

    // MAX_START_INDEX exists because past 2^53 `index += 1` stops incrementing,
    // so every frame would carry the same id and resumption would silently stop
    // working. The route's header explains it; this is what holds it there.
    const huge = await call(
      `/api/control/sessions/${encodeURIComponent(id)}/stream?startIndex=100000000000000000000`,
    );
    t.ok(
      huge.status === 400,
      "a startIndex past the safe-integer range is refused rather than producing a stream whose ids never advance",
      huge.status === 400
        ? {}
        : {
            expected: 400,
            actual: `${huge.status} — 21 digits passes the integer regex, and every id derived from it afterwards is the same number`,
          },
    );
  },
};
