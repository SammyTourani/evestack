/**
 * The source-root fence, and the two ways it was invisible.
 *
 * `create` and `attach` run `git init` so eve's dev watcher cannot walk out of
 * the project and copy the first `.npmrc` above it — auth token included. Both
 * can only fence at the moment they run, so `verify` re-checks it.
 *
 * The check shipped BELOW two things it had to be above, and both were found by
 * an audit rather than by this suite, which did not exist:
 *
 *   1. `if (asJson) { ...; process.exit() }` — so in --json mode the block never
 *      executed and `fence` was absent from the payload entirely. Every
 *      machine-readable consumer, CI included, saw a verify result with no fence
 *      row and no indication one was missing.
 *   2. `const warned = results.filter(...)` — an array SNAPSHOT taken before the
 *      block ran, so a fence WARNING was printed and then left out of the count
 *      the summary reports.
 *
 * Both are position bugs, which is why the assertions below are about position
 * rather than about the fence's logic: a check that runs after the report is not
 * a check. The three states themselves are asserted too, because a test that
 * only proved the row exists would pass on a row that always says the same thing.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * A temp directory by its REAL path.
 *
 * On macOS `os.tmpdir()` answers /var/folders/... while `path.resolve()` inside
 * verify.mjs answers /private/var/folders/... — /var is a symlink. Comparing
 * the two forms fails on a check that is working perfectly, which is exactly
 * what it did here the first time.
 */
const scratch = (prefix) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));
const PROJECT = join(HERE, "..");

/**
 * Run `verify --json` in a copy of the project placed at `where`.
 *
 * The scripts are copied rather than symlinked so the walk sees the real
 * directory layout, and `.env.local` is deliberately absent: every other check
 * then fails fast, which is what keeps this test quick. The fence does not
 * depend on any of them.
 */
function fenceIn(where) {
  mkdirSync(where, { recursive: true });
  cpSync(join(PROJECT, "scripts"), join(where, "scripts"), { recursive: true });
  cpSync(join(PROJECT, "package.json"), join(where, "package.json"));
  let out = "";
  try {
    out = execFileSync(process.execPath, [join(where, "scripts", "verify.mjs"), "--json"], {
      cwd: where,
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, WORKFLOW_POSTGRES_URL: "", EVESTACK_AUTH_PASSWORD: "" },
    });
  } catch (error) {
    // Exit 1 is expected — nothing else in a bare directory can pass. The JSON
    // is still on stdout, and that is what this test is about.
    out = error.stdout ?? "";
  }
  const payload = JSON.parse(out);
  return { payload, fence: (payload.results ?? []).find((r) => r.name === "fence") };
}

test("the fence result is IN the --json payload, not printed after it", (t) => {
  const root = scratch("fence-json-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { payload, fence } = fenceIn(join(root, "proj"));

  assert.ok(
    fence,
    `no fence row in --json. results: ${JSON.stringify((payload.results ?? []).map((r) => r.name))}. ` +
      "The block runs after `if (asJson) process.exit()`, so the machine-readable surface " +
      "silently omits it — which is how it shipped.",
  );
  assert.ok(["pass", "warn", "fail"].includes(fence.state));
  assert.ok(typeof fence.detail === "string" && fence.detail.length > 0);
});

test("no marker anywhere above is a warning that names the home directory", (t) => {
  // mkdtemp lands under /var/folders on macOS and /tmp on Linux; neither has a
  // .git or a pnpm-workspace.yaml above it, so this is the unfenced case.
  const root = scratch("fence-none-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { fence } = fenceIn(join(root, "proj"));
  assert.equal(fence.state, "warn");
  assert.match(fence.detail, /home directory/i);
  assert.equal(fence.fix, "git init");
});

test("a marker above holding an .npmrc is a warning that names the directory", (t) => {
  const root = scratch("fence-leak-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const parent = join(root, "parent");
  mkdirSync(join(parent, ".git"), { recursive: true });
  writeFileSync(join(parent, ".npmrc"), "_auth=DECOY-NOT-A-REAL-TOKEN\n");

  const { fence } = fenceIn(join(parent, "proj"));
  assert.equal(fence.state, "warn", "a credential above the project is the case that costs something");
  assert.match(fence.detail, /\.npmrc/);
  assert.ok(fence.detail.includes(parent), `the warning must name the directory: ${fence.detail}`);
});

test("a marker above with nothing to copy is a pass that says where the root is", (t) => {
  const root = scratch("fence-quiet-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const parent = join(root, "parent");
  mkdirSync(join(parent, ".git"), { recursive: true });

  const { fence } = fenceIn(join(parent, "proj"));
  // Deliberately a pass: this is the shape of every pnpm workspace, and a line
  // that is yellow on every run in every workspace is a line people stop reading
  // — which would make the yellow one above invisible on the day it matters.
  assert.equal(fence.state, "pass");
  assert.ok(fence.detail.includes(parent));
});

test("the project's own marker is the answer, and it beats any ancestor", (t) => {
  const root = scratch("fence-own-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const parent = join(root, "parent");
  mkdirSync(join(parent, ".git"), { recursive: true });
  writeFileSync(join(parent, ".npmrc"), "_auth=DECOY-NOT-A-REAL-TOKEN\n");
  const proj = join(parent, "proj");
  mkdirSync(join(proj, ".git"), { recursive: true });

  const { fence } = fenceIn(proj);
  assert.equal(fence.state, "pass", "eve stops at the FIRST marker, so the project's own wins");
  assert.doesNotMatch(fence.detail, /\.npmrc/);
});

test("an npm/yarn workspace root counts as a marker, like attach walks it", (t) => {
  // The third marker, and the one this check shipped without. `attach.mjs`
  // #isWorkspaceRoot walks .git, pnpm-workspace.yaml AND a package.json with a
  // `workspaces` key; docs/troubleshooting.mdx says "three markers, not two, and
  // the third is easy to miss". Walking two made every npm and yarn workspace
  // report as unfenced.
  const root = scratch("fence-ws-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const parent = join(root, "parent");
  mkdirSync(parent, { recursive: true });
  writeFileSync(join(parent, "package.json"), JSON.stringify({ name: "ws", workspaces: ["proj"] }));

  const { fence } = fenceIn(join(parent, "proj"));
  assert.doesNotMatch(
    fence.detail,
    /home directory/i,
    "a workspace root above the project IS a marker — eve stops there, not at $HOME",
  );
  assert.ok(fence.detail.includes(parent), `the root it found must be named: ${fence.detail}`);
});
