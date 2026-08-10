import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { installStubPool, uninstallStubPool } from "./stub-pool.mjs";

const PACKAGE_ROOT = new URL("../", import.meta.url);

// The health route imports through the "@/…" tsconfig alias, which Node does
// not know about. Same hook, same reason, as test/route-validation.test.mjs.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      const candidate = new URL(`${specifier.slice(2)}.ts`, PACKAGE_ROOT);
      if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const { SCHEMA_TOO_NEW, describeDbFailure, isSchemaTooNew } = await import("../lib/db.ts");
const { parseSchemaTarget, traceSchemaTarget } = await import("../lib/traces.ts");
const { factSchemaTarget } = await import("../lib/facts.ts");
const { GET: health } = await import("../app/api/health/route.ts");

// The route short-circuits to `unconfigured` without these, before it ever
// reaches the database.
process.env.EVESTACK_AUTH_USER = "probe";
process.env.EVESTACK_AUTH_PASSWORD = "probe-password";

// Two separate to_regclass probes: the route asks whether eve's schema exists,
// and lib/facts.ts#schemaVersionsAhead asks whether our marker table does. The
// stub matches on a SQL fragment, so they need distinguishable ones.
const WORKFLOW_PRESENT_SQL = "to_regclass('workflow.workflow_runs')";
const MARKER_PRESENT_SQL = "to_regclass('evestack.schema_version')";
const VERSION_SQL = "SELECT component, version FROM evestack.schema_version";

/**
 * The schema files must refuse a database that is NEWER than they are.
 *
 * WHAT WENT WRONG. Both files moved their version marker forward only, which
 * stopped an older image decrementing the number and stopped nothing else:
 * every CREATE OR REPLACE FUNCTION in them ran unconditionally. So an older
 * dashboard image replaced a newer database's functions and left the marker
 * claiming the newer version -- which also meant the migration that would have
 * repaired it could never re-run. Measured on a live install: the marker read
 * `spans v4` while `resolve_span_ancestry` was the v3 body, and fresh spans
 * resolved to `turn_0`. sql/facts.sql was worse: its migration DROPS all three
 * fact tables whenever the marker is not its own version, and its stamp had no
 * forward-only clause at all, so an older image dropped a newer database's fact
 * tables and then wrote its own lower number over the marker.
 *
 * The behaviour is proved against a real server by
 * contract/runtime/probes/06-span-attribution.probe.mjs and 07-fact-tables,
 * which apply these files for real. What is asserted here is the STRUCTURE the
 * guard depends on and that a reviewer cannot check by reading one hunk: that
 * it comes first, that its version constant still matches the migration it
 * guards, and that the file is one transaction so the statements after it
 * cannot run when it raises.
 */

const read = (name) => readFileSync(new URL(`../sql/${name}`, import.meta.url), "utf8");
const FILES = ["traces.sql", "facts.sql"];

/**
 * The file with its comments taken out.
 *
 * Not cosmetic: the guard's own comment names the statements it exists to stop,
 * so a search over the raw text finds "CREATE OR REPLACE FUNCTION" in the prose
 * ABOVE the guard and concludes the guard is in the wrong place. Offsets below
 * are into this string, never into the original.
 */
const code = (name) =>
  read(name)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ");

/** `target constant integer := N`, every occurrence, in file order. */
const targets = (sql) => [...sql.matchAll(/target\s+constant\s+integer\s*:=\s*(\d+)/g)].map((m) => Number(m[1]));

test("the guard is the first thing in each file that can be skipped", () => {
  for (const name of FILES) {
    const sql = code(name);
    const guard = sql.indexOf("ERRCODE = '" + SCHEMA_TOO_NEW + "'");
    assert.ok(guard !== -1, `${name} raises no ${SCHEMA_TOO_NEW}`);

    // Position IS the mechanism. Piped into psql this file is a statement per
    // transaction, so anything the guard is meant to stop has to come after it.
    for (const later of ["CREATE OR REPLACE FUNCTION", "DROP TABLE", "CREATE INDEX"]) {
      const at = sql.indexOf(later);
      if (at === -1) continue;
      assert.ok(at > guard, `${name}: "${later}" runs before the version guard`);
    }
  }
});

