import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFileSync, readdirSync } from "node:fs";
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
 * contract/runtime/probes/23-schema-downgrade-guard.probe.mjs, which stands up
 * a database of its own, applies each guarded file to it for real, moves the
 * marker one version ahead and applies it again — so the raise, its SQLSTATE,
 * the fact that nothing was applied, and /api/health's 503 are all observed
 * rather than inferred.
 *
 * THAT SENTENCE USED TO NAME PROBES 06 AND 07, AND IT WAS FALSE. Both of those
 * move the marker BACKWARD — 06 deletes the spans row, 07 sets facts to 0 — to
 * check that the migration re-runs. Neither ever sets a version ABOVE target,
 * so neither could reach `installed > target`, and the claim was load-bearing:
 * it is what licensed this file to assert structure only. With nothing
 * executing the raise, a guard reading `component = 'spanz'` was a permanent
 * no-op that passed every test here.
 *
 * What is asserted here is the STRUCTURE the guard depends on, which runs on
 * every commit rather than only where there is a database, and which a reviewer
 * cannot check by reading one hunk: that
 * it comes first, with nothing but no-ops ahead of it; that it reads the
 * component the file stamps; that its version constant still matches the
 * migration it guards; that the target it enforces is one some step in the file
 * actually installs; and that the file is one transaction so the statements
 * after it cannot run when it raises. Every file that carries a guard is
 * checked, and they are found by scanning sql/ rather than by a list.
 *
 * And one invariant belonging to the guard's blind spot rather than to the
 * guard: a rollback to an image that predates the guard is not something the
 * guard can refuse, so sql/traces.sql fingerprints the resolver it FINDS and
 * repairs when that is not the one it installs. Taking that fingerprint before
 * the replacement is the entire mechanism, and position is not something a
 * reviewer checks twice.
 */

const SQL_DIR = new URL("../sql/", import.meta.url);
const read = (name) => readFileSync(new URL(name, SQL_DIR), "utf8");
const ALL_SQL = readdirSync(SQL_DIR)
  .filter((name) => name.endsWith(".sql"))
  .sort();

/**
 * The guarded files, SCANNED and not listed.
 *
 * The list this replaces was `["traces.sql", "facts.sql"]`, and a hardcoded list
 * only covers what somebody remembered to add to it: a third guarded file got
 * every check in this suite for free and none of them applied to it. Measured —
 * a `sql/zz-budget.sql` whose guard read the wrong component, sat below its own
 * DROP TABLE and stamped a version it never installed passed all eleven tests,
 * because not one of them ever opened it. `.github/workflows/publish-dashboard.yml`
 * states the house rule for exactly this shape: scanned, not listed.
 *
 * The predicate is the one contract 22 uses, so the two agree on what "guarded"
 * means: the file raises this repository's SQLSTATE. `code()` is not used here —
 * a file that only mentions EV001 in prose is a file whose guard this suite
 * should be looking at anyway, and it will fail the position check below rather
 * than be quietly skipped.
 */
const FILES = ALL_SQL.filter((name) => read(name).includes(SCHEMA_TOO_NEW));

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

/**
 * Everything the file runs BEFORE its guard, as statements.
 *
 * Splitting on `;` is honest only where no dollar-quoted body can contain one,
 * so the caller asserts that first. The guard block itself is the boundary: the
 * `DO $tag$` that opens it, found from the RAISE inside it, since `code()` has
 * already removed the prose that also names these statements.
 */
function beforeTheGuard(name) {
  const sql = code(name);
  const raise = sql.indexOf("ERRCODE = '" + SCHEMA_TOO_NEW + "'");
  assert.ok(raise !== -1, `${name} raises no ${SCHEMA_TOO_NEW}`);
  const opens = sql.lastIndexOf("DO $", raise);
  assert.ok(opens !== -1, `${name} raises ${SCHEMA_TOO_NEW} outside a DO block`);
  const prefix = sql.slice(0, opens);
  assert.ok(
    !prefix.includes("$"),
    `${name} dollar-quotes something before its version guard, so this check cannot ` +
      "split it into statements and cannot tell you what runs first. Move it below the guard.",
  );
  return prefix
    .split(";")
    .map((statement) => statement.trim().replace(/\s+/g, " "))
    .filter(Boolean);
}

