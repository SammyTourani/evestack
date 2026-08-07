/**
 * Create every table `scripts/seed.mjs` writes into, before it runs.
 *
 * WHY THIS EXISTS. The dashboard creates its own tables lazily — `evestack.spans`
 * on the first trace read, the four `evestack.budget_*` tables on the first budget
 * write — because a self-hosted install has no migration step to hang them off.
 * That is fine at runtime and useless to a seeder, which is a pile of INSERTs with
 * nothing to trigger the lazy path. Loading the seed into a database that has only
 * had `db:bootstrap` run against it fails on
 *
 *     ERROR:  relation "evestack.budget_steps" does not exist
 *
 * and then every COPY line after it is read as a command, so psql reports a wall
 * of syntax errors and no seeded rows.
 *
 * The DDL is NOT copied here. It is imported from the two modules that own it, so
 * a column added to either arrives here without anyone remembering to mirror it.
 * Mirroring is the failure this repo keeps finding: two spellings of the same
 * schema is how the wrong one keeps a caller.
 *
 * Idempotent — both are `CREATE TABLE IF NOT EXISTS` underneath — so it is safe on
 * a database that is already set up.
 */
// A relative path, not a bare specifier, and deliberately. The dashboard does not
// depend on @evestack/budget — it reads those four tables with SQL and nothing
// else, which is what lets a self-hosted install run the dashboard without the
// budget package installed at all. Adding the dependency to package.json so this
// one script could use a bare import would put a runtime dependency in the
// container to serve a build-time seeding step. The workspace layout is fixed, so
// the path is stable; `dist/` is built by the package's own prepack/build.
import {
  ensureSchema as ensureBudgetSchema,
  resolveConfig as resolveBudgetConfig,
} from "../../evestack-budget/dist/index.js";
import { ensureTraceSchema } from "../lib/traces.ts";

if (!process.env.WORKFLOW_POSTGRES_URL) {
  console.error(
    "WORKFLOW_POSTGRES_URL is not set. This writes schema to that database and nowhere else.",
  );
  process.exit(2);
}

await ensureTraceSchema();
console.log("✓ evestack.spans");

// `resolveConfig()`, not a bare `{}`. A BudgetConfig carries the resolved
// `databaseUrl`, and an empty object has none — the package then throws
// "needs WORKFLOW_POSTGRES_URL … (or an explicit databaseUrl)", which is a
// correct message about a config nobody built rather than about a missing env
// var. resolveConfig is the function that reads the environment, and it is the
// same one the agent's hook uses, so this connects wherever the agent would.
await ensureBudgetSchema(resolveBudgetConfig());
console.log("✓ evestack.budget_steps, budget_usage, budget_events, budget_stops");

// Every probe in this repo has to be able to say it DID something; so does this.
// A silent success here is indistinguishable from a script that connected to the
// wrong database and wrote nothing.
const { query } = await import("../lib/db.ts");
const [row] = await query(
  `SELECT count(*)::int AS n FROM information_schema.tables
    WHERE table_schema = 'evestack'
      AND table_name IN ('spans','budget_steps','budget_usage','budget_events','budget_stops')`,
);
if (Number(row?.n) !== 5) {
  console.error(`expected 5 evestack tables, found ${row?.n}`);
  process.exit(1);
}
console.log(`✓ ${row.n} tables present — seed.mjs can load`);
process.exit(0);