test("each file is one transaction, so an aborted guard cannot be walked past", () => {
  for (const name of FILES) {
    const sql = read(name).trim();
    const bare = code(name);
    assert.ok(/(^|\n)BEGIN;/.test(sql), `${name} does not open a transaction`);
    assert.ok(sql.endsWith("COMMIT;"), `${name} does not close its transaction`);
    // Anything that refuses a transaction block would fail on every boot.
    assert.ok(!/CONCURRENTLY|VACUUM|ALTER SYSTEM/.test(bare), `${name} cannot be transactional`);
  }
});

test("the guard is checking the same version number the migration installs", () => {
  // Two copies exist because a plpgsql block cannot export a constant and the
  // guard has to run hundreds of lines before the migration. Copies drift;
  // this is what makes drift a failing test rather than a silent hole where
  // the guard is enforcing the wrong number.
  for (const name of FILES) {
    const found = targets(read(name));
    assert.ok(
      found.length >= 2,
      `${name} declares ${found.length} \`target constant integer\` value(s), expected 2: one ` +
        "in the downgrade guard at the top of the file and one in the migration it protects. " +
        "If you removed one, the guard is no longer checking the version the migration installs.",
    );
    assert.equal(
      new Set(found).size,
      1,
      `${name} declares disagreeing schema targets: ${found.join(" and ")}.\n\n` +
        "BOTH `target constant integer := N` literals in this file must move together in the " +
        "same edit — the one in the downgrade guard at the TOP of the file and the one in the " +
        "migration further down. They are separate declarations because a plpgsql DO block " +
        "cannot export a constant and the guard has to run hundreds of lines earlier.\n\n" +
        "Bumping only the migration means the guard keeps enforcing the OLD version, so this " +
        "image will happily apply itself over a database it does not understand — which is the " +
        "exact failure the guard was added to stop. Bumping only the guard means the migration " +
        "never installs the version the marker will claim.",
    );
  }
});

test("the version each file stamps is the version its guard enforces", () => {
  const traces = read("traces.sql");
  assert.match(traces, /VALUES \('spans', target\)/);

  const facts = read("facts.sql");
  const stamped = /VALUES \('facts', (\d+)\)/.exec(facts);
  assert.ok(stamped, "facts.sql stamps no version");
  assert.equal(Number(stamped[1]), targets(facts)[0], "facts.sql stamps a version it does not guard");
});

test("neither file can move its marker backwards", () => {
  // The second half of the downgrade, and the half facts.sql was missing: an
  // older image writing its own lower number over a newer one makes the next
  // boot of the newer image believe it has already applied itself.
  const FORWARD_ONLY = new RegExp(
    "WHERE evestack\\.schema_version\\.version < EXCLUDED\\.version",
  );
  for (const name of FILES) {
    assert.match(read(name), FORWARD_ONLY, `${name} stamps its version unconditionally`);
  }
});

test("the raised error is one the dashboard can recognise and explain", () => {
  // pg puts the SQLSTATE on `error.code` and lib/db.ts flattens it into the
  // message before any page sees it, so the classification has to survive as a
  // string. Matching on the code and not on the prose is what lets the message
  // be reworded, and what stops a Postgres locale turning this back into
  // "can't reach the database".
  const raised = new Error(
    `${SCHEMA_TOO_NEW}: evestack.spans is at schema version 4, and this build of evestack ` +
      "only understands version 3.",
  );
  assert.ok(isSchemaTooNew(raised));
  const failure = describeDbFailure(raised);
  assert.match(failure.title, /older than its database/i);
  assert.match(failure.detail, /version 4/);
  // The two wrong fixes, refused by name: neither the container nor the schema
  // is what needs changing here.
  assert.ok(!/docker compose up/.test(failure.guidance), "tells you to restart a healthy database");
  assert.ok(!/db:bootstrap/.test(failure.guidance), "tells you to bootstrap a schema that exists");
});

