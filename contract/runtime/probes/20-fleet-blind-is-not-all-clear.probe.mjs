/**
 * A health endpoint that could not check must never present as all-clear.
 *
 * A stranger killed an agent mid-turn. `evestack doctor` found the stranded
 * run immediately. `/api/fleet` returned, at that same moment and at every
 * other moment of the session:
 *
 *     {"ok":true,"wedged":0,"idle":0,"awaitingHuman":0,"unknown":0,
 *      "entries":[],"checked":0,"unchecked":0}
 *
 * and the Overview showed `Failure rate 0%` with no banner. Every number in
 * that payload is defensible. `checked` is `entries.length`, and `entries` is
 * only the sessions the SQL could not settle: a session quiet for less than
 * the 30-minute idle gate is never fetched, so it is not "checked" and it is
 * not "unchecked" either. It is simply absent, and the payload has no word for
 * absent.
 *
 * So the sentence a caller reads off this endpoint is the same sentence for
 * two opposite facts: "I examined the fleet and everything is fine" and "I
 * examined nothing". The endpoint already carries an `unknown` field, which is
 * the right idea, and leaves it at zero in both cases.
 *
 * The two assertions below are the smallest honest statement of the rule, and
 * neither of them asks for a particular field name:
 *
 *   1. A sweep that could not have looked at anything must not be
 *      byte-identical to a sweep that looked at everything and found it well.
 *      The probe produces both by moving only `idleMinutes`, so the two calls
 *      differ in exactly one input and describe two different facts.
 *
 *   2. The payload must let a caller size what it did not examine. There are
 *      N sessions in the database; `checked + unchecked` accounts for some of
 *      them; a reader has no way to learn that the other N minus that were
 *      never looked at. /api/health/detail already reports the session total,
 *      so this is a number the product has, not one it would have to invent.
 *
 * EXPECTED TO FAIL against 0.3.1. That is the finding, not a broken probe.
 */
const DASHBOARD = process.env.EVESTACK_PROBE_DASHBOARD_URL?.replace(/\/$/, "") ?? null;
const USER = process.env.EVESTACK_PROBE_DASHBOARD_USER ?? null;
const PASSWORD = process.env.EVESTACK_PROBE_DASHBOARD_PASSWORD ?? null;

/** Well past any plausible retention, so nothing can be idle for this long. */
const UNREACHABLE_IDLE_MINUTES = 43_200;

