/**
 * The agent has to start when a process supervisor starts it, not only when npm does.
 *
 * `scripts/start.mjs` spawned the bare name `eve`. npm prepends
 * `node_modules/.bin` to PATH for the command it runs, so `npm run start` always
 * worked and the dependency on PATH was invisible. A systemd unit or a launchd
 * plist runs `node scripts/start.mjs` directly, with systemd's default PATH
 * (`/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`) or launchd's
 * even shorter one — neither of which contains `node_modules/.bin`.
 *
 * Measured against the real script before `eveBinary()` existed, with a stub
 * `node_modules/.bin/eve` in a scratch project:
 *
 *   PATH=<project>/node_modules/.bin:/usr/bin:/bin  ->  eve start --port 2000
 *   PATH=/usr/local/bin:/usr/bin:/bin               ->  "eve is not installed
 *                                                        in this project."
 *
 * The second is start.mjs's ENOENT branch, which tells the operator to run
 * `npm install` — a confident, wrong instruction, produced only in production and
 * only under the supervisor that docs/operations.mdx tells people to use.
 *
 * The end-to-end case is the one that matters, so this test runs the real
 * scripts/start.mjs against a stub eve under a supervisor-shaped PATH rather than
 * only unit-testing the resolver.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { eveBinary } from "../scripts/checks.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const scriptsDir = join(here, "..", "scripts");

/**
 * A throwaway copy of the project layout `eveBinary` reasons about:
 * `<root>/scripts/*.mjs` beside `<root>/node_modules/.bin/eve`.
 *
 * The three scripts are copied rather than symlinked because the resolver walks
 * up from `import.meta.url`, and a symlinked module resolves to its real path.
 */
function scratchProject({ withLocalEve }) {
  const root = mkdtempSync(join(tmpdir(), "evestack-svc-"));
  mkdirSync(join(root, "scripts"), { recursive: true });
  for (const file of ["start.mjs", "checks.mjs", "ui.mjs"]) {
    cpSync(join(scriptsDir, file), join(root, "scripts", file));
  }
  writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
  if (withLocalEve) {
    mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
    const shim = join(root, "node_modules", ".bin", "eve");
    // Echoes its argv so the assertion can prove the pinned port survived too.
    writeFileSync(shim, '#!/bin/sh\necho "STUB EVE: $*"\n');
    chmodSync(shim, 0o755);
  }
  return root;
}

/** Run the real start.mjs with a PATH shaped like a service manager's. */
function startUnderSupervisorPath(root) {
  return execFileSync(process.execPath, [join(root, "scripts", "start.mjs")], {
    cwd: root,
    encoding: "utf8",
    env: {
      // Deliberately NOT process.env: the point is the absence of
      // node_modules/.bin, and inheriting a developer shell would hide it.
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      EVESTACK_AGENT_PORT: "2000",
    },
  });
}

test("start.mjs finds the project's eve without npm's PATH", { skip: process.platform === "win32" }, () => {
  const root = scratchProject({ withLocalEve: true });
  try {
    const out = startUnderSupervisorPath(root);
    assert.match(out, /STUB EVE: start --port 2000/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a project with no eve installed still gets the install message", { skip: process.platform === "win32" }, () => {
  const root = scratchProject({ withLocalEve: false });
  try {
    assert.throws(
      () => startUnderSupervisorPath(root),
      (error) => {
        // start.mjs exits 1 on ENOENT and prints to stderr.
        assert.equal(error.status, 1);
        assert.match(String(error.stderr), /eve is not installed in this project/);
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("eveBinary returns an absolute path only when the local shim exists", () => {
  const withEve = scratchProject({ withLocalEve: true });
  const withoutEve = scratchProject({ withLocalEve: false });
  try {
    const url = (root) => new URL(`file://${join(root, "scripts", "start.mjs")}`).href;
    assert.equal(eveBinary(url(withEve), "linux"), join(withEve, "node_modules", ".bin", "eve"));
    // No local install is not an error — a globally installed eve is a valid
    // setup, and PATH is the right place to look for it.
    assert.equal(eveBinary(url(withoutEve), "linux"), "eve");
    // Windows keeps the bare name: the shim there is eve.cmd, spawned through a
    // shell, and quoting an absolute path into cmd.exe is a different problem.
    assert.equal(eveBinary(url(withEve), "win32"), "eve");
  } finally {
    rmSync(withEve, { recursive: true, force: true });
    rmSync(withoutEve, { recursive: true, force: true });
  }
});
