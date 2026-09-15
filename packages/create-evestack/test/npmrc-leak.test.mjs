/**
 * The credential leak itself, asserted against eve's own resolver.
 *
 * ── WHAT CHANGED WITH EVE 0.54, AND WHY THE ASSERTIONS MOVED ────────────────
 *
 * This file was written against eve 0.30, where an unfenced project put the
 * user's `~/.npmrc` in `plan.copyFiles` and `eve dev` wrote it into
 * `.eve/dev-runtime/snapshots/` on every boot. eve 0.54 restricts `copyFiles`
 * to the app root: the same fixture now copies exactly one file, the project's
 * own `package.json`, and nothing from outside the project at all. The copy
 * half of the leak is fixed upstream.
 *
 * The other half is not. `plan.sourceRoot` is still the first marker directory
 * found walking up — $HOME for a dotfiles repo — and `plan.watchPaths` still
 * includes the credential file. So the fence still does something measurable,
 * and the assertions here moved from "is it copied" to "is it within reach",
 * which is the property the fence actually changes.
 *
 * These tests were SKIPPED for the whole of eve 0.30's life, because eve was
 * not installed in the workspace. They started running on the upgrade and
 * failed immediately — which is the system working: a canary for upstream
 * behaviour is supposed to fail when the upstream behaviour changes.
 *
 * WHY THIS FILE EXISTS AND THE OTHER TWO ARE NOT ENOUGH.
 * `test/first-run-ux.test.mjs` asserts that `create` leaves a `.git`.
 * `test/attach-writes.test.mjs` asserts that `attach` leaves one, and that it
 * is rooted at the project. Both are assertions about the FENCE. Neither is an
 * assertion about the LEAK — they would both stay green if eve changed its
 * marker list tomorrow, or if it started copying from the app root's parent
 * regardless of markers, and the `~/.npmrc` would be back in `.eve/` with a
 * full suite of passing tests over it.
 *
 * So this file asks the question the fence was built to answer, and it asks
 * eve rather than a model of eve:
 *
 *     is the user's credential in the set of files eve plans to copy?
 *
 * `createDevelopmentSourceSnapshotPlan` is imported from the installed eve and
 * run against a real directory tree, and the assertion is made on the CONTENT
 * of the files in `plan.copyFiles` — not on a filename, not on a source root,
 * not on the presence of `.git`. A decoy token is planted in an ancestor's
 * `.npmrc` and the test fails if that byte string is reachable through the plan.
 *
 * THE CONTROL CASE IS THE POINT. The first test builds the identical tree with
 * no marker in the project and asserts the decoy IS copied. Without it, every
 * other assertion here could be passing because the fixture never had a
 * credential in reach, and nothing would say so — which is the exact shape of
 * vacuity this file was written to close.
 *
 * The tree in every test is the configuration the leak was found in: a home
 * directory that is a dotfiles repository (`.git` + `.npmrc` with a registry
 * token), with the project some directories below it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(HERE, "..", "index.mjs");
const REPO = join(HERE, "..", "..", "..");

/**
 * A value that is a credential and is not anything else.
 *
 * Long and unmistakable so an assertion on it cannot be satisfied by an
 * accident of formatting, and obviously fake so a copy of this file found in a
 * snapshot directory is not itself a report-worthy event.
 */
const DECOY = "DECOYTOKENNOTAREALCREDENTIAL0000";

/**
 * eve's dev-runtime snapshot planner, from the eve this repository installs.
 *
 * Loaded by path rather than by specifier because it is deep internal
 * (`dist/src/internal/...`) and eve's `exports` map does not name it — which is
 * also the reason it is worth pinning from the outside: nothing upstream
 * promises this behaviour, so the only way to know it has not moved is to run
 * it. `templates/default` is the workspace package that depends on eve, so its
 * `node_modules` is where pnpm links it.
 *
 * If eve is not installed the tests below skip rather than pass. A skipped test
 * is visible in the runner's summary; a test that quietly asserts nothing is
 * not, and this file exists because of a class of bug that hides in exactly
 * that difference.
 */
const EVE_SNAPSHOT_MODULE = [
  join(REPO, "templates", "default", "node_modules", "eve", "dist", "src", "internal", "nitro", "dev-runtime-source-snapshot.js"),
  join(REPO, "node_modules", "eve", "dist", "src", "internal", "nitro", "dev-runtime-source-snapshot.js"),
].find((candidate) => existsSync(candidate));

const NO_EVE = EVE_SNAPSHOT_MODULE
  ? false
  : "eve is not installed — run `pnpm install` at the repository root";

const eveSnapshot = EVE_SNAPSHOT_MODULE ? await import(EVE_SNAPSHOT_MODULE) : null;

