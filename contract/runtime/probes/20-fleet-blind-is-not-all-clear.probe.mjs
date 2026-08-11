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
// Ids the fixture below uses. Distinctive so a leftover row is obviously the
// probe's and can be removed by hand without guessing.
const FIXTURE_SESSION = "probe_fleet_blind_session";
const FIXTURE_TURN = "probe_fleet_blind_turn";
/** Deliberately absent from the pricing catalog. See the health/detail block. */
const UNPRICED_MODEL = "probe-vendor/no-catalog-entry-v0";
/** Finished sessions, so the population exceeds anything findings can count. */
const FIXTURE_SETTLED = "probe_fleet_blind_settled";

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
    const created = [];
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

      // Anti-vacuity, and it has to count the right population.
      //
      // This used to count SESSIONS, and that is not what the idle gate acts on.
      // inspectFleet's candidate set is sessions that are `status = 'running'`
      // AND still carry a turn row with `completed_at IS NULL` — a closed
      // session is never a candidate at any threshold. So on a database full of
      // finished sessions there is nothing for `idleMinutes` to include or
      // exclude, both sweeps return the same all-clear, and that answer is
      // CORRECT rather than blind: `checked: 0, tooRecent: 0` is the documented
      // encoding of "no session in this database has a turn open".
      //
      // The weaker guard let CI reach the comparison below with four finished
      // sessions and fail on a difference that could not exist. The probe was
      // wrong, not the endpoint — and a probe that fails where the product is
      // right is worse than no probe, because the next person silences it.
      const { rows: population } = await client.query(
        `select count(*)::int as candidates
           from workflow.workflow_runs s
          where s.attributes->>$1 = 'session'
            and s.status = 'running'
            and exists (
              select 1 from workflow.workflow_runs t
               where t.attributes->>$2 = s.id
                 and t.attributes->>$1 in ('turn', 'subagent')
                 and t.completed_at is null
            )`,
        ["$eve.type", "$eve.root"],
      );
      const found = population[0].candidates;
      t.note(`${found} pre-existing session(s) with an open turn`);

      // If the stack under test has none, MAKE one rather than skipping or
      // failing. A probe that only runs when someone else happens to have left
      // a turn in flight is a probe that runs on a developer's laptop and never
      // in CI — which is exactly how this one reached main untested. Two rows,
      // removed in the `finally` below whatever happens.
      //
      // `updated_at = now()` is what makes the fixture answer both questions: a
      // session quiet for 0 ms is past an `idleMinutes=0` gate and nowhere near
      // a 30-day one, so one sweep must classify it and the other must report it
      // as skipped. If those two answers are the same bytes, the endpoint cannot
      // say what it did not look at, which is the whole claim.
      if (found === 0) {
        await client.query(
          `insert into workflow.workflow_runs
             (id, deployment_id, status, name, attributes, created_at, updated_at, started_at)
           values ($1, 'probe-fleet-blind', 'running'::workflow.status, 'probe.session', $2::jsonb,
                   now(), now(), now())`,
          [FIXTURE_SESSION, JSON.stringify({ "$eve.type": "session", "$eve.title": "probe-fleet-blind" })],
        );
        created.push(FIXTURE_SESSION);
        await client.query(
          `insert into workflow.workflow_runs
             (id, deployment_id, status, name, attributes, created_at, updated_at, started_at, completed_at)
           values ($1, 'probe-fleet-blind', 'running'::workflow.status, 'probe.turn', $2::jsonb,
                   now(), now(), now(), null)`,
          [
            FIXTURE_TURN,
            JSON.stringify({
              "$eve.type": "turn",
              "$eve.root": FIXTURE_SESSION,
              // An id the pricing catalog has never heard of, with real token
              // counts behind it. That makes this fixture serve the second
              // assertion block below as well as the sweep: costUsd() answers 0
              // for it, exactly as it answers 0 for a genuinely free model, and
              // only `unpricedModels` can tell a reader which 0 they are looking at.
              "$eve.model": UNPRICED_MODEL,
              "$eve.input_tokens": "1000000",
              "$eve.output_tokens": "1000000",
              "$eve.cache_read_tokens": "0",
              "$eve.cache_write_tokens": "0",
            }),
          ],
        );
        created.push(FIXTURE_TURN);
        t.note("planted a running session with one open turn, so the gate has a candidate");

        // Settled sessions, so the POPULATION is strictly larger than anything a
        // findings field can report. Without them the fixture is the only row in
        // a fresh database, total is 1, and `tooRecent: 1` clears a `>= total`
        // bar on its own — which is how the first version of the assertion below
        // stayed green with the field it exists to check DELETED.
        for (let i = 0; i < 3; i += 1) {
          const id = `${FIXTURE_SETTLED}_${i}`;
          await client.query(
            `insert into workflow.workflow_runs
               (id, deployment_id, status, name, attributes, created_at, updated_at, started_at, completed_at)
             values ($1, 'probe-fleet-blind', 'completed'::workflow.status, 'probe.session', $2::jsonb,
                     now(), now(), now(), now())`,
            [id, JSON.stringify({ "$eve.type": "session", "$eve.title": "probe-fleet-blind settled" })],
          );
          created.push(id);
        }
      }

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
      // stated skipped/settled count, or a stated total.
      //
      // COUNTS ONLY. This summed every numeric field, and the payload carries
      // `idleThresholdMs` and `wedgeAfterMs` — 2,592,000,000 and 3,600,000 for
      // the blind sweep. Any session total is smaller than either, so the sum
      // cleared the bar no matter what the counts said and the assertion passed
      // for arithmetic reasons rather than for the reason it was written. A
      // duration is not a tally of sessions; excluding `*Ms` is what makes this
      // a statement about coverage.
      const counts = Object.entries(blind).filter(
        ([k, v]) => typeof v === "number" && !/Ms$/.test(k),
      );
      const accounted = counts.reduce((sum, [, v]) => sum + v, 0);
      const { rows: totalRows } = await client.query(
        "select count(*)::int as n from workflow.workflow_runs where attributes->>$1 = 'session'",
        ["$eve.type"],
      );
      const total = totalRows[0].n;
      t.note(`${total} session(s) in the database at the time of the sweep`);

      // EQUALS, not >=, and paired with a proof that the equality could not be a
      // coincidence. The first version of this asserted `some count >= total`,
      // and that could not fail: on a fresh database the fixture is the only
      // session, so `tooRecent: 1 >= total: 1` cleared the bar with the
      // population field DELETED — measured. A huge hardcoded constant cleared
      // it in every state, because `>=` never checks the number is right.
      //
      // The settled sessions planted above are what make this sharp: findings
      // can only ever count CANDIDATES, and there are strictly more sessions
      // than candidates now, so no findings field can reach the total by
      // accident. A field that equals it is reporting the population.
      const findings = ["checked", "unchecked", "tooRecent"].reduce(
        (sum, k) => sum + (typeof blind[k] === "number" ? blind[k] : 0),
        0,
      );
      t.ok(
        findings < total,
        "the fixture leaves more sessions than the sweep can possibly have found",
        {
          expected: `checked+unchecked+tooRecent < ${total}`,
          actual: `${findings} vs ${total} — without this the next assertion could pass by coincidence`,
        },
      );
      t.ok(
        counts.some(([, v]) => v === total),
        "the payload states the population it swept against, so 0 findings is readable",
        {
          expected: `a count equal to ${total}, the sessions in the database`,
          actual:
            `${JSON.stringify(Object.fromEntries(counts))}. A reader cannot tell 0-of-0 from ` +
            `0-of-${total}. Findings count candidates; nothing here counts what was there to ` +
            "sweep. /api/health/detail already reports the session total.",
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

      /* ── 4. the sibling endpoint, same doctrine ────────────────────────── */

      // /api/fleet must not report a zero it did not look for. /api/health/detail
      // must not report a dollar zero it could not compute. Same rule, two
      // endpoints, and this is the one a monitor polls for SPEND.
      //
      // It lives here rather than in probes/18 because 18 needs only Postgres —
      // it calls queries.listSessions() in-process and never issues an HTTP
      // request. So the route file itself was covered by nothing: deleting the
      // `unpricedModels` line from app/api/health/detail/route.ts restored the
      // original defect with every check in the repository still green. An
      // in-process assertion about a library cannot guard what a route ships.
      const detail = await call("/api/health/detail");
      const body = await json(detail);
      t.ok(detail.status === 200, "/api/health/detail answers a credentialed caller", {
        expected: "200",
        actual: `${detail.status} ${JSON.stringify(body).slice(0, 160)}`,
      });

      const ours = (body.recentSessions ?? []).find((r) => r.id === FIXTURE_SESSION);
      const wePlanted = created.includes(FIXTURE_TURN);
      if (wePlanted && ours) {
        // A value assertion, not a shape one. The fixture turn ran a model the
        // catalog does not have, so a correct payload reports 0 dollars AND
        // names the model it could not price. A field that is present and always
        // empty is a confident zero wearing a different name.
        t.ok(
          Array.isArray(ours.unpricedModels) &&
            ours.unpricedModels.includes(UNPRICED_MODEL),
          "the route names the model it could not price, beside the zero it reports",
          {
            expected: `unpricedModels containing ${UNPRICED_MODEL}`,
            actual: JSON.stringify({
              costUsd: ours.costUsd,
              unpricedModels: ours.unpricedModels,
            }),
          },
        );
        t.ok(
          Number.isFinite(ours.costUsd),
          "and the cost beside it is a real number rather than absent or NaN",
          { expected: "a finite number", actual: String(ours.costUsd) },
        );
      } else if (wePlanted) {
        t.ok(false, "the planted session reaches /api/health/detail", {
          expected: `${FIXTURE_SESSION} among recentSessions`,
          actual: `ids: ${(body.recentSessions ?? []).map((r) => r.id).join(", ") || "none"}`,
        });
      }

    } finally {
      // Every row this probe actually inserted, in reverse order of creation so
      // children go before parents. `created` is appended to AFTER each insert
      // returns, so a run that dies partway through removes exactly what it made.
      //
      // The previous version claimed to be "unconditional on `planted`" and then
      // opened with `if (planted)` — with `planted = true` set after BOTH
      // inserts, so the one case the comment named was the one case it did not
      // handle. Measured: forcing the second insert to fail left a `running`
      // session row behind, and every later run then died on a duplicate primary
      // key until someone deleted it by hand. A left-behind running session with
      // an open turn is not inert either: the fleet sweep calls it wedged an hour
      // later, on a stack nobody broke.
      if (created.length > 0) {
        await client
          .query("delete from workflow.workflow_runs where id = any($1::text[])", [
            [...created].reverse(),
          ])
          .catch(() => {});
      }
      await client.end().catch(() => {});
    }
  },
};
