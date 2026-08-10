/**
 * The preflight has to keep working after being moved, and its only output is
 * on the path nobody exercises.
 *
 * `stop()` and `preflight()` moved out of scripts/dev.mjs into scripts/checks.mjs
 * so `npm run eval` could run the same checks as `npm run dev`. checks.mjs
 * forwarded the colour table with `export { C, c, g } from "./ui.mjs"`, which
 * exports the NAME without binding it locally — so the first message either
 * function tried to print threw `ReferenceError: C is not defined` instead.
 * Every happy-path run stayed green, because the only code that touches C is the
 * code that runs when something is already wrong.
 *
 * So this drives the real script against a database that cannot answer and reads
 * what comes out. Offline and instant: nothing listens on port 1, and loopback
 * refuses rather than hanging. No Docker, no model, no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("a database that cannot answer stops the run and names the command", () => {
  const result = spawnSync(process.execPath, [join("scripts", "eval.mjs"), "smoke"], {
    cwd: projectRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      WORKFLOW_POSTGRES_URL: "postgres://nobody:nobody@127.0.0.1:1/none",
      // Emptied rather than left inherited: a shell that already had it set
      // would skip the very thing under test and the case would pass blind.
      EVESTACK_SKIP_PREFLIGHT: "",
    },
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  assert.equal(result.status, 1, output);
  assert.match(output, /Postgres is not running/, output);
  assert.match(output, /docker compose up -d postgres/, output);
  // The regression itself: a message that throws instead of printing.
  assert.doesNotMatch(output, /ReferenceError/, output);
});

test("--list answers without a database, so it can run where there is none", () => {
  const result = spawnSync(process.execPath, [join("scripts", "eval.mjs"), "--list"], {
    cwd: projectRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      WORKFLOW_POSTGRES_URL: "postgres://nobody:nobody@127.0.0.1:1/none",
      EVESTACK_SKIP_PREFLIGHT: "",
    },
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  assert.equal(result.status, 0, output);
  assert.match(output, /smoke/, output);
  assert.doesNotMatch(output, /Postgres is not running/, output);
});