/**
 * A dotfiles repository with a real credential in it, and a project below it.
 *
 * `.git` and `.npmrc` are the two halves that made the leak: the first is what
 * eve's walk stops at, the second is in eve's WORKSPACE_METADATA_FILE_NAMES and
 * is therefore copied out of wherever the walk stopped.
 *
 * Returns the ancestor and the directory the project will be created in — not
 * the project itself, because `create` insists on making its own directory.
 */
function dotfilesHome() {
  const home = mkdtempSync(join(tmpdir(), "evestack-leak-home-"));
  spawnSync("git", ["init", "-q", "."], { cwd: home, stdio: "ignore" });
  writeFileSync(
    join(home, ".npmrc"),
    `registry=https://registry.example.invalid/\n//registry.example.invalid/:_authToken=${DECOY}\n`,
  );
  // Copied by eve as well, and the other file `attach` scans. Present so the
  // fixture matches the real shape rather than the minimum one.
  writeFileSync(join(home, "package.json"), `${JSON.stringify({ name: "dotfiles", private: true }, null, 2)}\n`);
  const work = join(home, "work");
  mkdirSync(work, { recursive: true });
  return { home, work };
}

/** A minimal eve project, for `attach` to attach to. */
function eveProject(parent, name = "my-agent") {
  const dir = join(parent, name);
  mkdirSync(join(dir, "agent"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({ name, version: "1.0.0", dependencies: { eve: "^0.30.8" } }, null, 2)}\n`,
  );
  writeFileSync(join(dir, "agent", "agent.ts"), 'export default defineAgent({ model: openai("gpt-5-mini") });\n');
  return dir;
}

/**
 * Package managers that do nothing, and a docker that is not there.
 *
 * The same shim `test/first-run-ux.test.mjs` installs, for the same reason: a
 * real `npm install` in a test that is about a filesystem walk would spend two
 * minutes proving nothing, and a real `docker` would try to start a stack.
 */
function shimPath() {
  const bin = mkdtempSync(join(tmpdir(), "evestack-leak-shim-"));
  const write = (name, body) => {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  };
  const hash = String.fromCharCode(35);
  const install = `${hash}!/bin/sh\ncase "$1" in install) mkdir -p node_modules/eve;; esac\nexit 0\n`;
  ["npm", "pnpm", "yarn", "bun"].forEach((name) => write(name, install));
  ["docker", "ollama"].forEach((name) => write(name, `${hash}!/bin/sh\nexit 1\n`));
  return `${bin}:${process.env.PATH}`;
}

function cli(args, cwd) {
  return spawnSync(process.execPath, [ENTRY, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, PATH: shimPath() },
  });
}

/**
 * What eve would copy out of the machine, and whether the credential is in it.
 *
 * `plan.copyFiles` is the list eve hands to its copier, so reading those files
 * is reading exactly what lands in `.eve/dev-runtime/snapshots/<id>/source/`.
 * The assertion is on content and not on a path: a rename of `.npmrc` upstream,
 * or a second metadata file that happens to hold the same token, would both
 * still be leaks and both would still be caught.
 */
async function leakReport(projectDir) {
  const plan = await eveSnapshot.createDevelopmentSourceSnapshotPlan({
    appRoot: projectDir,
    snapshotRoot: join(projectDir, ".eve", "dev-runtime", "leak-test"),
  });
  const carrying = plan.copyFiles.filter((file) => {
    try {
      return readFileSync(file, "utf8").includes(DECOY);
    } catch {
      return false;
    }
  });
  const outside = [...plan.watchPaths, ...plan.copyFiles].filter(
    (path) => path !== projectDir && !path.startsWith(`${projectDir}${sep}`),
  );
  return { plan, carrying, outside };
}

/* -------------------------------------------------------------------------- */
/* the control: the fixture really does put a credential within reach          */
/* -------------------------------------------------------------------------- */

test("without a marker in the project, eve reaches the home directory's credential", { skip: NO_EVE }, async () => {
  const { home, work } = dotfilesHome();
  const project = eveProject(work);
  // No `git init` here, and no attach: this is the state a project is in before
  // either command has fenced it, and the state it returns to the moment
  // somebody deletes `.git`.

  const { plan, carrying, outside } = await leakReport(project);

  assert.equal(plan.sourceRoot, home, "the fixture did not reproduce the walk-up");

  // THE CONTROL MOVED, BECAUSE EVE MOVED. On eve 0.30 this asserted
  // `carrying === [home/.npmrc]` — the credential was in `copyFiles` and landed
  // in `.eve/dev-runtime/snapshots/`. eve 0.54 restricts `copyFiles` to the app
  // root, so the same fixture now copies one file: the project's own
  // package.json. The copy half of the leak is fixed upstream.
  //
  // The control is still a control, because the reach is what the fence is
  // measured against and the reach is still there: the source root is still
  // $HOME and the credential is still WATCHED. Asserting on `outside` rather
  // than on `carrying` keeps the two fence tests below honest — they assert
  // `outside === []`, which would prove nothing if an unfenced project were
  // already clean.
  assert.ok(
    outside.includes(join(home, ".npmrc")),
    "the fixture puts no credential within eve's reach, so nothing below this line proves anything",
  );
  assert.deepEqual(
    carrying,
    [],
    "eve 0.54 is expected NOT to copy it — if this fails the upstream fix regressed, " +
      "and the alert wording in attach.mjs is wrong again",
  );
});

/* -------------------------------------------------------------------------- */
/* the fence, measured as the absence of the credential                        */
/* -------------------------------------------------------------------------- */

test("a project `create` scaffolded keeps the credential out of eve's copy plan", { skip: NO_EVE }, async () => {
  const { home, work } = dotfilesHome();
  const result = cli(["scaffolded-agent", "--yes"], work);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const project = join(work, "scaffolded-agent");

  const { plan, carrying, outside } = await leakReport(project);

  assert.deepEqual(
    carrying,
    [],
    `eve would copy the user's credential out of ${home} into this scaffold's .eve/`,
  );
  // Said separately, because the two can come apart: a source root that is
  // still $HOME while the metadata happens to be clean is one committed
  // `.npmrc` away from being the same bug again.
  assert.equal(plan.sourceRoot, project, "eve's source root is not the project");
  assert.deepEqual(outside, [], "eve still reaches outside the project");
});

test("a project `attach` fenced keeps the credential out of eve's copy plan", { skip: NO_EVE }, async () => {
  const { home, work } = dotfilesHome();
  const project = eveProject(work);
  const result = cli(["attach", project, "--yes"], project);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);

  const { plan, carrying, outside } = await leakReport(project);

  assert.deepEqual(
    carrying,
    [],
    `eve would copy the user's credential out of ${home} into this project's .eve/`,
  );
  assert.equal(plan.sourceRoot, project, "eve's source root is not the project");
  assert.deepEqual(outside, [], "eve still reaches outside the project");
});

/* -------------------------------------------------------------------------- */
/* the case that is NOT fenced, stated so nobody reads the fence into it       */
/* -------------------------------------------------------------------------- */

/**
 * A workspace root above the project is deliberately left alone — eve reaches
 * the project's workspace siblings by walking out into that root, and a marker
 * in the project would put them outside the source root. So `attach` warns
 * instead of fencing, and the credential IS copied.
 *
 * That is a decision, not an oversight, and this test pins both halves of it:
 * the warning fires, and the leak it warns about is real. If somebody later
 * makes `attach` fence a workspace root, this test goes red and the reader is
 * sent to the trade-off rather than to a mystery.
 */
test("a workspace root above the project is warned about, not fenced — and the reach is real", { skip: NO_EVE }, async () => {
  const { home, work } = dotfilesHome();
  writeFileSync(join(work, "pnpm-workspace.yaml"), "packages:\n  - my-agent\n");
  writeFileSync(
    join(work, ".npmrc"),
    `registry=https://registry.example.invalid/\n//registry.example.invalid/:_auth=${DECOY}\n`,
  );
  const project = eveProject(work);
  const result = cli(["attach", project, "--yes"], project);
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 0, output);

  assert.equal(existsSync(join(project, ".git")), false, "attach fenced a workspace it belongs to");
  assert.match(output, /Move the secret/, output);
  assert.doesNotMatch(
    output,
    /copies that file into|copies stop carrying/,
    "the alert still promises a copy eve 0.54 does not make",
  );
  assert.ok(output.includes(join(work, ".npmrc")), `the alert does not name the file:\n${output}`);
  assert.ok(!output.includes(DECOY), "attach printed the credential itself");

  const { plan, carrying, outside } = await leakReport(project);
  assert.equal(plan.sourceRoot, work, "the workspace root is not where eve snapshots from");
  // The alert names this file, so the file has to actually be within eve's
  // reach or the alert is noise. On eve 0.54 "within reach" means watched, not
  // copied — which is exactly what the alert now says, and why it stopped
  // promising a copy the reader could go and fail to find.
  assert.ok(
    outside.includes(join(work, ".npmrc")),
    "the alert names a file eve never touches — one of the two is wrong",
  );
  assert.deepEqual(carrying, [], "eve 0.54 keeps copies inside the project");
  // And the home directory above the workspace is out of reach either way,
  // because eve stops at the FIRST marker going up.
  assert.ok(!outside.includes(join(home, ".npmrc")), "eve walked past the workspace root");
});
