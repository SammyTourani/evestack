import assert from "node:assert/strict";
import { test } from "node:test";
import { describeDbFailure, isMissingSchema } from "../lib/db.ts";

/**
 * Telling "the database is not there" apart from "the schema was never created".
 *
 * These are opposite problems with opposite fixes, and for a while the
 * dashboard gave the same answer to both: "Can't reach the database — start it
 * with `docker compose up postgres`". Measured on a clean machine, the second
 * case had Postgres running, the container reporting HEALTHY, and the on-screen
 * advice telling the user to redo the step they had already done — while
 * `npm run db:bootstrap`, the one command that fixes it, appeared nowhere.
 *
 * Getting this backwards is worse than saying nothing, so both directions are
 * asserted rather than just the new one.
 */

const missing = new Error(
  'relation "workflow.workflow_runs" does not exist',
);
missing.message = '42P01: relation "workflow.workflow_runs" does not exist';

const refused = new Error("ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:5433");

test("a missing workflow table is recognised as an un-bootstrapped schema", () => {
  assert.equal(isMissingSchema(missing), true);
  const failure = describeDbFailure(missing);
  assert.match(failure.title, /schema/i);
  assert.match(failure.guidance, /db:bootstrap/);
});

test("the bootstrap guidance never tells the user to start Postgres again", () => {
  const { guidance } = describeDbFailure(missing);
  assert.ok(
    !/docker compose up/.test(guidance),
    "still suggests starting a container that is already running",
  );
  assert.match(guidance, /running/i, "should say Postgres is fine, to stop the wrong fix");
});

test("a refused connection still says to start Postgres", () => {
  assert.equal(isMissingSchema(refused), false);
  const failure = describeDbFailure(refused);
  assert.match(failure.title, /reach the database/i);
  assert.match(failure.guidance, /docker compose up/);
  assert.ok(!/db:bootstrap/.test(failure.guidance));
});

test("an undefined table outside the workflow schema is not a bootstrap problem", () => {
  // evestack.* tables are created lazily by their own ensure* helpers; telling
  // someone to bootstrap the workflow schema would be the wrong fix again.
  const other = new Error('42P01: relation "evestack.spans" does not exist');
  assert.equal(isMissingSchema(other), false);
  assert.match(describeDbFailure(other).guidance, /docker compose up/);
});

test("the detail is always carried through, whichever branch is taken", () => {
  for (const error of [missing, refused]) {
    const { detail } = describeDbFailure(error);
    assert.ok(detail.length > 0);
    assert.ok(error.message.includes(detail) || detail.includes(error.message.slice(0, 12)));
  }
});

test("a non-Error value does not throw the classifier", () => {
  assert.equal(isMissingSchema("some string"), false);
  assert.equal(isMissingSchema(null), false);
  assert.equal(isMissingSchema(undefined), false);
  assert.ok(describeDbFailure(null).title.length > 0);
});
