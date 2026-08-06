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

import { findProject } from "../src/project.mjs";
import { projectCommand, scaffoldCommand, USAGE } from "../src/cli.mjs";

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

test("the command list names verify and open, so they are discoverable at all", () => {
  // The only reason these exist is that a stuck user can find them. A command
  // missing from --help may as well not be implemented.
  assert.match(USAGE, /evestack verify/);
  assert.match(USAGE, /evestack open/);
});