test("an ordinary failure is not mistaken for a version mismatch", () => {
  assert.equal(isSchemaTooNew(new Error("ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:5433")), false);
  assert.equal(isSchemaTooNew(new Error('42P01: relation "workflow.workflow_runs" does not exist')), false);
  assert.equal(isSchemaTooNew(null), false);
  assert.equal(isSchemaTooNew(undefined), false);
  // Anchored, not a substring search: a session id or a model name that happens
  // to contain these five characters is not a version mismatch.
  assert.equal(isSchemaTooNew(new Error("42P01: relation \"sessEV001\" does not exist")), false);
  // And the raw driver error, which still carries the code as a field.
  assert.equal(isSchemaTooNew(Object.assign(new Error("nope"), { code: SCHEMA_TOO_NEW })), true);
});

/* -------------------------------------------------------------------------- */
/* the number this build installs, and the endpoint that has to admit to it   */
/* -------------------------------------------------------------------------- */

test("the target the code reports is the one the file declares", () => {
  // Read out of the SQL rather than restated in TypeScript. If this ever
  // needs a literal on the JS side, it becomes a third copy to forget.
  assert.equal(traceSchemaTarget(), targets(read("traces.sql"))[0]);
  assert.equal(factSchemaTarget(), targets(read("facts.sql"))[0]);
  assert.ok(Number.isInteger(traceSchemaTarget()) && traceSchemaTarget() > 0);
  assert.ok(Number.isInteger(factSchemaTarget()) && factSchemaTarget() > 0);
});

test("a file with no target constant says so instead of guessing a version", () => {
  assert.throws(
    () => parseSchemaTarget("CREATE TABLE x (y int);", "sql/nothing.sql"),
    /sql\/nothing\.sql declares no target constant/,
  );
});

test("/api/health refuses to call a too-new database healthy", async () => {
  // The defect this branch exists for was measured, not imagined: a container
  // in exactly this state answered `ok` here for two hours while its trace
  // pages were empty and its resolver had been silently replaced.
  const pool = installStubPool([
    [WORKFLOW_PRESENT_SQL, [{ present: "workflow.workflow_runs" }]],
    [MARKER_PRESENT_SQL, [{ present: "evestack.schema_version" }]],
    [VERSION_SQL, [{ component: "spans", version: traceSchemaTarget() + 1 }]],
  ]);
  try {
    const response = await health();
    const body = await response.json();
    assert.equal(response.status, 503, "Docker reads the status, so it has to be the failing one");
    assert.equal(body.ok, false);
    assert.equal(body.status, "degraded");
    assert.equal(body.reason, "schema-too-new");
    assert.equal(body.database, "connected", "Postgres is fine; this image is not");
    assert.match(body.error, new RegExp(`spans is at v${traceSchemaTarget() + 1}`));
    assert.match(body.error, /refusing spans/);
    // The half that still works has to be named, or "degraded" is just a mood.
    assert.ok(body.unavailable.includes("/traces"));
    assert.ok(body.unavailable.includes("/api/ingest/v1/traces"));
    assert.ok(body.available.includes("/monitors"));
  } finally {
    uninstallStubPool(pool);
  }
});

test("a database at the version this build installs is still healthy", async () => {
  // The check must not fire on every normal install, which is the way a
  // health endpoint gets ignored.
  const pool = installStubPool([
    [WORKFLOW_PRESENT_SQL, [{ present: "workflow.workflow_runs" }]],
    [MARKER_PRESENT_SQL, [{ present: "evestack.schema_version" }]],
    [
      VERSION_SQL,
      [
        { component: "spans", version: traceSchemaTarget() },
        { component: "facts", version: factSchemaTarget() },
        // A component this build knows nothing about is not a downgrade.
        { component: "something_else", version: 99 },
      ],
    ],
  ]);
  try {
    const response = await health();
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
  } finally {
    uninstallStubPool(pool);
  }
});