/**
 * What a file is allowed to run ahead of its own downgrade guard.
 *
 * AN ALLOWLIST, AND THAT IS THE POINT. This check used to name the three
 * statements it was worried about — CREATE OR REPLACE FUNCTION, DROP TABLE,
 * CREATE INDEX — and everything it had not thought of walked straight past it.
 * Measured: `ALTER TABLE evestack.spans DROP COLUMN`, `TRUNCATE`, and
 * `CREATE OR REPLACE TRIGGER` each inserted directly above the guard passed all
 * eleven tests, while `DROP TABLE IF EXISTS` in the same position correctly
 * failed — so the check was narrow rather than dead, which is the harder kind of
 * hole to notice. A list of what may NOT come first has to be extended by
 * memory; a list of what may is closed, and the guard's own comment already
 * says what belongs on it: only statements that are no-ops on any database that
 * could trip the guard.
 */
const ALLOWED_BEFORE_THE_GUARD = [
  /^BEGIN$/i,
  /^CREATE SCHEMA IF NOT EXISTS \w+$/i,
  /^CREATE TABLE IF NOT EXISTS \w+\.schema_version \(.*\)$/i,
];

test("the guard is the first thing in each file that can be skipped", () => {
  assert.ok(FILES.length > 0, "no sql file carries a downgrade guard, so this suite checks nothing");
  for (const name of FILES) {
    // Position IS the mechanism. Piped into psql this file is a statement per
    // transaction, so anything the guard is meant to stop has to come after it.
    for (const statement of beforeTheGuard(name)) {
      assert.ok(
        ALLOWED_BEFORE_THE_GUARD.some((allowed) => allowed.test(statement)),
        `${name} runs this before its version guard:\n\n    ${statement.slice(0, 200)}\n\n` +
          "Piped into psql each statement is its own transaction, so anything above the guard " +
          "has already committed by the time the guard refuses — which is how an older image " +
          "half-downgraded a newer database while the marker went on claiming the newer " +
          "version. Only statements that are no-ops on a database new enough to trip the guard " +
          "may come first: BEGIN, CREATE SCHEMA IF NOT EXISTS, and the marker table itself.",
      );
    }
  }
});

