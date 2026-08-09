/**
 * Trace ingest, exporter to table, over HTTP.
 *
 * This is the tier that has already been wrong once in the worst possible way:
 * the trace page read an attribute eve never exports, so it had never worked at
 * all, and nothing said so. The failure shape is specific and it is why this
 * probe exists — INGEST FAILS SILENTLY BY DESIGN. A bad token answers 401 to the
 * agent's OTLP exporter, which logs it to its own stderr and drops the batch.
 * Nobody's screen changes. The only symptom is a trace tier that stays empty
 * while work happens, which is indistinguishable from an agent nobody has used.
 *
 * Every check below is over real HTTP against a running dashboard, against a
 * real Postgres, because the interesting failures are all in the seam:
 * authentication, the OTLP response body, and whether the rows actually landed.
 * lib/traces.ts's parser is unit-tested; that a POST of an exporter's bytes ends
 * as a queryable row is not.
 *
 * No agent is needed here — an OTLP exporter is just an HTTP client, and this
 * probe is a faithful one.
 */

const DASHBOARD = process.env.EVESTACK_PROBE_DASHBOARD_URL?.replace(/\/$/, "") ?? null;
const TOKEN = process.env.EVESTACK_PROBE_INGEST_TOKEN ?? null;
const USER = process.env.EVESTACK_PROBE_DASHBOARD_USER ?? null;
const PASSWORD = process.env.EVESTACK_PROBE_DASHBOARD_PASSWORD ?? null;

/** Kept in step with INGEST_TOKEN_HEADER in packages/dashboard/lib/auth.ts:43. */
const TOKEN_HEADER = "x-evestack-ingest-token";
/** google.rpc.Code 16. The route answers in OTLP's vocabulary, not the dashboard's. */
const UNAUTHENTICATED = 16;

const hex = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");

async function connect() {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: process.env.WORKFLOW_POSTGRES_URL });
  await client.connect();
  return client;
}

/**
 * One OTLP/JSON ExportTraceServiceRequest, in the shape a real exporter sends:
 * nanosecond strings, hex ids, resource and scope both present.
 */
function batch(traceId, spans) {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [{ key: "service.name", value: { stringValue: "evestack-probe" } }],
        },
        scopeSpans: [
          {
            scope: { name: "probe", version: "1" },
            spans: spans.map((span) => ({
              traceId,
              spanId: span.spanId,
              name: span.name,
              kind: 1,
              startTimeUnixNano: span.start,
              endTimeUnixNano: span.end,
              status: { code: 1 },
              attributes: [{ key: "probe.marker", value: { stringValue: traceId } }],
            })),
          },
        ],
      },
    ],
  };
}

