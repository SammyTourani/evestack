/**
 * `evestack verify` and `evestack open` — routing and project discovery.
 *
 * These are the two commands a stuck person types, so the failure that matters
 * is not a wrong check result: it is being told "this is not an evestack
 * project" while standing inside one, or having a flag swallowed by doctor's
 * parser. Both are testable without Docker, Postgres or a browser.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findProject, findProjectEnv, open, OPEN_USAGE, VERIFY_USAGE } from "../src/project.mjs";
import { nodeVersionProblem, projectCommand, scaffoldCommand, USAGE } from "../src/cli.mjs";

function project() {
  const root = mkdtempSync(join(tmpdir(), "evestack-proj-"));
  writeFileSync(join(root, ".env.local"), "EVESTACK_AUTH_USER=evestack\n");
  return root;
}

test("verify and open are routed before doctor's parser sees their flags", () => {
  // The bug this prevents: parseArgs is doctor's, and it rejects unknown flags.
  // `evestack verify --json` would exit 2 on "Unknown option" without routing.
  assert.equal(projectCommand(["verify"]), "verify");
  assert.equal(projectCommand(["verify", "--json"]), "verify");
  assert.equal(projectCommand(["open", "--no-open"]), "open");
  assert.equal(projectCommand(["doctor"]), null);
  assert.equal(projectCommand([]), null);
  // and they are not confused with the scaffolder's commands
  assert.equal(scaffoldCommand(["verify"]), null);
  assert.equal(projectCommand(["create"]), null);
});

test("the project root is found from a subdirectory, not just from the root", () => {
  // `npm run` is typed at a root; `evestack` is on PATH and gets typed from
  // wherever the person is — very often agent/ or agent/tools/.
  const root = project();
  const deep = join(root, "agent", "tools");
  mkdirSync(deep, { recursive: true });
  assert.equal(findProject(deep), root);
  assert.equal(findProject(root), root);
});

test("somewhere that is not a project resolves to null rather than the nearest guess", () => {
  const empty = mkdtempSync(join(tmpdir(), "evestack-empty-"));
  assert.equal(findProject(empty), null);
});

test("a package.json alone is not an evestack project", () => {
  // Walking up looking for package.json would match any npm project on the way
  // to the filesystem root and then check the wrong directory.
  const plain = mkdtempSync(join(tmpdir(), "evestack-plain-"));
  writeFileSync(join(plain, "package.json"), "{}\n");
  assert.equal(findProject(plain), null);
});

test("a project attached through .env is found, not turned away", () => {
  // The comment on findProject said "every scaffolded and every attached project
  // has one" about .env.local. Not true: `attach` writes to `.env` when the
  // project already has one — so verify and open told the user "this is not an
  // evestack project" and advised `npx evestack create my-agent`, i.e. to throw
  // away what they had just attached.
  const root = mkdtempSync(join(tmpdir(), "evestack-attached-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { eve: "^0.30.8" } }));
  writeFileSync(join(root, ".env"), "WORKFLOW_POSTGRES_URL=postgres://evestack:x@127.0.0.1:5433/evestack\n");
  assert.equal(findProject(root), root);
  assert.deepEqual(findProjectEnv(root).envFiles, [".env"]);

  const deep = join(root, "agent");
  mkdirSync(deep, { recursive: true });
  assert.equal(findProject(deep), root, "walking up must work for .env too");
});

test("a bare .env in an unrelated npm project is still not a project", () => {
  // Half the npm projects on a machine have a .env, so the pair — .env beside a
  // package.json that depends on eve — is the marker, which is the same pair
  // `attach` requires before it will touch a directory.
  const plain = mkdtempSync(join(tmpdir(), "evestack-bare-env-"));
  writeFileSync(join(plain, "package.json"), JSON.stringify({ dependencies: { next: "^15" } }));
  writeFileSync(join(plain, ".env"), "DATABASE_URL=postgres://localhost/whatever\n");
  assert.equal(findProject(plain), null);
});

test("both env files are reported in eve's order, so .env.local still wins", () => {
  const root = mkdtempSync(join(tmpdir(), "evestack-both-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { eve: "^0.30.8" } }));
  writeFileSync(join(root, ".env"), "EVESTACK_AUTH_PASSWORD=old\n");
  writeFileSync(join(root, ".env.local"), "EVESTACK_AUTH_PASSWORD=new\n");
  assert.deepEqual(findProjectEnv(root).envFiles, [".env", ".env.local"]);
});

test("verify and open have help of their own to print", () => {
  // Both used to ignore --help and act: verify ran a full Postgres/Docker/network
  // verification, and open probed the dashboard and LAUNCHED A BROWSER.
  assert.match(VERIFY_USAGE, /evestack verify/);
  assert.match(VERIFY_USAGE, /--json/);
  assert.match(OPEN_USAGE, /evestack open/);
  assert.match(OPEN_USAGE, /--no-open/);
});

test("an old Node is refused with a sentence", () => {
  assert.ok(nodeVersionProblem("20.11.0"));
  assert.match(nodeVersionProblem("22.14.0"), /Node 24 or newer/);
  assert.equal(nodeVersionProblem("24.0.0"), null);
  assert.equal(nodeVersionProblem(process.versions.node), null);
});

test("the unknown-command hint names every command the binary ships", () => {
  // It said "create, attach or doctor" while five commands existed, so the two a
  // stuck user most wants were missing from the message they see after a typo.
  for (const command of ["create", "verify", "dashboard", "attach", "doctor"]) {
    assert.match(USAGE, new RegExp(`evestack ${command}`));
  }
});

test("the command list names verify and dashboard, so they are discoverable at all", () => {
  // The only reason these exist is that a stuck user can find them. A command
  // missing from --help may as well not be implemented.
  assert.match(USAGE, /evestack verify/);
  assert.match(USAGE, /evestack dashboard/);
});

/**
 * `open` was this command's first name, and renaming it must not strand anyone.
 *
 * The name is in the scaffolder's finish screen, in both READMEs, in docs, and
 * in shell history. `dashboard` is what gets printed from here on because it is
 * the word someone guesses when they want the dashboard — but the old spelling
 * has to keep resolving, and a test is the only thing that stops a later tidy-up
 * from deleting an alias that looks redundant in the source.
 */
