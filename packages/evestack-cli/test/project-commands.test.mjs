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

import { findProject, findProjectEnv, OPEN_USAGE, VERIFY_USAGE } from "../src/project.mjs";
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
  for (const command of ["create", "verify", "open", "attach", "doctor"]) {
    assert.match(USAGE, new RegExp(`evestack ${command}`));
  }
});

test("the command list names verify and open, so they are discoverable at all", () => {
  // The only reason these exist is that a stuck user can find them. A command
  // missing from --help may as well not be implemented.
  assert.match(USAGE, /evestack verify/);
  assert.match(USAGE, /evestack open/);
});