test("a file that writes the version marker is a file that carries the guard", () => {
  // The scan above finds files by their RAISE. This is the other direction, and
  // it is what makes the scan safe to trust: a new sql file that stamps or reads
  // evestack.schema_version but never raises would be invisible to FILES and
  // would therefore be exempt from every check in this suite.
  for (const name of ALL_SQL) {
    if (!read(name).includes("evestack.schema_version")) continue;
    assert.ok(
      FILES.includes(name),
      `sql/${name} takes part in the schema version marker but raises no ${SCHEMA_TOO_NEW}. ` +
        "Either it must refuse a database newer than itself, the way sql/traces.sql and " +
        "sql/facts.sql do, or it must not touch the marker at all.",
    );
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

test("a fingerprint of what was already installed is taken before it is replaced", () => {
  /*
   * THE SECOND HALF OF "THE MARKER SAYS WHAT WAS INSTALLED, NOT WHAT RAN".
   *
   * The version guard cannot see a rollback to an image that predates it:
   * published 0.3.1 has no guard and a forward-only stamp, so applying it over
   * a 0.4.0 database leaves the marker at 4 with the v3 resolver in place, and
   * the re-upgrade's `IF installed < 4` is false. sql/traces.sql therefore
   * records a fingerprint of the function body it FINDS, and the migration
   * repairs when that differs from the body it installs.
   *
   * That only works if the recording happens BEFORE the CREATE OR REPLACE. One
   * statement moved below it and the fingerprint describes the body this file
   * just installed, always matches, and the repair can never fire again — a
   * permanent no-op that changes no structure and breaks no other test, which
   * is the same shape as a guard reading the wrong component.
   */
  for (const name of FILES) {
    const sql = code(name);
    const writes = [...sql.matchAll(/INSERT INTO evestack\.schema_fingerprint[\s\S]{0,200}?VALUES \('(\w+)'/g)];
    for (const object of new Set(writes.map((match) => match[1]))) {
      const firstWrite = writes.find((match) => match[1] === object).index;
      const replaced = sql.indexOf(`CREATE OR REPLACE FUNCTION evestack.${object}`);
      if (replaced === -1) continue; // a fingerprint of something this file does not install
      assert.ok(
        firstWrite < replaced,
        `${name} records the fingerprint of evestack.${object} AFTER replacing it, so it ` +
          "fingerprints its own new body every time, never sees a difference, and never " +
          "repairs. The whole point is to observe what was in the database before this file " +
          "touched it.",
      );
    }
  }
});

test("the version each file stamps is the version its guard enforces", () => {
  for (const name of FILES) {
    const sql = read(name);
    const stamped = /INSERT INTO evestack\.schema_version[\s\S]{0,240}?VALUES \('(\w+)',\s*(target|\d+)\)/.exec(sql);
    assert.ok(stamped, `${name} stamps no version, so nothing records that it was applied`);
    // `target` is the constant itself, which cannot drift. A literal can.
    if (stamped[2] !== "target") {
      assert.equal(
        Number(stamped[2]),
        targets(sql)[0],
        `${name} stamps component '${stamped[1]}' at version ${stamped[2]} while its guard ` +
          `enforces ${targets(sql)[0]}`,
      );
    }
  }
});

test("the guard reads the component the file actually stamps", () => {
  /*
   * A GUARD THAT READS A COMPONENT NOBODY WRITES IS A NO-OP, AND LOOKS FINE.
   *
   * Measured: change the guard's `component = 'spans'` to `'spanz'` and leave
   * the migration and the stamp correct. `installed` is then NULL on every
   * database that has ever existed, `COALESCE(installed, 0) > target` is never
   * true, and the file happily applies itself over a database it does not
   * understand — the exact silent lie the guard was added to kill. Every other
   * test in this suite passed, because a one-character typo inside a string
   * literal changes no structure at all.
   *
   * Executing the raise is what settles it, and
   * contract/runtime/probes/23-schema-downgrade-guard does that against a real
   * server. This is the offline half: the three places one file names its own
   * component — the guard, the migration, the stamp — have to agree, and
   * nothing but a comparison can notice when they stop.
   */
  const reads = (sql) => [
    ...sql.matchAll(/evestack\.schema_version\s+WHERE component = '(\w+)'/g),
    ...sql.matchAll(/INSERT INTO evestack\.schema_version \(component, version\)\s*VALUES \('(\w+)'/g),
  ].map((m) => m[1]);

  for (const name of FILES) {
    const named = reads(code(name));
    assert.ok(
      named.length >= 3,
      `${name} names its schema_version component ${named.length} time(s): ${named.join(", ") || "none"}. ` +
        "Expected at least three — the downgrade guard, the migration, and the stamp. If one of " +
        "them stopped naming a component, this comparison is no longer checking that they agree.",
    );
    assert.equal(
      new Set(named).size,
      1,
      `${name} uses more than one schema_version component: ${[...new Set(named)].join(", ")}. ` +
        "A guard that reads a component the file never stamps reads NULL forever and can never " +
        "fire, which is indistinguishable from a working guard until an older image is pointed " +
        "at a newer database.",
    );
  }
});

test("bumping the target adds a migration step, or the file stamps work it never did", () => {
  /*
   * THE HOLE THIS CLOSES. Both `target constant integer` literals in
   * sql/traces.sql moved 4 -> 5 with no `IF installed < 5` block added, and all
   * eleven tests passed. The file would then stamp every database it touched at
   * version 5 having applied nothing at all — and the stamp is forward-only, so
   * no later image could ever repair it: the migration would see `installed` at
   * 5, skip every step, and the guard would wave through an image that had
   * silently never run the change its number claims.
   *
   * Two shapes count as installing the target, because the two files migrate
   * differently and both are correct:
   *
   *   IF installed < N          sql/traces.sql. Steps accumulate, each one
   *                             keyed to the version that introduced it, so the
   *                             newest step must name the current target.
   *   IS DISTINCT FROM target   sql/facts.sql. The fact tables are a cache of a
   *                             join, so any version change drops and rebuilds
   *                             all three. Written against the constant rather
   *                             than a literal, it cannot go stale — which is
   *                             why it satisfies this without a step per bump.
   */
  for (const name of FILES) {
    const sql = code(name);
    const target = targets(read(name))[0];
    const step = new RegExp(`IF\\s+installed\\s*<\\s*${target}\\b`);
    const rebuild = /installed\s+IS DISTINCT FROM\s+target/;
    assert.ok(
      step.test(sql) || rebuild.test(sql),
      `${name} declares target ${target} and contains neither an \`IF installed < ${target}\` ` +
        "step nor a migration keyed to `target` itself. Whatever the bump was for, nothing in " +
        "this file applies it — but the file still stamps the database at " + target + ", and " +
        "that stamp is forward-only. The next image reads a version this one never installed " +
        "and skips the repair, permanently.",
    );
  }
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