async function call(path, init = {}) {
  return fetch(`${DASHBOARD}${path}`, {
    ...init,
    headers: {
      authorization: `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString("base64")}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
}

const json = async (response) => {
  try {
    return await response.json();
  } catch {
    return {};
  }
};

async function connect() {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: process.env.WORKFLOW_POSTGRES_URL });
  await client.connect();
  client.on("error", () => {});
  return client;
}

export default {
  id: "seam/fleet-cannot-report-calm-while-blind",
  title: "a sweep that examined nothing does not read as a sweep that found nothing wrong",
  needs: ["dashboard", "postgres"],
  why:
    "This is the endpoint a monitor polls and the source of the Overview banner. Its zeros are " +
    "produced both by a healthy fleet and by a sweep that never looked, and the two are the same " +
    "bytes. A user whose agent has just died sees an unqualified Failure rate 0% and no banner, " +
    "which is worse than no dashboard: it is a dashboard actively reassuring them.",

  async available() {
    const missing = [];
    if (!DASHBOARD) missing.push("EVESTACK_PROBE_DASHBOARD_URL is not set");
    if (!USER || !PASSWORD) missing.push("EVESTACK_PROBE_DASHBOARD_{USER,PASSWORD} are not set");
    if (!process.env.WORKFLOW_POSTGRES_URL) missing.push("WORKFLOW_POSTGRES_URL is not set");
    if (missing.length > 0) return missing;
    try {
      const health = await fetch(`${DASHBOARD}/api/health`, { signal: AbortSignal.timeout(5_000) });
      if (!health.ok) return [`${DASHBOARD}/api/health answered ${health.status}`];
      const client = await connect();
      await client.end();
      return [];
    } catch (error) {
      return [`cannot reach the stack: ${error.message}`];
    }
  },

  async run(t) {
    const client = await connect();
    try {
      // Negative control. If the endpoint answered everybody, the zeros below
      // would be an unauthenticated stranger zeros and would prove nothing
      // about this installation.
      const anonymous = await fetch(`${DASHBOARD}/api/fleet`, {
        signal: AbortSignal.timeout(10_000),
      });
      t.ok(anonymous.status === 401, "the endpoint is behind the credential", {
        expected: "401",
        actual: String(anonymous.status),
      });

      const { rows: population } = await client.query(
        "select count(*)::int as sessions from workflow.workflow_runs" +
          " where attributes->>$1 = 'session'",
        ["$eve.type"],
      );
      const sessions = population[0].sessions;
      t.note(`${sessions} session(s) in the database at the time of the sweep`);

      // Anti-vacuity. On an empty database, a sweep that looked at nothing is
      // simply correct, and everything below would pass for the wrong reason.
      t.ok(sessions > 0, "there are sessions, so a sweep reporting nothing is a claim about them", {
        expected: "at least one session run",
        actual: "none: point this probe at a database with traffic",
      });
      if (sessions === 0) return;

      /* ── the two sweeps ────────────────────────────────────────────────── */

      // One input differs. `idleMinutes=0` makes every unsettled session a
      // candidate; 30 days makes it impossible for any to qualify. Those are
      // two different facts about the fleet.
      const lookedResponse = await call(`/api/fleet?idleMinutes=0&limit=25`);
      const blindResponse = await call(
        `/api/fleet?idleMinutes=${UNREACHABLE_IDLE_MINUTES}&limit=25`,
      );
      t.ok(
        lookedResponse.status === 200 && blindResponse.status === 200,
        "both sweeps answered",
        { expected: "200 and 200", actual: `${lookedResponse.status} and ${blindResponse.status}` },
      );

      const looked = await json(lookedResponse);
      const blind = await json(blindResponse);
      t.note(`idleMinutes=0    ${JSON.stringify(looked).slice(0, 240)}`);
      t.note(`idleMinutes=30d  ${JSON.stringify(blind).slice(0, 240)}`);

      /* ── 1. the two must not be the same sentence ──────────────────────── */

      const summary = (payload) => ({
        wedged: payload.wedged,
        idle: payload.idle,
        awaitingHuman: payload.awaitingHuman,
        unknown: payload.unknown,
        checked: payload.checked,
        unchecked: payload.unchecked,
        entries: Array.isArray(payload.entries) ? payload.entries.length : payload.entries,
      });
      const same = JSON.stringify(summary(looked)) === JSON.stringify(summary(blind));
      t.ok(
        !same,
        "a sweep that could not examine anything reads differently from one that examined everything",
        {
          expected: "two payloads a caller can tell apart",
          actual:
            `identical: ${JSON.stringify(summary(blind))}. ` +
            "Every field is a count of what was found, and none of them is a count of what was " +
            "looked at, so zero findings and zero looking are the same bytes.",
        },
      );

      /* ── 2. the payload must size what it did not examine ──────────────── */

      // Not a demand for a field name. The requirement is that the numbers add
      // up to the population, by whatever route: checked + unchecked + a
      // stated skipped/settled count, or a stated total. Today the payload
      // carries only findings, so `checked + unchecked` is 0 out of N and
      // nothing says N.
      const numbers = Object.entries(blind).filter(([, v]) => typeof v === "number");
      const accounted = numbers.reduce((sum, [, v]) => sum + v, 0);
      t.ok(
        numbers.some(([, v]) => v >= sessions) || accounted >= sessions,
        "the payload accounts for the sessions it did not examine, so 0 findings is readable",
        {
          expected: `some number reaching the ${sessions} session(s) in the database`,
          actual:
            `${JSON.stringify(Object.fromEntries(numbers))} sums to ${accounted}. ` +
            "A reader cannot tell 0-of-0 from 0-of-" +
            `${sessions}. /api/health/detail already reports the session total, so this is a ` +
            "number the product has rather than one it would have to invent.",
        },
      );

      /* ── 3. and the scope it used ──────────────────────────────────────── */

      // The idle gate is 30 minutes and is documented for the CLI flag only.
      // A caller of the HTTP endpoint has no way to learn that a session quiet
      // for 20 minutes was deliberately not looked at.
      // `idle` alone does not count: that is the number of idle sessions found,
      // not the threshold used to decide which sessions were worth looking at.
      // The first version of this line matched it and passed, which is the same
      // mistake the endpoint makes.
      const echoesScope = Object.keys(blind).some((k) =>
        /idleM(inutes|s)|threshold|sweptSince|since|window/i.test(k),
      );
      t.ok(
        echoesScope,
        "the payload states the idle threshold it swept with, so its zeros have a scope",
        {
          expected: "the idleMinutes it used, echoed back",
          actual: `keys: ${Object.keys(blind).join(", ")}`,
        },
      );
    } finally {
      await client.end().catch(() => {});
    }
  },
};
