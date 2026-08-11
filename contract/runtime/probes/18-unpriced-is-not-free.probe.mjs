/**
 * A model with no catalog price must read as `unpriced`, never as $0.00.
 *
 * /costs states the rule in the product itself: "A model missing from it is
 * reported as unpriced rather than free \u2014 a monitor fires when any unpriced
 * model runs." Both halves shipped unexercised end to end. The catalog has 206
 * generated entries plus an `ollama/*` wildcard, and the two paths a real
 * install takes are the two that never reach the branch:
 *
 *   - a paid install runs models that ARE in the catalog, so `priced` is true;
 *   - the free Ollama install matches the wildcard, so `priced` is true as
 *     well, and its $0.00 is a real zero rather than a missing price.
 *
 * Reaching `priced = false` needs a model that is in neither set, which needs
 * either a paid key for something obscure or a fixture. The cape-town stranger
 * test marked this CAN'T TELL for exactly that reason.
 *
 * Three states, not two, and that is the whole difficulty:
 *
 *   priced = TRUE, cost 0     the model is free, and we know it (ollama/*)
 *   priced = FALSE, cost NULL nobody has said what it costs; the bill is unknown
 *   priced = NULL             no model call happened at all
 *
 * `costUsd()` returns 0 for all three, so any surface that reads the dollars
 * without reading `priced` renders an unpriced model as a confident $0.00.
 * That is the bug this file exists to keep out.
 *
 * WHAT THIS WRITES
 *
 * Three fixture rows in `workflow.workflow_runs` and whatever
 * `refreshFacts()` derives from them, all named `probe-unpriced` and all
 * removed in the `finally`, including their derived fact rows. It writes
 * nothing else. Probe 12 already writes to this table for the same reason:
 * the state under test cannot be observed without creating it.
 */
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DASHBOARD = join(HERE, "../../../packages/dashboard");

/**
 * A model that is in neither the generated catalog nor the `ollama/*`
 * wildcard. Deliberately not `acme/experimental-v1`: that one is in
 * scripts/seed.mjs, so a probe using it could be satisfied by seeded rows it
 * did not create and would go quiet on an unseeded database.
 */
const UNPRICED_MODEL = "probe-vendor/no-catalog-entry-v0";
/** Priced at zero on purpose. The distinction under test lives right here. */
const FREE_MODEL = "ollama/qwen3";

async function connect() {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: process.env.WORKFLOW_POSTGRES_URL });
  await client.connect();
  client.on("error", () => {});
  return client;
}

