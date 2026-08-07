/**
 * What `attach` actually writes, and the two places it used to put a secret.
 *
 * Everything here runs the real command through the real bin, because every bug
 * below is about a FILE on disk: which file the credentials landed in, whether
 * git would carry it, and whether a second run added a second copy of a block.
 * A unit test of a helper would have agreed with the code either way.
 *
 * The two leaks:
 *
 *   1. The generated database password was written into the compose file, and the
 *      compose file is one you commit. attach also never added it to .gitignore,
 *      because it is not supposed to be ignored.
 *   2. The env file was ".env.local if it exists, else .env if that exists" — so a
 *      project with a committed `.env` of non-secret defaults and no .env.local got
 *      a generated database password and an ingest token appended to a TRACKED
 *      file, with `.env` then added to .gitignore, which for a tracked file does
 *      nothing at all. The next `git commit -a` committed the password.
 *
 * And two ways one project's database became another's: a Compose project name
 * derived from package.json alone, so two projects both called `my-agent` — the
 * create-evestack DEFAULT name — shared one volume; and a fresh clone, where the
 * env file is gone and the compose file is not, which used to generate a new
 * password into a second compose file and then fail authentication.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ENTRY = join(dirname(fileURLToPath(import.meta.url)), "..", "index.mjs");

/** A minimal but real eve project: package.json with eve, and agent/agent.ts. */
function eveProject({ git = false, envFiles = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "evestack-attach-writes-"));
  mkdirSync(join(dir, "agent"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({ name: "my-agent", version: "1.0.0", dependencies: { eve: "^0.30.8" } }, null, 2)}\n`,
  );
  writeFileSync(join(dir, "agent", "agent.ts"), 'export default defineAgent({ model: openai("gpt-5-mini") });\n');
  for (const [name, body] of Object.entries(envFiles)) writeFileSync(join(dir, name), body);
  if (git) {
    run(dir, "git", ["init", "-q", "."]);
    run(dir, "git", ["add", "-A"]);
    // -c rather than a config file, and no signing: a machine whose commits are
    // signed by an agent that is locked would otherwise fail here for a reason
    // that has nothing to do with attach.
    run(dir, "git", [
      "-c", "user.email=test@example.com", "-c", "user.name=test", "-c", "commit.gpgsign=false",
      "commit", "-qm", "initial",
    ]);
  }
  return dir;
}

function run(cwd, command, args) {
  return spawnSync(command, args, { cwd, encoding: "utf8" });
}

function attach(dir, args = ["--yes"]) {
  return spawnSync(process.execPath, [ENTRY, "attach", dir, ...args], { cwd: dir, encoding: "utf8" });
}

function read(dir, name) {
  return existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : null;
}

/** The password attach generated, read back out of wherever it wrote it. */
function passwordIn(text) {
  return /WORKFLOW_POSTGRES_URL=postgres:\/\/evestack:([^@]+)@/.exec(text ?? "")?.[1] ?? null;
}

test("the generated password goes in the env file, never in the compose file", () => {
  const dir = eveProject();
  const result = attach(dir);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);

  const env = read(dir, ".env.local");
  const password = passwordIn(env);
  assert.ok(password, `no WORKFLOW_POSTGRES_URL was written:\n${env}`);

  const compose = read(dir, "docker-compose.yml");
  assert.ok(compose, "no compose file was written");
  assert.ok(!compose.includes(password), "the generated password is in the committed compose file");
  // And the container still gets it: env_file, not interpolation, because Compose
  // interpolates from .env and never from .env.local.
  assert.match(compose, /env_file:\n\s+- \.env\.local/);
  assert.match(env, /^POSTGRES_PASSWORD=/m);
});

test("a tracked .env is never where the credentials land", () => {
  // The whole bug: a project that committed a .env of harmless defaults.
  const dir = eveProject({ git: true, envFiles: { ".env": "LOG_LEVEL=debug\n" } });
  const tracked = run(dir, "git", ["ls-files", "--error-unmatch", "--", ".env"]);
  assert.equal(tracked.status, 0, "fixture is wrong: .env is not tracked");

  const result = attach(dir);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);

  assert.equal(read(dir, ".env"), "LOG_LEVEL=debug\n", ".env was modified — it is a tracked file");
  const local = read(dir, ".env.local");
  assert.ok(passwordIn(local), "the credentials went nowhere useful");
  assert.match(local, /EVESTACK_INGEST_TOKEN=/);

  // The real test of "ignored": ask git.
  run(dir, "git", ["add", "-A"]);
  const staged = run(dir, "git", ["diff", "--cached", "--name-only"]).stdout;
  assert.ok(!staged.includes(".env.local"), `.env.local would be committed:\n${staged}`);
  const stagedCompose = run(dir, "git", ["show", ":docker-compose.yml"]).stdout;
  assert.ok(
    !stagedCompose.includes(passwordIn(local)),
    "the staged compose file carries the generated password",
  );
});

test("a tracked .env.local is refused rather than written to", () => {
  // The case with nowhere safe left: both candidates are the only files eve reads,
  // so a secret written anywhere else would never reach the agent. One command
  // fixes it, and the message says which.
  const dir = eveProject({ git: true, envFiles: { ".env.local": "LOG_LEVEL=debug\n" } });
  const result = attach(dir);
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 1, output);
  assert.match(output, /\.env\.local is tracked by git/);
  assert.match(output, /git rm --cached \.env\.local/);
  assert.equal(read(dir, ".env.local"), "LOG_LEVEL=debug\n", "the tracked file was written to anyway");
  assert.equal(read(dir, "docker-compose.yml"), null, "files were written despite the refusal");
});

test("two projects with the same package name get two databases", () => {
  // `evestack-${pkg.name}` was the Compose project name, so both of these — both
  // called my-agent, which is the default name — were one Compose project with one
  // volume, and the second `docker compose up -d postgres` recreated the first's
  // container. Both agents then read one database.
  const a = eveProject();
  const b = eveProject();
  assert.equal(attach(a).status, 0);
  assert.equal(attach(b).status, 0);

  const nameOf = (text) => /^name: (\S+)$/m.exec(text)?.[1];
  const first = nameOf(read(a, "docker-compose.yml"));
  const second = nameOf(read(b, "docker-compose.yml"));
  assert.ok(first && second, "no compose project name was written");
  assert.notEqual(first, second, "two attached projects share one Compose project");
  // The volume is named per project by Compose, so distinct project names are what
  // makes the volumes distinct: <project>_evestack-pgdata.
  assert.match(first, /-[0-9a-f]{6}$/, "the name carries no path hash, so it collides on basename");
});

test("a fresh clone is told why its password will not work", () => {
  // attach ignores its own env file in git and leaves the compose file to be
  // committed, so this is what `git clone` of an attached project looks like: no
  // env file, compose file present. That made existingUrl falsy, which used to
  // mean "generate a new password" — into a SECOND compose file, with the same
  // project name and the same volume, while the first was skipped. Postgres only
  // applies POSTGRES_PASSWORD when the volume is initialised, so the user got
  // `password authentication failed for user evestack` and nothing said why.
  const dir = eveProject();
  assert.equal(attach(dir).status, 0);
  const compose = read(dir, "docker-compose.yml");
  // the clone: keep the compose file, lose the env file
  writeFileSync(join(dir, ".env.local"), "");
  writeFileSync(join(dir, "docker-compose.yml"), compose);

  const result = attach(dir);
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 0, output);
  assert.match(output, /password authentication failed for user evestack/, output);
  assert.match(output, /down -v/, "no way out of it was offered");
  assert.equal(
    read(dir, "docker-compose.evestack.yml"),
    null,
    "a second compose file was written for the same project and volume",
  );
});

test("a second run updates the one block instead of appending another", () => {
  // BLOCK_START and BLOCK_END were written and never read. Delete a key from the
  // block and re-run — which is what someone does when they want it regenerated —
  // and the file ended up with two "# --- evestack attach ---" blocks, at which
  // point the undo line attach prints ("delete the evestack attach block") names
  // two things.
  const dir = eveProject();
  assert.equal(attach(dir).status, 0);
  const first = read(dir, ".env.local");
  const password = passwordIn(first);

  writeFileSync(
    join(dir, ".env.local"),
    first.split("\n").filter((line) => !line.startsWith("WORKFLOW_POSTGRES_URL=")).join("\n"),
  );
  const result = attach(dir);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);

  const after = read(dir, ".env.local");
  const starts = after.split("\n").filter((l) => l.startsWith("# --- evestack attach")).length;
  const ends = after.split("\n").filter((l) => l.startsWith("# --- end evestack attach")).length;
  assert.equal(starts, 1, `${starts} blocks after re-running:\n${after}`);
  assert.equal(ends, 1, `${ends} end markers after re-running:\n${after}`);
  // And the restored URL must match the password the container already has, or
  // the "fix" is a project that cannot authenticate.
  assert.equal(passwordIn(after), password, "the rewritten URL uses a password the volume never saw");
});

test("a plain double run writes nothing at all", () => {
  const dir = eveProject();
  assert.equal(attach(dir).status, 0);
  const before = read(dir, ".env.local");
  const result = attach(dir);
  assert.equal(result.status, 0);
  assert.match(`${result.stdout}`, /already has everything attach adds/);
  assert.equal(read(dir, ".env.local"), before);
});

test("--dry-run writes nothing, and --help detects nothing", () => {
  // `attach --help` used to run real detection, print a plan and ask "Write these
  // changes? (Y/n)" with the default at yes: one Enter and --help had written
  // files. It now answers before it looks at anything, so it works in a directory
  // that is not a project at all.
  const dir = eveProject();
  const dry = attach(dir, ["--dry-run"]);
  assert.equal(dry.status, 0, `${dry.stdout}${dry.stderr}`);
  assert.match(dry.stdout, /--dry-run: nothing was written/);
  assert.equal(read(dir, ".env.local"), null);
  assert.equal(read(dir, "docker-compose.yml"), null);

  const empty = mkdtempSync(join(tmpdir(), "evestack-not-a-project-"));
  const help = spawnSync(process.execPath, [ENTRY, "attach", "--help"], { cwd: empty, encoding: "utf8" });
  assert.equal(help.status, 0, `${help.stdout}${help.stderr}`);
  assert.match(help.stdout, /evestack attach —/);
  assert.doesNotMatch(help.stdout, /Write these changes/);
});
