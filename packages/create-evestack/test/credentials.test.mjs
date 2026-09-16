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
import { shimPath } from "./helpers/scaffold-shims.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { signInLine } from "../create.mjs";
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

/* -------------------------------------------------------------------------- */
/* the other place a credential lands: stdout                                  */
/* -------------------------------------------------------------------------- */

/**
 * The file this whole suite is about is 0600, and then the same value was
 * printed to stdout with nothing asking who was reading.
 *
 * On a terminal that is right and it is the point: the wizard generated the
 * password, nobody chose it, and the alternative is sending a first-time reader
 * to guess which key in a dotfile is the sign-in. Every OTHER destination is a
 * recording. `npx create-evestack my-agent | tee setup.log`, a CI job archiving
 * output, a wrapper capturing stdout, a screen-share — each turns one line of a
 * finish screen into a credential at rest, for a dashboard that starts agent
 * runs and approves gated shell commands. A 0600 file and a world-readable log
 * of its contents are the same secret with different permissions.
 *
 * `verify --json` had always omitted it, so the intent existed; the human path
 * just had no gate. The gate is `process.stdout.isTTY`, which is the same
 * question the scaffolder already asks before it offers to open a browser.
 */
test("the generated password is not printed when stdout is not a terminal", () => {
  const { dir, result } = scaffold();
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);

  // The real value, read out of the file it is supposed to stay in. Matching on
  // the actual password rather than on a shape means this cannot pass because
  // the wording of the line changed.
  const password = /^EVESTACK_AUTH_PASSWORD=(.+)$/m.exec(readFileSync(join(dir, ".env.local"), "utf8"))?.[1];
  assert.ok(password && password.length > 12, "fixture is wrong: no generated password to look for");

  // spawnSync pipes stdout, so the child sees no TTY — which is exactly the
  // captured-output case this is about, arrived at by construction rather than
  // by faking a flag.
  assert.equal(
    result.stdout.includes(password),
    false,
    `the finish screen printed the dashboard password into a pipe:\n${result.stdout}`,
  );
  // Withheld, not hidden: the reader is told where it is.
  assert.match(result.stdout, /EVESTACK_AUTH_PASSWORD/);
  assert.match(result.stdout, /\.env\.local/);
});

test("on a terminal the password is printed, because that is the whole point", () => {
  // The positive half. A gate that withheld it everywhere would "pass" the test
  // above and break the product: the scaffolder is the only thing that ever
  // knows this value at the moment it is generated.
  assert.match(signInLine("s3cr3t-not-a-real-one", { show: true }), /s3cr3t-not-a-real-one/);
  const piped = signInLine("s3cr3t-not-a-real-one", { show: false });
  assert.doesNotMatch(piped, /s3cr3t-not-a-real-one/);
  assert.match(piped, /EVESTACK_AUTH_PASSWORD in \.env\.local/);
  // The user name is not a secret and stays on both, so the line still says who
  // to sign in as.
  assert.match(piped, /evestack/);
});

/**
 * The way back, for the one legitimate case.
 *
 * An automated setup that genuinely wants the generated password out of stdout
 * — and has somewhere to put it — says so once, on purpose. That is the whole
 * difference between this and a value that lands in a log because nobody chose
 * anything.
 */
test("EVESTACK_PRINT_SECRETS puts the old behaviour back", () => {
  const parent = mkdtempSync(join(tmpdir(), "evestack-credentials-"));
  const result = spawnSync(process.execPath, [ENTRY, "proj", "--yes"], {
    cwd: parent,
    encoding: "utf8",
    env: { ...process.env, PATH: shimPath(), EVESTACK_PRINT_SECRETS: "1" },
  });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);

  const password = /^EVESTACK_AUTH_PASSWORD=(.+)$/m.exec(
    readFileSync(join(parent, "proj", ".env.local"), "utf8"),
  )?.[1];
  assert.ok(password, "fixture is wrong: no generated password to look for");
  assert.ok(
    result.stdout.includes(password),
    `the override did not restore the printed password:\n${result.stdout}`,
  );
});