export default {
  id: "pricing/unpriced-is-never-a-silent-zero",
  title: "a model with no catalog price is reported unpriced, and the monitor says so",
  needs: ["postgres", "typescript"],
  why:
    "costUsd() returns 0 for a model it has never heard of, exactly as it does for a model that " +
    "is genuinely free. The only thing separating an unknown bill from a zero bill is the `priced` " +
    "flag, and every surface has to read it. If the flag stops being written, or a caller forgets " +
    "it, the costs page reports a confident $0.00 for spend it cannot see, and the monitor that is " +
    "supposed to say so stays quiet.",

  async available() {
    if (!process.env.WORKFLOW_POSTGRES_URL) return ["WORKFLOW_POSTGRES_URL is not set"];
    try {
      const client = await connect();
      const { rows } = await client.query(
        "SELECT to_regclass('workflow.workflow_runs')::text AS runs",
      );
      await client.end();
      if (!rows[0]?.runs) return ["workflow.workflow_runs does not exist"];
      return [];
    } catch (error) {
      return [`cannot reach Postgres: ${error.message}`];
    }
  },

  async run(t) {
    const cwd = process.cwd();
    // lib/facts.ts reads its DDL relative to the working directory, which is
    // how the dashboard runs it. Same move as probes 07 and 08.
    process.chdir(DASHBOARD);
    await import(join(DASHBOARD, "test/register-ts-resolve.mjs"));
    const pricing = await import(join(DASHBOARD, "lib/pricing.ts"));
    const facts = await import(join(DASHBOARD, "lib/facts.ts"));
    const alerts = await import(join(DASHBOARD, "lib/alerts.ts"));
    const queries = await import(join(DASHBOARD, "lib/queries.ts"));
    const db = await import(join(DASHBOARD, "lib/db.ts"));

    const client = await connect();
    const stamp = randomUUID().replace(/-/g, "").slice(0, 10);
    const session = `wrun_probe_unpriced_${stamp}`;
    const runs = {
      unpriced: `${session}_a`,
      free: `${session}_b`,
      noModel: `${session}_c`,
    };
    // The session row is in here too, so the cleanup takes it away with the rest.
    const ids = [...Object.values(runs), session];

    try {
      /* ── the catalog itself ──────────────────────────────────────────── */

      t.ok(
        pricing.findPrice(UNPRICED_MODEL) === null && pricing.isPriced(UNPRICED_MODEL) === false,
        `${UNPRICED_MODEL} is absent from the catalog, which is what makes this probe mean anything`,
        { expected: "null", actual: JSON.stringify(pricing.findPrice(UNPRICED_MODEL)) },
      );
      t.ok(
        pricing.isPriced(FREE_MODEL) === true && pricing.costUsd(FREE_MODEL, 1e6, 1e6) === 0,
        `${FREE_MODEL} is priced, and priced at zero: a real $0.00 rather than a missing price`,
        { expected: "isPriced true, cost 0", actual: JSON.stringify(pricing.findPrice(FREE_MODEL)) },
      );
      // The trap in one line. Dollars alone cannot tell the two apart, which is
      // why every caller has to read `priced`.
      t.ok(
        pricing.costUsd(UNPRICED_MODEL, 1e6, 1e6) === pricing.costUsd(FREE_MODEL, 1e6, 1e6),
        "cost alone cannot distinguish them: both are 0, so the flag is the only evidence",
        { expected: "equal", actual: "they differ, and this probe is no longer describing the risk" },
      );

      /* ── the monitor before we touch anything ─────────────────────────── */

      // A monitor that is already firing proves nothing when it fires again.
      const before = (await alerts.evaluateAlerts()).find((a) => a.id === "unpriced_spend");
      t.ok(before !== undefined, "there is an unpriced_spend monitor to check", {
        expected: "an alert with id unpriced_spend",
        actual: "absent",
      });
      const { rows: pre } = await client.query(
        `select count(*)::int as n from evestack.fact_turn
          where priced is false and created_at >= date_trunc('day', now())`,
      );
      const alreadyUnpriced = pre[0].n;
      t.note(`unpriced turns already recorded today: ${alreadyUnpriced}; monitor is ${before?.state}`);
      if (alreadyUnpriced === 0) {
        t.ok(
          before?.state === "ok",
          "with no unpriced turns today the monitor is quiet, so a later firing means something",
          { expected: "ok", actual: String(before?.state) },
        );
      }

      /* ── three turns, one of each state ────────────────────────────────── */

      const insert = async (id, model, completed) => {
        const attributes = {
          "$eve.type": "turn",
          "$eve.root": session,
          "$eve.title": "probe-unpriced fixture",
          ...(model === null
            ? {}
            : {
                "$eve.model": model,
                "$eve.input_tokens": "1000000",
                "$eve.output_tokens": "1000000",
                "$eve.cache_read_tokens": "0",
                "$eve.cache_write_tokens": "0",
              }),
        };
        await client.query(
          `insert into workflow.workflow_runs
             (id, deployment_id, status, name, attributes,
              created_at, updated_at, started_at, completed_at)
           values ($1, 'probe-unpriced', 'completed', 'probe.turn', $2::jsonb,
                   now(), now(), now(), $3)`,
          [id, JSON.stringify(attributes), completed ? new Date() : null],
        );
      };

      // A session row as well, so the OTHER cost path can be exercised. The
      // fact table is not the only place a dollar figure is computed:
      // lib/queries.ts sums costUsd() per turn for the session list and for
      // /api/health/detail. A rule that holds in one of two cost paths is not
      // a rule.
      //
      // Careful with app/sessions/rollup.ts:31-33 here — an earlier draft of
      // this probe cited it as the code admitting it "has no way to tell an
      // unpriced model from a free one". It says the opposite. That sentence
      // describes the REJECTED alternative — summing `$eve.*` tags on the page,
      // as the old one did — and is the stated reason the page reads
      // `fact_turn` instead. The `/sessions` page has been right about this all
      // along; it was this path that was wrong.
      await client.query(
        `insert into workflow.workflow_runs
           (id, deployment_id, status, name, attributes, created_at, updated_at, started_at)
         values ($1, 'probe-unpriced', 'running'::workflow.status, 'probe.session', $2::jsonb,
                 now(), now(), now())`,
        [
          session,
          JSON.stringify({
            "$eve.type": "session",
            "$eve.title": "probe-unpriced fixture",
            "$eve.trigger": "probe",
          }),
        ],
      );

      await insert(runs.unpriced, UNPRICED_MODEL, true);
      await insert(runs.free, FREE_MODEL, true);
      // No model at all: the turn never reached a provider. Neither priced nor
      // unpriced, and counting it as either is a bug this suite has already had.
      await insert(runs.noModel, null, true);

      const refreshed = await facts.refreshFacts();
      t.ok(
        refreshed.unpricedModels.includes(UNPRICED_MODEL),
        "refreshFacts names the model it could not price, rather than pricing it at zero",
        { expected: UNPRICED_MODEL, actual: JSON.stringify(refreshed.unpricedModels) },
      );

      /* ── what landed in the fact table ─────────────────────────────────── */

      const { rows: facts3 } = await client.query(
        `select run_id, model, priced, cost_usd, cost_input_usd, cost_output_usd
           from evestack.fact_turn where run_id = any($1::text[]) order by run_id`,
        [ids],
      );
      const by = new Map(facts3.map((r) => [r.run_id, r]));

      t.ok(
        facts3.length === 3,
        "all three fixture turns were materialised, so the assertions below are about real rows",
        { expected: "3", actual: `${facts3.length}: ${facts3.map((r) => r.run_id).join(", ")}` },
      );

      const u = by.get(runs.unpriced);
      t.ok(u?.priced === false, "the uncatalogued model is marked unpriced, not priced", {
        expected: "false",
        actual: String(u?.priced),
      });
      // The load-bearing one. NULL, not 0, because SUM() skips NULLs: an
      // unpriced model then contributes nothing to spend instead of
      // contributing a confident zero to it.
      t.ok(
        u?.cost_usd === null && u?.cost_input_usd === null && u?.cost_output_usd === null,
        "and carries NULL dollars, so it cannot be summed into a total as if it were free",
        { expected: "NULL", actual: `cost_usd=${u?.cost_usd} input=${u?.cost_input_usd}` },
      );

      const f = by.get(runs.free);
      t.ok(f?.priced === true, "the Ollama model is priced", {
        expected: "true",
        actual: String(f?.priced),
      });
      t.ok(
        f?.cost_usd !== null && Number(f?.cost_usd) === 0,
        "and carries a real 0.00, which is a different answer from NULL",
        { expected: "0", actual: String(f?.cost_usd) },
      );

      const n = by.get(runs.noModel);
      t.ok(
        n?.priced === null,
        "a turn that never called a model is neither priced nor unpriced",
        { expected: "null", actual: String(n?.priced) },
      );

      /* ── the sum a costs page would show ───────────────────────────────── */

      // The failure this guards is arithmetic, not presentational: if the
      // unpriced row ever carried 0 instead of NULL, this sum would be
      // identical and nothing would look wrong.
      const { rows: summed } = await client.query(
        `select sum(cost_usd) as total,
                count(*) filter (where priced is false)::int as unpriced,
                count(*) filter (where priced) :: int as priced,
                count(*) filter (where priced is null)::int as no_model
           from evestack.fact_turn where run_id = any($1::text[])`,
        [ids],
      );
      t.ok(
        summed[0].unpriced === 1 && summed[0].priced === 1 && summed[0].no_model === 1,
        "the three states are countable separately, which is what lets a page warn about one",
        { expected: "1/1/1", actual: JSON.stringify(summed[0]) },
      );

      /* ── the monitor fires ─────────────────────────────────────────────── */

      const after = (await alerts.evaluateAlerts()).find((a) => a.id === "unpriced_spend");
      t.ok(after?.state === "firing", "the monitor fires the moment one unpriced model runs", {
        expected: "firing",
        actual: `${after?.state}: ${after?.detail}`,
      });
      t.ok(
        typeof after?.detail === "string" && after.detail.includes(UNPRICED_MODEL),
        "and names the model, so the reader can go and price it",
        { expected: UNPRICED_MODEL, actual: String(after?.detail) },
      );
      // "unknown, not zero" is the sentence that stops a reader treating the
      // total as complete. If the copy loses it, the monitor is decoration.
      t.ok(
        typeof after?.detail === "string" && /unknown, not zero/.test(after.detail),
        "and says the cost is unknown rather than zero",
        { expected: "unknown, not zero", actual: String(after?.detail) },
      );
      /* ── the other cost path ─────────────────────────────────────── */

      // /api/health/detail and the session list do not read fact_turn.priced.
      // They sum costUsd() per turn (lib/queries.ts#sumCostParts), and
      // costUsd() returns 0 for a model it has never heard of. So a monitor
      // polling /api/health/detail sees a session that spent $0.00 when what
      // actually happened is that nobody knows what it spent.
      const listed = (await queries.listSessions(200)).find((row) => row.id === session);
      t.ok(listed !== undefined, "the fixture session is on the session list", {
        expected: session,
        actual: "not listed",
      });
      if (listed) {
        t.ok(
          listed.includingSubagents.models.includes(UNPRICED_MODEL),
          "the session list knows an unpriced model ran under this session",
          { expected: UNPRICED_MODEL, actual: JSON.stringify(listed.includingSubagents.models) },
        );
        // The rule from /costs, applied to the surface a monitor polls. Either
        // the number must not be a confident zero, or something beside it must
        // say the total is incomplete. Both would be fine; neither is not.
        //
        // Asserted on the VALUE, never on the shape. An earlier form of this
        // check read `Object.keys(...).some(k => /priced/i.test(k))` — the
        // presence of a plausibly-named field. That would have been satisfied by
        // adding `unpricedModels: []` and never filling it, which is the failure
        // this whole probe exists to catch, one level up. A field that is always
        // empty is a confident zero wearing a different name.
        const cost = listed.includingSubagents.costUsd;
        const named = listed.includingSubagents.unpricedModels ?? [];
        const saysSo = named.includes(UNPRICED_MODEL);
        t.ok(
          cost !== 0 || saysSo,
          "a session whose only model is unpriced does not report a confident $0.00",
          {
            expected: `a non-zero cost, or unpricedModels naming ${UNPRICED_MODEL}`,
            actual:
              `costUsd ${cost}, unpricedModels ${JSON.stringify(named)}. ` +
              "If unpricedModels is absent or empty, sumCostParts() in lib/queries.ts " +
              "priced this session without asking whether a price existed, and " +
              "/api/health/detail is reporting unpriced spend as zero spend.",
          },
        );
        // The other half, and the one that decays quietly: a model the catalog
        // DOES price at zero must not be dragged in here. `ollama/*` is a real
        // $0.00. If it ever appears, every local install grows a permanent
        // warning about spend it can see perfectly well, and the flag stops
        // meaning anything.
        t.ok(
          !named.includes(FREE_MODEL),
          "a catalogued zero-price model is not reported as unpriced",
          {
            expected: `${FREE_MODEL} absent from unpricedModels`,
            actual: JSON.stringify(named),
          },
        );
      }

    } finally {
      // Undo everything, derived rows included. A left-behind fact row would
      // keep the monitor firing for a fault nobody has.
      await client
        .query(`delete from evestack.fact_tool_call where run_id = any($1::text[])`, [ids])
        .catch(() => {});
      await client
        .query(`delete from evestack.fact_turn where run_id = any($1::text[])`, [ids])
        .catch(() => {});
      await client
        .query(`delete from workflow.workflow_runs where id = any($1::text[])`, [ids])
        .catch(() => {});
      await client.end().catch(() => {});
      await db.closePool().catch(() => {});
      process.chdir(cwd);
    }
  },
};