async function post(body, { token = TOKEN, contentType = "application/json" } = {}) {
  const headers = { "content-type": contentType };
  if (token !== null) headers[TOKEN_HEADER] = token;
  const response = await fetch(`${DASHBOARD}/api/ingest/v1/traces`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const parsed = await response.json().catch(() => null);
  return { status: response.status, body: parsed };
}

export default {
  id: "seam/trace-ingest-lands-in-postgres",
  title: "an OTLP exporter's POST is authenticated, accepted and queryable afterwards",
  needs: ["dashboard", "postgres"],
  why:
    "Ingest is the one path in evestack that fails silently by design: a wrong token answers 401 " +
    "to a machine, the exporter logs it to its own stderr, and the only visible symptom is a " +
    "trace tier that stays empty — which looks exactly like an agent nobody has used. This tier " +
    "has already shipped completely broken once, reading an attribute eve never exports. The " +
    "parser has unit tests; that a POST of exporter bytes becomes a row anyone can query has " +
    "never been checked at all.",

  async available() {
    const missing = [];
    if (!DASHBOARD) missing.push("EVESTACK_PROBE_DASHBOARD_URL is not set");
    if (!TOKEN) missing.push("EVESTACK_PROBE_INGEST_TOKEN is not set");
    if (!process.env.WORKFLOW_POSTGRES_URL) missing.push("WORKFLOW_POSTGRES_URL is not set");
    if (missing.length > 0) return missing;
    try {
      const response = await fetch(`${DASHBOARD}/api/health`, { signal: AbortSignal.timeout(5_000) });
      if (!response.ok) return [`dashboard health answered ${response.status}`];
      const client = await connect();
      await client.end();
      return [];
    } catch (error) {
      return [`cannot reach the stack: ${error.message}`];
    }
  },

  async run(t) {
    const now = BigInt(Date.now()) * 1_000_000n;
    const traceId = hex(32);

    /* ── the credential, in OTLP's own vocabulary ──────────────────────────── */

    const anonymous = await post(batch(hex(32), [{ spanId: hex(16), name: "nope", start: String(now), end: String(now + 1_000_000n) }]), { token: null });
    t.ok(
      anonymous.status === 401,
      "an exporter with no token is refused",
      anonymous.status === 401 ? {} : { expected: 401, actual: anonymous.status },
    );
    t.ok(
      anonymous.body?.code === UNAUTHENTICATED,
      "and told so in OTLP's error vocabulary, because its caller is an exporter and not a browser",
      anonymous.body?.code === UNAUTHENTICATED
        ? {}
        : { expected: `code ${UNAUTHENTICATED}`, actual: JSON.stringify(anonymous.body).slice(0, 160) },
    );

    const wrong = await post(batch(hex(32), [{ spanId: hex(16), name: "nope", start: String(now), end: String(now + 1_000_000n) }]), { token: `${TOKEN}-wrong` });
    t.ok(
      wrong.status === 401,
      "a wrong token is refused rather than partially trusted",
      wrong.status === 401 ? {} : { expected: 401, actual: wrong.status },
    );

    /* ── protobuf is refused by content type, not half-parsed ──────────────── */

    const protobuf = await post("\x0a\x00", { contentType: "application/x-protobuf" });
    t.ok(
      protobuf.status === 415,
      "a protobuf exporter is turned away by content-type instead of having its bytes guessed at",
      protobuf.status === 415
        ? {}
        : {
            expected: 415,
            actual: `${protobuf.status} — a hand-rolled read of a protobuf prefix writes half a span and calls it success`,
          },
    );

    /* ── the real thing ────────────────────────────────────────────────────── */

    const spans = [
      { spanId: hex(16), name: "probe.parent", start: String(now), end: String(now + 5_000_000n) },
      { spanId: hex(16), name: "probe.child", start: String(now + 1_000_000n), end: String(now + 2_000_000n) },
    ];
    const accepted = await post(batch(traceId, spans));

    t.ok(
      accepted.status === 200,
      "a well-formed OTLP/JSON batch is accepted",
      accepted.status === 200
        ? {}
        : { expected: 200, actual: `${accepted.status} ${JSON.stringify(accepted.body).slice(0, 200)}` },
    );
    t.ok(
      accepted.body !== null && accepted.body.partialSuccess === undefined,
      "with a full body and no partialSuccess, which is what tells the exporter to let the batch go",
      accepted.body !== null && accepted.body.partialSuccess === undefined
        ? {}
        : {
            expected: "{}",
            actual: JSON.stringify(accepted.body),
          },
    );

    /* ── and it is actually in the table ───────────────────────────────────── */

    const client = await connect();
    try {
      const { rows } = await client.query(
        `SELECT span_id, name, start_unix_nano, end_unix_nano
           FROM evestack.spans WHERE trace_id = $1 ORDER BY start_unix_nano`,
        [traceId],
      );

      // ANTI-VACUITY, and the whole point of the probe. A 200 from the route
      // means "I accepted this", not "I stored it": the 503 path exists exactly
      // because storage can fail after acceptance. Everything below compares
      // stored values, so with zero rows they would all pass.
      t.ok(
        rows.length === spans.length,
        "both spans are queryable in evestack.spans afterwards — a 200 is a promise this checks rather than trusts",
        rows.length === spans.length
          ? {}
          : {
              expected: `${spans.length} rows for trace ${traceId}`,
              actual: `${rows.length} — the route answered 200 and the rows are not there, which is the silent-ingest failure this whole tier exists to catch`,
            },
      );

      if (rows.length === spans.length) {
        const names = rows.map((r) => r.name).sort();
        t.ok(
          names.join(",") === ["probe.child", "probe.parent"].join(","),
          "under the names the exporter sent",
          names.join(",") === ["probe.child", "probe.parent"].join(",")
            ? {}
            : { expected: "probe.child,probe.parent", actual: names.join(",") },
        );

        // Nanoseconds survive as nanoseconds. sql/traces.sql keeps the raw
        // bigints precisely because timestamptz resolves only to microseconds,
        // and sibling spans that start in the same microsecond must still order.
        const exact = String(rows[0].start_unix_nano) === String(now);
        t.ok(
          exact,
          "and with their nanosecond timestamps intact, not rounded through a microsecond column",
          exact
            ? {}
            : {
                expected: String(now),
                actual: String(rows[0].start_unix_nano),
              },
        );
      }

      /* ── at-least-once delivery must not duplicate ──────────────────────── */

      // OTLP delivery is at-least-once: an exporter that times out after we
      // commit sends the identical batch again. insertSpans upserts for that
      // reason, and this is what holds it there.
      const again = await post(batch(traceId, spans));
      t.ok(
        again.status === 200,
        "re-posting an identical batch is accepted, as an at-least-once exporter requires",
        again.status === 200 ? {} : { expected: 200, actual: again.status },
      );

      const { rows: after } = await client.query(
        `SELECT count(*)::int AS n FROM evestack.spans WHERE trace_id = $1`,
        [traceId],
      );
      t.ok(
        after[0].n === spans.length,
        "and stores no duplicates — the same span id twice is one row",
        after[0].n === spans.length
          ? {}
          : {
              expected: spans.length,
              actual: `${after[0].n} — an exporter retry would inflate every count on the traces page`,
            },
      );

      /* ── an unstorable timestamp is a partial success, never a 503 ──────── */

      // A span from a double-scaled clock (Date.now() * 1e12, 22 digits) is out
      // of range for the bigint column. It used to throw from inside
      // insertSpans, which from the route looks exactly like a dead database —
      // so it answered 503 + Retry-After and the exporter resent that batch
      // forever. It has to be reported as rejected instead, which is the one
      // answer that makes the exporter stop.
      const poisonTrace = hex(32);
      const poisoned = await post(
        batch(poisonTrace, [
          { spanId: hex(16), name: "probe.ok", start: String(now), end: String(now + 1_000_000n) },
          { spanId: hex(16), name: "probe.overflow", start: "9".repeat(22), end: "9".repeat(22) },
        ]),
      );

      t.ok(
        poisoned.status === 200,
        "a batch carrying an out-of-range timestamp is answered 200, not 503",
        poisoned.status === 200
          ? {}
          : {
              expected: 200,
              actual: `${poisoned.status} — Retry-After on a batch that can never be accepted is an exporter resending it forever`,
            },
      );
      t.ok(
        poisoned.body?.partialSuccess?.rejectedSpans === "1",
        "and reports exactly the one span it could not store, so the exporter drops that batch",
        poisoned.body?.partialSuccess?.rejectedSpans === "1"
          ? {}
          : { expected: 'rejectedSpans "1"', actual: JSON.stringify(poisoned.body).slice(0, 200) },
      );

      const { rows: survivors } = await client.query(
        `SELECT count(*)::int AS n FROM evestack.spans WHERE trace_id = $1`,
        [poisonTrace],
      );
      t.ok(
        survivors[0].n === 1,
        "while the storable span in the same batch is kept — one bad clock does not cost the batch",
        survivors[0].n === 1
          ? {}
          : { expected: 1, actual: `${survivors[0].n} spans stored from the poisoned batch` },
      );

      /* ── and an operator can see that anything arrived at all ───────────── */

      if (USER && PASSWORD) {
        const summary = await fetch(`${DASHBOARD}/api/ingest/v1/traces`, {
          headers: {
            authorization: `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString("base64")}`,
          },
        });
        const body = await summary.json().catch(() => ({}));
        t.ok(
          summary.ok,
          "GET on the same route answers a signed-in human, which is the quickest way to tell a wired-up exporter from a silent one",
          summary.ok ? {} : { expected: 200, actual: summary.status },
        );
        t.note(`ingest summary: ${JSON.stringify(body).slice(0, 200)}`);
      }
    } finally {
      // Leave the table as it was found. This runs against the agent's live
      // database, and a probe that accumulates rows changes what the next one
      // measures.
      await client
        .query(`DELETE FROM evestack.spans WHERE (attributes->>'probe.marker') IS NOT NULL`)
        .catch(() => {});
      await client.end();
    }
  },
};