test("`evestack open` still routes, and to the very same function", async () => {
  assert.equal(projectCommand(["open"]), "open", "the old name must still be routed");
  assert.equal(projectCommand(["dashboard"]), "dashboard");

  const module = await import("../src/project.mjs");
  assert.equal(typeof module.dashboard, "function");
  assert.equal(module.open, module.dashboard, "the alias must not drift into a second copy");
});

/**
 * `open` prints one block, and all of it has to reach the stream it was handed.
 *
 * THE DEFECT THIS PINS: every write in `open()` went to the `stdout` parameter
 * except one — `heading("dashboard", …)`, which is create-evestack/ui's PRINTING
 * form and writes to the real `process.stdout` (ui.mjs:256, 279-281). So a
 * caller supplying a stream got the URL, the credentials and the verdict with
 * the header missing, and the header appeared somewhere else entirely. One line
 * out of six is exactly the kind of split that survives review: the output looks
 * complete on a terminal, where the two streams are the same object.
 *
 * Driven against a dead port so the dashboard probe fails fast and `open`
 * returns 1 on the branch that never launches a browser — no Docker, no network
 * and nothing opens a window on the machine running the suite.
 */
test("open's whole report reaches the stream it was handed, header included", async () => {
  const root = mkdtempSync(join(tmpdir(), "evestack-open-"));
  // Port 1 on loopback refuses immediately, so `healthy` is false without a wait.
  writeFileSync(
    join(root, ".env.local"),
    "EVESTACK_DASHBOARD_URL=http://127.0.0.1:1\nEVESTACK_AUTH_USER=evestack\nEVESTACK_AUTH_PASSWORD=s3cret\n",
  );
  const chunks = [];
  const stdout = { write: (s) => chunks.push(s) };
  const cwd = process.cwd();
  try {
    process.chdir(root);
    const code = await open(["--no-open"], { stdout, stderr: { write: () => {} } });
    assert.equal(code, 1, "a dashboard that is not answering is exit 1");
  } finally {
    process.chdir(cwd);
  }
  const text = chunks.join("");

  // Anchored to the start of a line and to the heading's mark glyph: a bare
  // /dashboard/ also matches the `docker compose --profile dashboard` fix line
  // below, so it passed against the very code this test exists to fail.
  assert.match(text, /^ {2}\S+ dashboard/m, "the header went past the stream it was handed");
  assert.match(text, /not running yet/, "and so did the subtitle that says why");
  // The rest of the block, so this cannot pass on a header alone.
  assert.match(text, /127\.0\.0\.1:1|localhost:1/, "the URL is the point of the command");
  // The sign-in LINE, not the secret. The stream this test hands in is a sink,
  // not a terminal, and the password is deliberately withheld from a pipe now —
  // see showSecrets(). What this test is for is plumbing: every line of the
  // report must reach the stream the caller supplied rather than the real
  // process.stdout, and the sign-in row is one of those lines either way.
  assert.match(text, /sign in {2}evestack/, "the sign-in row went past the stream it was handed");
  assert.doesNotMatch(text, /s3cret/, "a pipe must not receive the password");
  // Header first: two interleaved write sequences could not promise even that.
  assert.ok(
    text.indexOf("dashboard") < text.indexOf("sign in"),
    `the report arrived out of order:\n${text}`,
  );
});

/**
 * The credential still reaches someone who asked for it.
 *
 * Withholding it from a pipe is only correct if there is a way back: an
 * automated setup that genuinely needs the value on stdout sets
 * EVESTACK_PRINT_SECRETS, and this is the test that stops that escape hatch
 * being quietly dropped as dead code, since nothing in the default path
 * exercises it.
 */
test("EVESTACK_PRINT_SECRETS puts the password back into a pipe", async () => {
  const root = mkdtempSync(join(tmpdir(), "evestack-open-"));
  writeFileSync(
    join(root, ".env.local"),
    "EVESTACK_DASHBOARD_URL=http://127.0.0.1:1\nEVESTACK_AUTH_USER=evestack\nEVESTACK_AUTH_PASSWORD=s3cret\n",
  );
  const chunks = [];
  const stdout = { write: (s) => chunks.push(s) };
  const cwd = process.cwd();
  const before = process.env.EVESTACK_PRINT_SECRETS;
  try {
    process.chdir(root);
    process.env.EVESTACK_PRINT_SECRETS = "1";
    await open(["--no-open"], { stdout, stderr: { write: () => {} } });
  } finally {
    process.chdir(cwd);
    if (before === undefined) delete process.env.EVESTACK_PRINT_SECRETS;
    else process.env.EVESTACK_PRINT_SECRETS = before;
  }
  assert.match(chunks.join(""), /s3cret/, "the documented escape hatch does nothing");
});
