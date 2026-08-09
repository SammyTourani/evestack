/**
 * The mode the generated credential files land at.
 *
 * Both wizards go to real trouble over WHERE a secret goes — a whole test file
 * next to this one is about which file git would carry — and neither looked at
 * who else on the machine can read it. Measured before this was fixed, by
 * scaffolding into a temp directory with the default umask 022 and stat-ing the
 * result:
 *
 *     -rw-r--r--  .env        EVESTACK_DB_PASSWORD
 *     -rw-r--r--  .env.local  EVESTACK_AUTH_PASSWORD, EVESTACK_INGEST_TOKEN,
 *                             WORKFLOW_POSTGRES_URL (password inline), API key
 *
 * EVESTACK_AUTH_PASSWORD is the dashboard sign-in, and the dashboard starts
 * agent runs and approves gated shell commands — which is why its port is pinned
 * to 127.0.0.1 three lines away in the same generated file. A world-readable
 * password file undoes that on any box with a second account on it.
 *
 * The negative half matters too and is asserted below: docker-compose.yml and
 * .env.example are meant to be committed and carry no secret, and a 0600 file
 * that is meant to be committed makes a claim about its contents that is false.
 *
 * The scaffold below is a real one, through the real bin. The package manager is
 * a shim on PATH so no install runs — that is the slow, networked part, and it
 * happens strictly after both files are written, so nothing under test depends
 * on it.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { SECRET_FILE_MODE, writeSecretFile } from "../shared.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(HERE, "..", "index.mjs");

/**
 * NTFS has no Unix mode bits — Node reports 0666 for anything it can chmod — so
 * an assertion on 0600 there would fail against code doing the right thing. The
 * shims below are `#!/bin/sh` scripts for the same reason.
 */
const POSIX = process.platform !== "win32";

const modeOf = (path) => (statSync(path).mode & 0o777).toString(8);

/**
 * A PATH where every package manager and every external probe is a stub.
 *
 * `npm install` is shimmed because it is the one slow, networked step in a
 * scaffold and this file is about two writes that happen before it. It still has
 * to LOOK successful: create.mjs checks for node_modules/eve and exits 1 with
 * "Created, but dependencies are not installed" otherwise, which would make an
 * exit-code assertion here about the shim rather than about the scaffolder.
 *
 * All four managers are stubbed because detectPm() reads npm_config_user_agent,
 * so which one gets called depends on what invoked the test run.
 */
function shimPath() {
  const bin = mkdtempSync(join(tmpdir(), "evestack-shim-"));
  for (const name of ["npm", "pnpm", "yarn", "bun"]) {
    writeFileSync(join(bin, name), '#!/bin/sh\nif [ "$1" = "install" ]; then mkdir -p node_modules/eve; fi\nexit 0\n');
    chmodSync(join(bin, name), 0o755);
  }
  // Neither is consulted for anything this file asserts, and both are slow or
  // absent depending on the machine. `docker info` decides only whether the
  // scaffolder offers to start the stack, and it does not offer under --yes.
  for (const name of ["docker", "ollama"]) {
    writeFileSync(join(bin, name), "#!/bin/sh\nexit 1\n");
    chmodSync(join(bin, name), 0o755);
  }
  return `${bin}:${process.env.PATH}`;
}

function scaffold() {
  const parent = mkdtempSync(join(tmpdir(), "evestack-credentials-"));
  const result = spawnSync(process.execPath, [ENTRY, "proj", "--yes"], {
    cwd: parent,
    encoding: "utf8",
    env: { ...process.env, PATH: shimPath() },
  });
  return { dir: join(parent, "proj"), result };
}

test("the scaffolded credential files are owner-only", { skip: POSIX ? false : "POSIX modes only" }, () => {
  const { dir, result } = scaffold();
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);

  // Named rather than globbed, and asserted to actually hold the secret, so a
  // future rename cannot turn this into a test of nothing.
  const local = readFileSync(join(dir, ".env.local"), "utf8");
  assert.match(local, /^EVESTACK_AUTH_PASSWORD=.+$/m);
  assert.match(local, /^EVESTACK_INGEST_TOKEN=[0-9a-f]{64}$/m);
  assert.equal(modeOf(join(dir, ".env.local")), "600");

  const env = readFileSync(join(dir, ".env"), "utf8");
  assert.match(env, /^EVESTACK_DB_PASSWORD=.+$/m);
  assert.equal(modeOf(join(dir, ".env")), "600");
});

test("nothing committable is tightened along with them", { skip: POSIX ? false : "POSIX modes only" }, () => {
  const { dir, result } = scaffold();
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);

  // Compared against a file written right here rather than against a hardcoded
  // 644, because the answer depends on the umask of whoever is running the suite.
  writeFileSync(join(dir, "reference.txt"), "");
  const reference = modeOf(join(dir, "reference.txt"));
  for (const name of ["docker-compose.yml", ".env.example"]) {
    assert.equal(
      modeOf(join(dir, name)),
      reference,
      `${name} carries no secret and is meant to be committed, but is not at the umask default`,
    );
  }
});

/**
 * The half that is easy to get wrong, pinned on its own.
 *
 * `mode` on writeFileSync reaches open(2) alongside O_CREAT, so it applies when
 * the file is created and is silently ignored when it already exists. `attach`
 * appends its block to an env file the project may already have, so without the
 * chmod the fix would cover a first run and miss every one after it.
 */
test("writeSecretFile tightens a file that already exists", { skip: POSIX ? false : "POSIX modes only" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "evestack-secret-file-"));
  const path = join(dir, ".env.local");

  assert.equal(writeSecretFile(path, "FIRST=1\n"), null);
  assert.equal(modeOf(path), "600");

  chmodSync(path, 0o644);
  assert.equal(writeSecretFile(path, "SECOND=2\n"), null, "a re-run reported a problem it does not have");
  assert.equal(readFileSync(path, "utf8"), "SECOND=2\n");
  assert.equal(modeOf(path), "600", "the mode option alone does not reach an existing file");
  assert.equal(SECRET_FILE_MODE, 0o600);
});

/**
 * Only the chmod is best-effort. The write itself is not.
 *
 * writeSecretFile swallows a failing chmod and returns a message, because it can
 * fail for reasons that have nothing to do with this package — a file owned by
 * someone else, a mount with no Unix modes, a bind mount in a container — and by
 * then the contents are already on disk correctly. Abandoning a scaffold half
 * way through over a mode bit would be the worse outcome.
 *
 * What must NOT be swallowed is a write that did not happen, so that is what is
 * pinned here. The chmod-failure branch itself is not exercised: provoking it
 * needs an ownership or a filesystem this suite cannot arrange portably (root
 * ignores mode bits, and CI frequently runs as root), and a fixture that passes
 * for the wrong reason is worse than an honest gap.
 */
test("a failed write still throws — only the chmod is forgiving", () => {
  const dir = mkdtempSync(join(tmpdir(), "evestack-secret-file-"));
  mkdirSync(join(dir, "collision"));
  assert.throws(() => writeSecretFile(join(dir, "collision"), "X=1\n"), /EISDIR/);
});
