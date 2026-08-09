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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ENTRY = join(dirname(fileURLToPath(import.meta.url)), "..", "index.mjs");

/**
 * Unix modes are the subject of three tests below and Windows does not have
 * them: NTFS reports 0666 for everything Node can chmod, so an assertion on 0600
 * there would fail against code that is behaving correctly.
 */
const POSIX = process.platform !== "win32";

/** A minimal but real eve project: package.json with eve, and agent/agent.ts. */
function eveProject({ git = false, envFiles = {}, skills = false, instrumentation = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "evestack-attach-writes-"));
  mkdirSync(join(dir, "agent"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({ name: "my-agent", version: "1.0.0", dependencies: { eve: "^0.30.8" } }, null, 2)}\n`,
  );
  writeFileSync(join(dir, "agent", "agent.ts"), 'export default defineAgent({ model: openai("gpt-5-mini") });\n');
  if (skills) {
    mkdirSync(join(dir, "agent", "skills", "my-own-skill"), { recursive: true });
    writeFileSync(
      join(dir, "agent", "skills", "my-own-skill", "SKILL.md"),
      "---\ndescription: a skill that exists only in this project\n---\n\nDo the thing.\n",
    );
  }
  // A project that already exports traces its own way. attach skips it, which is
  // the branch the ingest token used to fall out of entirely.
  if (instrumentation) writeFileSync(join(dir, "agent", "instrumentation.ts"), "export function register() {}\n");
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

/**
 * A .env written on Windows used to be read as if it were empty.
 *
 * `readEnvFiles` split on "\n" and matched each line against a regex ending in
 * `$`. With no `m` flag `$` anchors to end of input and `.` cannot match CR, so
 * every line of a CRLF file failed and the function returned an empty Map —
 * measured at 0 of 2 lines. `core.autocrlf=true` is enough to produce one.
 *
 * The consequence is not cosmetic. attach reads that Map to answer "does this
 * project already have a database?", and an empty Map says no, so it attaches a
 * SECOND Postgres to a project that already had one and appends a
 * WORKFLOW_POSTGRES_URL that wins over the real one — the agent then writes its
 * sessions to a new empty database while the operator's own sits untouched.
 * attach.mjs:424 says in as many words that this must not happen.
 */
test("a CRLF env file is read, so attach does not add a second database", () => {
  const dir = eveProject({
    envFiles: {
      ".env.local":
        "WORKFLOW_POSTGRES_URL=postgres://me:mypw@db.internal:5432/prod\r\n" +
        "OPENAI_API_KEY=sk-real\r\n",
    },
  });
  const result = attach(dir);
  assert.equal(result.status, 0, result.stderr);

  const env = read(dir, ".env.local");
  const urls = [...env.matchAll(/^\s*WORKFLOW_POSTGRES_URL=/gm)].length;
  assert.equal(urls, 1, `attach re-declared the database URL:\n${env}`);
  assert.match(env, /db\.internal:5432\/prod/, "the project's own database URL must survive");

  const compose = read(dir, "docker-compose.yml");
  assert.ok(
    compose === null || !/\bpostgres:\b/.test(compose),
    `attach added a second Postgres to a project that already had one:\n${compose}`,
  );
});

/* -------------------------------------------------------------------------- */
/* the mode the credentials land at                                            */
/* -------------------------------------------------------------------------- */

/**
 * git was the only reader being kept out.
 *
 * Everything above is about which FILE the secrets go in and whether git would
 * carry it. None of it looked at the mode, and the mode was whatever the umask
 * said: measured at `-rw-r--r--` on a machine with the default umask 022, for a
 * file holding a Postgres password and a trace-ingest token. On a shared box
 * that is every other account on it.
 *
 * The append path is the one that needs the chmod rather than the `mode` option:
 * writeFileSync passes `mode` to open(2) with O_CREAT, so it applies on creation
 * and is silently ignored when the file already exists — which is the normal
 * case here, because attach adds its block to a file the project may already
 * have.
 */
test("the env file attach writes is owner-only", { skip: POSIX ? false : "POSIX modes only" }, () => {
  const dir = eveProject();
  const result = attach(dir);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const mode = statSync(join(dir, ".env.local")).mode & 0o777;
  assert.equal(mode.toString(8), "600", `.env.local is mode ${mode.toString(8)}`);
});

test("appending to an existing 0644 env file tightens it", { skip: POSIX ? false : "POSIX modes only" }, () => {
  // The pre-existing file is the reason the `mode` option alone is not enough,
  // and a file attach cannot chmod is not a reason to abandon the run — so this
  // also pins that the write itself still lands.
  const dir = eveProject({ envFiles: { ".env.local": "LOG_LEVEL=debug\n" } });
  chmodSync(join(dir, ".env.local"), 0o644);
  const result = attach(dir);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);

  const env = read(dir, ".env.local");
  assert.match(env, /^LOG_LEVEL=debug$/m, "the project's own line was lost");
  assert.ok(passwordIn(env), "nothing was appended");
  const mode = statSync(join(dir, ".env.local")).mode & 0o777;
  assert.equal(mode.toString(8), "600", `an existing env file stayed at ${mode.toString(8)}`);
});

test("the compose file is left committable, not tightened", { skip: POSIX ? false : "POSIX modes only" }, () => {
  // Tightening carries a claim — "this holds a secret" — and the compose file
  // deliberately does not: the password reaches the container through env_file.
  // A 0600 file that is meant to be committed would say the opposite.
  const dir = eveProject();
  assert.equal(attach(dir).status, 0);
  writeFileSync(join(dir, "reference.txt"), "");
  const reference = statSync(join(dir, "reference.txt")).mode & 0o777;
  const compose = statSync(join(dir, "docker-compose.yml")).mode & 0o777;
  assert.equal(
    compose,
    reference,
    `docker-compose.yml is ${compose.toString(8)} and an ordinary file here is ${reference.toString(8)}`,
  );
});

/* -------------------------------------------------------------------------- */
/* the dashboard command                                                       */
/* -------------------------------------------------------------------------- */

/** The `docker run` block attach prints, as one string. */
function dashboardCommand(stdout) {
  const start = stdout.indexOf("docker run -d --name");
  assert.notEqual(start, -1, `no docker run command was printed:\n${stdout}`);
  const end = stdout.indexOf("evestack-dashboard:", start);
  return stdout.slice(start, stdout.indexOf("\n", end));
}

/**
 * 30b4de4 fixed two of the three places a dashboard gets started.
 *
 * It gave the skills mount and EVESTACK_SKILLS_DIR to the repo's own
 * docker-compose.yml and to the compose file `create` generates, and this
 * `docker run` — the only other one — got neither. Without them lib/skills.ts
 * falls back to the template skills baked into the image, which ALWAYS resolves
 * in a container, so the Skills page scanned a copy of `memory-hygiene` frozen
 * at image build time while looking like it was reading the project's own.
 *
 * That page exists because eve advertises every skill in agent/skills/ to the
 * model beside a `load_skill` tool, so a scanner pointed at the wrong directory
 * returns a clean verdict about files nobody is running.
 */
test("the printed dashboard command mounts the project's own skills", () => {
  const dir = eveProject({ skills: true });
  const result = attach(dir);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const command = dashboardCommand(result.stdout);
  assert.match(command, /-e EVESTACK_SKILLS_DIR=\/agent-skills/, command);
  assert.ok(
    command.includes(`${join(dir, "agent", "skills")}:/agent-skills:ro`),
    `the mount is missing or not read-only:\n${command}`,
  );
});

test("no agent/skills means no mount, rather than a directory docker creates", () => {
  // `docker run -v` on a host path that does not exist creates it, root-owned on
  // Linux — a directory attach would be adding to a project it promises only to
  // add to reversibly.
  const dir = eveProject();
  const result = attach(dir);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.doesNotMatch(dashboardCommand(result.stdout), /agent-skills/);
  assert.equal(existsSync(join(dir, "agent", "skills")), false);
});

/**
 * The ingest token the dashboard is started with has to be the one the agent
 * sends, and attach used to mint a fresh one in two situations where the project
 * already had a perfectly good one.
 *
 * Both end the same way. The dashboard's ingestAuthorized() takes this shared
 * secret or a session cookie, an OTLP exporter cannot hold a session, and
 * @vercel/otel reports the resulting 401 to the agent as a successful export —
 * so the only symptom is a Traces tab that stays empty for ever.
 */
test("re-running after deleting instrumentation.ts reuses the token on disk", () => {
  const dir = eveProject();
  assert.equal(attach(dir).status, 0);
  const onDisk = /EVESTACK_INGEST_TOKEN=([0-9a-f]+)/.exec(read(dir, ".env.local"))?.[1];
  assert.ok(onDisk, "the first run wrote no token");

  // Exactly what attach tells you to do to change your mind about trace export,
  // and then change it back.
  spawnSync("rm", [join(dir, "agent", "instrumentation.ts")]);
  const result = attach(dir);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);

  assert.equal(
    /EVESTACK_INGEST_TOKEN=([0-9a-f]+)/.exec(read(dir, ".env.local"))?.[1],
    onDisk,
    "the env file's token changed under a project that was not asked to rotate it",
  );
  const printed = /-e EVESTACK_INGEST_TOKEN=([0-9a-f]+)/.exec(dashboardCommand(result.stdout))?.[1];
  assert.equal(printed, onDisk, "the dashboard is started with a token the agent will never send");
  // And the summary's claim about those two values is now one the code makes true.
  assert.match(result.stdout, /That token is the same one in \.env\.local/);
});

test("a project with its own instrumentation still gets its token into the command", () => {
  // The second shape of the same disagreement: the mint lived inside the
  // `wantTraces` branch, so a project whose instrumentation attach skips left
  // plan.ingestToken null and the printed command carried no token at all —
  // while the agent's env file had one.
  const token = "deadbeef".repeat(8);
  const dir = eveProject({ instrumentation: true, envFiles: { ".env.local": `EVESTACK_INGEST_TOKEN=${token}\n` } });
  const result = attach(dir);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(dashboardCommand(result.stdout), new RegExp(`-e EVESTACK_INGEST_TOKEN=${token}`));
});

/* -------------------------------------------------------------------------- */
/* log rotation                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The third place a long-running evestack container gets started, and the third
 * that had no log ceiling.
 *
 * Docker's json-file driver rotates nothing by default. The Postgres service
 * attach writes says `restart: unless-stopped`, so the daemon appends to
 * /var/lib/docker/containers/<id>/<id>-json.log for as long as the project is
 * up; a full disk stops that Postgres, and with it every durable session the
 * agent has. The `docker run` printed beside it is the same container-for-months
 * bargain with the same default.
 *
 * Round one fixed only the repository's own docker-compose.yml — the
 * contributor's stack — and left both deployment paths untouched.
 */
test("the Postgres service attach writes has a bounded log", () => {
  const dir = eveProject();
  const result = attach(dir);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const compose = read(dir, "docker-compose.yml");
  assert.ok(compose, "no compose file was written");
  // Both halves. max-size alone rotates for ever and bounds nothing; max-file
  // alone caps a count of files that are individually unbounded.
  assert.match(compose, /^ {4}logging:\n {6}driver: json-file$/m, compose);
  assert.match(compose, /^ {8}max-size: "\$\{LOG_MAX_SIZE:-10m\}"$/m, compose);
  assert.match(compose, /^ {8}max-file: "\$\{LOG_MAX_FILE:-3\}"$/m, compose);
  // Written out rather than aliased, unlike the two-service file `create`
  // writes. This same block is PRINTED for a user to paste into a compose file
  // they already own, and an alias whose `x-logging` anchor stayed behind in the
  // terminal does not lose the ceiling, it stops the file parsing: Compose
  // v5.1.0 answers `unknown anchor 'container-logs' referenced`.
  assert.doesNotMatch(compose, /\*container-logs/, "an alias here breaks the paste-it-yourself path");
});

test("the printed dashboard command bounds its logs too, and names the driver", () => {
  const dir = eveProject();
  const result = attach(dir);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const command = dashboardCommand(result.stdout);
  assert.match(command, /--log-opt max-size=10m/, command);
  assert.match(command, /--log-opt max-file=3/, command);
  // `--log-driver json-file` is not redundant with the daemon default. Which
  // --log-opt keys are legal depends on the driver, so on a host whose daemon
  // defaults to journald or awslogs this command would be refused outright
  // rather than quietly run without a ceiling.
  assert.match(command, /--log-driver json-file/, command);
});
