import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { composeEnvFile, composeFile, DB_PASSWORD_VAR, projectNameFor } from "../create.mjs";

/**
 * The compose file a stranger actually gets, and the secret it must not contain.
 *
 * This exists because the scaffolder shipped `POSTGRES_PASSWORD: evestack` and
 * published `"5433:5432"` — no interface prefix, so 0.0.0.0 — for long enough
 * that another machine on the same network connected to it and authenticated.
 * That database holds every prompt, tool result and memory the agent has
 * produced. The dashboard in the same generated file was already pinned to
 * 127.0.0.1 with a comment about control planes, so one file disagreed with
 * itself, and the half that was wrong was the more valuable target.
 *
 * Generating the password fixed half of it. The other half took longer to see:
 * the generated value was written INTO docker-compose.yml, and that file is meant
 * to be COMMITTED — the .gitignore the scaffold writes covers .env and .env.*,
 * deliberately not the compose file. So the credential that exists because "a
 * shipped default password would be the one thing standing between a stranger and
 * someone's agent" was committed by the first `git add -A`, while the same
 * password in .env.local was carefully ignored. CI only ever asserted that
 * .env.local was unstaged.
 *
 * The fix is Compose's own interpolation: `${...}`, resolved on the host from
 * `.env`, which IS ignored. Verified against Compose v5.1.3 rather than assumed —
 * `docker compose config` resolves it, Postgres initialises with it, and a wrong
 * password over TCP from another container is refused with `password
 * authentication failed for user "evestack"`. The same reference with the value
 * in .env.local instead fails the parse outright, because interpolation does not
 * read .env.local. That distinction is the whole fix, so it is asserted below.
 */

const PASSWORD = "GENERATED-pw_abc123";
const compose = () => composeFile("my-agent");

/** Every `ports:` entry, with comments stripped. */
function publishedPorts(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^- "\S+:\d+"$/.test(line))
    .map((line) => line.slice(3, -1));
}

/**
 * Split a port mapping into its colon-separated fields.
 *
 * `${DASHBOARD_PORT:-4000}` contains a colon of its own, so a plain
 * `.split(":")` reads `127.0.0.1:${DASHBOARD_PORT:-4000}:4000` as four fields
 * and reports a correctly-pinned port as unpinned. The first version of this
 * file did exactly that and failed against a compose file that was right.
 * Interpolations are replaced with a placeholder before splitting.
 */
function fields(mapping) {
  return mapping.replace(/\$\{[^}]*\}/g, "VAR").split(":");
}

test("no published port binds every interface", () => {
  const ports = publishedPorts(compose());
  assert.ok(ports.length > 0, "the fixture found no ports at all — the matcher is stale");
  for (const mapping of ports) {
    const parts = fields(mapping);
    assert.equal(
      parts.length,
      3,
      `${mapping} has no interface prefix, so Docker binds 0.0.0.0`,
    );
    assert.ok(
      parts[0] === "127.0.0.1" || parts[0] === "VAR",
      `${mapping} is published on ${parts[0]}, not loopback`,
    );
  }
});

test("Postgres is published on loopback specifically", () => {
  const ports = publishedPorts(compose());
  const pg = ports.find((p) => p.endsWith(":5432"));
  assert.ok(pg, "no Postgres port mapping found");
  assert.ok(pg.startsWith("127.0.0.1:"), `Postgres published as ${pg}`);
});

/* -------------------------------------------------------------------------- */
/* the secret, and the file it is not in                                       */
/* -------------------------------------------------------------------------- */

test("the compose file contains no password — only a reference to one", () => {
  const text = compose();
  assert.ok(
    !text.includes("POSTGRES_PASSWORD: evestack"),
    "a default database password is shipped in the compose file",
  );
  // The only acceptable right-hand side is an interpolation of the variable the
  // generated .env writes.
  const line = text.split("\n").find((l) => l.trim().startsWith("POSTGRES_PASSWORD:"));
  assert.ok(line, "no POSTGRES_PASSWORD line at all — Postgres will refuse to initialise");
  assert.match(line, new RegExp(`\\$\\{${DB_PASSWORD_VAR}:\\?`), line);
});

test("a generated password never reaches the compose file, in either place", () => {
  // Both places it used to appear: the Postgres service and the dashboard's
  // connection string. The generator is not called here — a compose file that
  // cannot be given a password cannot leak one.
  const text = composeFile("my-agent", { pgPort: 5433, dashboardPort: 4000 });
  assert.ok(!text.includes(PASSWORD), "a literal password survives in the compose file");
  assert.ok(
    !/POSTGRES_PASSWORD:\s*"?[A-Za-z0-9_-]{16,}"?\s*$/m.test(text),
    "something that looks like a literal secret is on the POSTGRES_PASSWORD line",
  );
  // And the old signature cannot bring it back: `composeFile(name, password)` was
  // how the secret got in, so a caller still passing one positionally gets a file
  // without it rather than a file with it in the wrong place.
  assert.ok(!composeFile("my-agent", PASSWORD).includes(PASSWORD));
});

test("the generated .env carries the password, and names the variable compose reads", () => {
  const env = composeEnvFile(PASSWORD);
  assert.ok(env.includes(`${DB_PASSWORD_VAR}=${PASSWORD}`), env);
  // Unquoted on purpose: Compose reads .env values literally, and base64url
  // contains no character that needs escaping.
  assert.ok(!env.includes(`${DB_PASSWORD_VAR}="`), "a quoted value would become part of the password");
});

test("the compose file and the .env agree on the variable name", () => {
  // A compose file interpolating a variable nothing writes fails at parse time
  // with `required variable ... is missing a value`; a .env writing a variable
  // nothing reads is a password sitting in a file for no reason. Only this pair
  // being equal makes the stack start at all.
  const referenced = [...compose().matchAll(/\$\{([A-Z_]+):\?/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(referenced)], [DB_PASSWORD_VAR]);
  assert.match(composeEnvFile(PASSWORD), new RegExp(`^${DB_PASSWORD_VAR}=`, "m"));
});

test("a missing password stops compose rather than starting an open database", () => {
  // `:?` and not `:-`. With a default, an absent .env would silently produce an
  // empty POSTGRES_PASSWORD; with `:?` Compose refuses to parse the file and
  // prints the text after the question mark. Verified against Compose v5.1.3.
  // Only lines that actually reference the variable — the header explains it in
  // prose, and prose is not an interpolation.
  const references = compose().split("\n").filter((line) => line.includes(`\${${DB_PASSWORD_VAR}`));
  assert.ok(references.length >= 2, "expected the Postgres service and the dashboard URL");
  for (const line of references) {
    assert.match(line, new RegExp(`\\$\\{${DB_PASSWORD_VAR}:\\?[^}]+\\}`), line);
  }
});

test("no connection string carries the old default credentials", () => {
  const text = compose();
  assert.ok(
    !text.includes("evestack:evestack"),
    "postgres://evestack:evestack survives somewhere in the compose file",
  );
  // Both halves must reach the same database, or the dashboard reads nothing —
  // and the dashboard's half is reached over the compose network, not loopback.
  assert.ok(
    text.includes(`postgres://evestack:\${${DB_PASSWORD_VAR}`),
    "the dashboard's connection string does not interpolate the database password",
  );
  assert.match(text, /@postgres:5432\/evestack/);
});

test("the file the password goes in is ignored, and the compose file is not", () => {
  // The asymmetry that made this a leak, asserted from the shipped .gitignore
  // rather than assumed: .env and .env.local are ignored, docker-compose.yml is
  // deliberately not, and CI only ever checked that .env.local was unstaged. If
  // the template's .gitignore stops covering .env, the password in it becomes
  // committable and this fails.
  const ignore = readFileSync(new URL("../template/gitignore", import.meta.url), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  assert.ok(ignore.includes(".env"), `.env is not ignored by the template .gitignore:\n${ignore.join("\n")}`);
  assert.ok(
    ignore.includes(".env.local") || ignore.includes(".env.*"),
    ".env.local is not ignored by the template .gitignore",
  );
  assert.ok(
    !ignore.some((line) => line.includes("docker-compose")),
    "the compose file is ignored — it is meant to be committed, which is why it holds no secret",
  );
});

test("the dashboard still reads the agent's own env file", () => {
  // The mechanism the compose file uses for the OTHER secrets, and the one this
  // test exists to keep distinct from interpolation: env_file sets variables
  // inside the container, and it is how one .env.local feeds both halves of the
  // ingest token.
  assert.match(compose(), /env_file:\n\s+- \.env\.local/);
});

/* -------------------------------------------------------------------------- */
/* ports                                                                       */
/* -------------------------------------------------------------------------- */

test("the compose file publishes the ports it was given, not the defaults", () => {
  const text = composeFile("my-agent", { pgPort: 5455, dashboardPort: 4044 });
  assert.match(text, /- "127\.0\.0\.1:5455:5432"/);
  assert.match(text, /- "127\.0\.0\.1:\$\{DASHBOARD_PORT:-4044\}:4000"/);
  // and the header a human reads names the same port it published
  assert.match(text, /the dashboard on :4044/);
  // the old hardcoded values must not survive anywhere in the file
  assert.doesNotMatch(text, /127\.0\.0\.1:5433:5432/);
  assert.doesNotMatch(text, /DASHBOARD_PORT:-4000/);
});

test("omitting the ports keeps the documented defaults", () => {
  const text = composeFile("my-agent");
  assert.match(text, /- "127\.0\.0\.1:5433:5432"/);
  assert.match(text, /- "127\.0\.0\.1:\$\{DASHBOARD_PORT:-4000\}:4000"/);
});

/* -------------------------------------------------------------------------- */
/* project identity                                                            */
/* -------------------------------------------------------------------------- */

test("two directories with the same name are not the same Compose project", () => {
  // The bug this prevents, observed live: ~/evestack-trial/my-agent and
  // ~/evestack-stranger/my-agent both emitted `name: my-agent`, so Compose
  // treated them as one project — the second `up` recreated the first's
  // containers and both agents read one database. `my-agent` is the DEFAULT
  // name, so this was the common case, not the exotic one.
  const a = projectNameFor("/Users/someone/evestack-trial/my-agent");
  const b = projectNameFor("/Users/someone/evestack-stranger/my-agent");
  assert.notEqual(a, b, "same basename in different directories must not collide");
  assert.match(a, /^my-agent-[0-9a-f]{6}$/);
  assert.match(b, /^my-agent-[0-9a-f]{6}$/);
});

test("the same directory always gets the same project name", () => {
  // Load-bearing: if this varied, every `docker compose` in a project would
  // address a different stack than the last one did.
  const path = "/Users/someone/agents/my-agent";
  assert.equal(projectNameFor(path), projectNameFor(path));
});

/* -------------------------------------------------------------------------- */
/* log rotation                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The disk this file fills if nothing here holds.
 *
 * Docker's json-file driver has no max-size and no max-file unless a compose
 * file says so, and BOTH services here are `restart: unless-stopped` — so the
 * daemon appends to /var/lib/docker/containers/<id>/<id>-json.log for as long
 * as the project is up, and a full disk stops Postgres, which stops everything.
 *
 * This test exists because the first fix went to the wrong file. The limits were
 * added to the repository's own docker-compose.yml — the CONTRIBUTOR's stack,
 * the one you run for an afternoon while changing the dashboard — and not to
 * this one, which is the deployment the audited defect was actually about.
 * `awk '/function composeFile/,/^}/' create.mjs | grep -c logging` returned 0.
 * Nothing in that file's test suite noticed, because nothing asserted it.
 */
test("every service in the generated compose has a bounded log", () => {
  const text = compose();
  // Service keys are two-space-indented under `services:`; anything deeper is a
  // field. Parsed rather than hardcoded so a third service cannot be added
  // without a ceiling — which is the failure mode of a per-service copy-paste.
  // Bounded at the next top-level key, or `evestack-pgdata` under `volumes:` is
  // read as a third service — the first version of this test said exactly that.
  const afterServices = text.slice(text.indexOf("\nservices:\n") + 1);
  const end = afterServices.search(/\n[a-z][a-z0-9_-]*:\s*\n/);
  const body = end === -1 ? afterServices : afterServices.slice(0, end + 1);
  const services = [...body.matchAll(/^ {2}([a-z][a-z0-9_-]*):$/gm)].map((m) => m[1]);
  assert.deepEqual(services, ["postgres", "dashboard"], `service list is stale: ${services}`);
  for (const name of services) {
    const start = body.indexOf(`\n  ${name}:\n`);
    const rest = body.slice(start + 1);
    const next = rest.search(/\n {2}[a-z][a-z0-9_-]*:\n|\nvolumes:\n/);
    const block = next === -1 ? rest : rest.slice(0, next);
    assert.match(block, /^ {4}logging: \*container-logs$/m, `service "${name}" has no log ceiling:\n${block}`);
  }
});

test("the anchor the services alias is actually defined, and bounds both size and count", () => {
  const text = compose();
  // An alias whose anchor is missing is not a missing ceiling, it is a file that
  // will not parse at all: Compose v5.1.0 answers `yaml: line N, column M:
  // unknown anchor 'container-logs' referenced` and refuses the project.
  // Observed against a two-line fixture, which is why the alias above is checked
  // against a definition here rather than on its own.
  const anchor = /^x-logging: &container-logs\n {2}driver: json-file\n {2}options:\n {4}max-size: "(\S+)"\n {4}max-file: "(\S+)"$/m;
  const match = anchor.exec(text);
  assert.ok(match, `no x-logging anchor in the generated compose:\n${text.slice(0, 2000)}`);
  // Both halves matter. max-size alone rotates for ever and bounds nothing;
  // max-file alone caps a count of unbounded files.
  assert.equal(match[1], "${LOG_MAX_SIZE:-10m}");
  assert.equal(match[2], "${LOG_MAX_FILE:-3}");
  // `driver:` is stated and not inherited on purpose — a host daemon defaulting
  // to journald would otherwise ignore both options — and the anchor is defined
  // before the services that alias it, because YAML resolves in document order.
  assert.ok(
    text.indexOf("x-logging: &container-logs") < text.indexOf("*container-logs"),
    "the anchor is defined after its first use",
  );
});

test("the two names Compose reads for the ceiling are in the .env it writes", () => {
  // Commented out, like EVESTACK_DASHBOARD_IMAGE beside them: the point is that
  // someone who wants a different ceiling can find the names in the file Compose
  // actually interpolates from, rather than having to reverse them out of the
  // compose file. Unprefixed on purpose — contract 19 requires every documented
  // EVESTACK_* name to have a reader in the workspace, and these two are consumed
  // by Compose on the host and never reach a container.
  const env = composeEnvFile(PASSWORD);
  assert.match(env, /^# LOG_MAX_SIZE=10m$/m, env);
  assert.match(env, /^# LOG_MAX_FILE=3$/m, env);
  // The defaults in the two files have to agree, or the .env documents a ceiling
  // the compose file does not apply.
  assert.match(compose(), /max-size: "\$\{LOG_MAX_SIZE:-10m\}"/);
  assert.match(compose(), /max-file: "\$\{LOG_MAX_FILE:-3\}"/);
});

/* -------------------------------------------------------------------------- */
/* what the file tells the reader about a dashboard with no credentials        */
/* -------------------------------------------------------------------------- */

/**
 * This file is generated into every scaffolded project, so a false sentence in
 * it is a false sentence shipped to users.
 *
 * It carried one. "with either missing it answers 503 to every request" is not
 * what the dashboard does, and the first exception is the route an operator hits
 * first. Measured by importing packages/dashboard/proxy.ts with
 * EVESTACK_AUTH_USER and EVESTACK_AUTH_PASSWORD deleted from process.env: four
 * path/method combinations pass the gate, all GET, because proxy.ts gates the
 * sign-in tier on the METHOD — `/signin`, `/api/auth/session`,
 * `/api/auth/signout` and `/api/health`; `GET /`, `/sessions`,
 * `/api/health/detail`, `POST /signin`, `POST /api/auth/session`,
 * `POST /api/auth/signout` and `POST /api/ingest/v1/traces` are 503. The two
 * /api/auth routes export POST only (their route.ts modules export POST and
 * `dynamic`, nothing else), so Next's autoImplementMethods answers a bare 405.
 * /api/health's own handler then returns 503 {"status":"unconfigured"}, which is
 * what makes `docker ps` report unhealthy — so the "reports unhealthy" half of
 * the old sentence was right and the "every request" half was not.
 *
 * The first correction stopped at two exceptions and left "everything else 503"
 * standing over the other two, which is why the 405 assertion below exists.
 */
test("the generated compose does not claim the sign-in page answers 503", () => {
  const text = compose();
  assert.doesNotMatch(
    text,
    /503 to every request/,
    "the generated compose still tells users every request is refused, including /signin",
  );
  assert.match(text, /GET \/signin\s+200/, "the sign-in exception is not stated");
  assert.match(text, /GET \/api\/health\s+503/, "the health route's own 503 is not stated");
  assert.match(
    text,
    /GET \/api\/auth\/session[\s\S]{0,120}405/,
    "the two POST-only auth routes answer 405 on GET, and the file does not say so",
  );
  // The conclusion the old sentence was there to support has to survive the
  // correction: with no credentials the dashboard is unusable, and the reason it
  // is unusable via /signin is that the page renders no form.
  assert.match(text, /renders NO sign-in form/);
});

test("a directory name Compose would reject is normalised, and still unique", () => {
  const weird = projectNameFor("/tmp/My Agent!! (v2)");
  assert.match(weird, /^[a-z0-9][a-z0-9_-]*$/, "must satisfy Compose's project-name grammar");
  assert.notEqual(weird, projectNameFor("/tmp/my-agent-v2"));
});

/* -------------------------------------------------------------------------- */
/* ports                                                                       */
/* -------------------------------------------------------------------------- */

// Two arguments, not three. `composeFile(name, password, ports)` was the
// signature that put the literal password in a committed file; the password now
// lives in composeEnvFile() and the options object moved into second place.
test("the compose file publishes the ports it was given, not the defaults", () => {
  const text = composeFile("my-agent", { pgPort: 5455, dashboardPort: 4044 });
  assert.match(text, /- "127\.0\.0\.1:5455:5432"/);
  assert.match(text, /- "127\.0\.0\.1:\$\{DASHBOARD_PORT:-4044\}:4000"/);
  // and the header a human reads names the same port it published
  assert.match(text, /the dashboard on :4044/);
  // the old hardcoded values must not survive anywhere in the file
  assert.doesNotMatch(text, /127\.0\.0\.1:5433:5432/);
  assert.doesNotMatch(text, /DASHBOARD_PORT:-4000/);
});

test("omitting the ports keeps the documented defaults", () => {
  const text = composeFile("my-agent");
  assert.match(text, /- "127\.0\.0\.1:5433:5432"/);
  assert.match(text, /- "127\.0\.0\.1:\$\{DASHBOARD_PORT:-4000\}:4000"/);
});

/* -------------------------------------------------------------------------- */
/* the /sandboxes switch                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The half of the sandbox feature that shipped, and the half that did not.
 *
 * packages/dashboard/.env.example documents EVESTACK_DOCKER_SOCKET as the way to
 * turn the /sandboxes page on, and this generated compose file had no socket
 * mount and not even a commented-out one — so following that documentation got
 * you "docker did not answer in 3000ms" instead of a container list. The
 * documented path could not work as written from a scaffolded project, which is
 * the only kind of project this file exists for.
 *
 * It stays commented out. Mounting the Docker socket into a container that
 * already takes a password on loopback and starts agent runs is root on the
 * host, so the choice belongs to a person; what was missing was the ability to
 * make that choice, not the default.
 *
 * THREE lines, not one, and that is what most of these tests are about. The
 * suggestion this came from was a single commented mount, and a single mount
 * was measured on 2026-08-10 (Docker 29.2.1, socket srw-rw---- root:991) to
 * answer `connect EACCES /var/run/docker.sock`: the dashboard image runs as USER
 * node, uid 1000, and belongs to no group that owns the socket. A mount with
 * no group_add is a second broken documented path wearing a different error.
 */

/** The commented-out line whose body starts with `needle`, or undefined. */
const commentedLine = (text, needle) =>
  text
    .split("\n")
    .find((line) =>
      line.trim().startsWith("#") && line.trim().slice(1).trimStart().startsWith(needle));

/** Lines that are NOT comments and whose trimmed form starts with `needle`. */
const liveLines = (text, needle) =>
  text
    .split("\n")
    .filter((line) => line.trim().startsWith("#") === false && line.trim().startsWith(needle));

/** The body of a commented list item, so `# - a:b` reads back as `a:b`. */
const commentedItem = (text, needle) =>
  commentedLine(text, needle).trim().slice(1).trim().slice(1).trim();

const indentOf = (line) => line.length - line.trimStart().length;

test("the socket mount ships commented out, so nothing is mounted by default", () => {
  const text = compose();
  // Nothing live. A generated file that mounts the daemon into a container
  // reachable with a password is the failure this block is arranged around.
  assert.deepEqual(liveLines(text, "- /var/run/docker.sock"), [], "the compose file MOUNTS the Docker socket");
  assert.deepEqual(liveLines(text, "group_add:"), [], "group_add is live, so the mount above it probably is too");
  assert.deepEqual(liveLines(text, "EVESTACK_DOCKER_SOCKET:"), [], "the dashboard is handed a socket path nobody opted into");
});

test("all three halves of the switch are there to uncomment", () => {
  // Any two of these without the third is a page that reports a failure rather
  // than a container list.
  const text = compose();
  assert.ok(commentedLine(text, "EVESTACK_DOCKER_SOCKET:"), "no EVESTACK_DOCKER_SOCKET line to uncomment");
  assert.ok(commentedLine(text, "- /var/run/docker.sock"), "no socket mount to uncomment");
  assert.ok(commentedLine(text, "group_add:"), "no group_add, so the mount alone answers EACCES");
  assert.ok(commentedLine(text, '- "REPLACE_WITH_YOUR_DOCKER_GID"'), "group_add has no item under it");
});

test("the variable and the mount name the same path inside the container", () => {
  // The original bug one level up: two halves of one switch that disagree.
  // EVESTACK_DOCKER_SOCKET is read inside the container, and the right-hand
  // side of the mount is where the socket lands inside the container.
  const text = compose();
  const declared = commentedLine(text, "EVESTACK_DOCKER_SOCKET:").split(":").at(-1).trim();
  const parts = commentedItem(text, "- /var/run/docker.sock").split(":");
  assert.equal(parts[1], declared, "the variable and the mount disagree about the in-container path");
  assert.equal(parts[0], "/var/run/docker.sock", "the daemon-side path is not the documented default");
});

test("the socket mount does not label itself read-only", () => {
  // Measured, not assumed: through a :ro socket mount, as a non-root
  // container user, POST /containers/create with a bind of the host root
  // answered 201. The Docker API has no read-only mode, so :ro here would be
  // a reassurance the interface does not honour — and the mount beside it that
  // IS read-only says so and means it.
  const text = compose();
  const mount = commentedLine(text, "- /var/run/docker.sock");
  assert.equal(mount.trimEnd().endsWith(":ro"), false, "the socket mount claims to be read-only");
  assert.ok(text.includes("THERE IS NO READ-ONLY DOCKER SOCKET"), "the file drops :ro without saying why");
  assert.ok(text.includes("- ./agent/skills:/agent-skills:ro"), "the skills mount stopped being read-only");
});

test("a half-applied edit fails loudly rather than as an unreachable daemon", () => {
  // The gid is host-specific, so this file cannot ship a working number. It
  // ships a placeholder rather than a plausible default on purpose: a wrong
  // number is another connect EACCES to chase from the page, while a
  // non-numeric group stops the container being created at all. Docker answers
  // Unable to find group REPLACE_WITH_YOUR_DOCKER_GID.
  const text = compose();
  const gid = commentedItem(text, '- "REPLACE_WITH_YOUR_DOCKER_GID"').replaceAll('"', "");
  assert.ok(Number.isNaN(Number(gid)), "a numeric placeholder gid would fail as a silent EACCES");
  // And the number comes from the daemon rather than from the host group file:
  // under Docker Desktop and Colima those are two different machines.
  assert.ok(text.includes("stat -c '%g' /var/run/docker.sock"));
});

test("uncommenting the three lines lands them at the indentation YAML needs", () => {
  const text = compose();
  const lines = text.split("\n");
  const skillsMount = lines.find((l) => l.trim() === "- ./agent/skills:/agent-skills:ro");
  const socketMount = commentedLine(text, "- /var/run/docker.sock");
  // Measured on the line the edit produces: deleting the "# " is the whole edit.
  assert.equal(indentOf(socketMount.replace("# ", "")), indentOf(skillsMount), "the socket mount would not be a sibling of the skills mount");
  const skillsVar = lines.find((l) => l.trim().startsWith("EVESTACK_SKILLS_DIR:"));
  const socketVar = commentedLine(text, "EVESTACK_DOCKER_SOCKET:");
  assert.equal(indentOf(socketVar.replace("# ", "")), indentOf(skillsVar), "the socket variable would not be an environment key");
  const ports = lines.find((l) => l.trim() === "ports:" && indentOf(l) === 4);
  const groupAdd = commentedLine(text, "group_add:");
  const groupItem = commentedLine(text, '- "REPLACE_WITH_YOUR_DOCKER_GID"');
  assert.equal(indentOf(groupAdd.replace("# ", "")), indentOf(ports), "group_add would not be a service key");
  assert.equal(indentOf(groupItem.replace("# ", "")), indentOf(groupAdd.replace("# ", "")) + 2, "the group item is not nested under group_add");
  // Order matters as much as indentation: the mount has to fall inside the
  // volumes list of the dashboard, and group_add has to fall outside it.
  const at = (line) => text.indexOf(line);
  assert.ok(at(skillsMount) < at(socketMount), "the socket mount is not inside the volumes list");
  assert.ok(at(socketMount) < at(groupAdd), "group_add is inside the volumes list, where it is not a key");
  assert.ok(at(groupAdd) < at("    extra_hosts:"), "group_add is not in the dashboard service");
});

test("the file states what the mount costs before it shows how to enable it", () => {
  // The /sandboxes page explains the risk well, but the compose file is where
  // someone actually types the change, and it used to say nothing at all.
  const text = compose();
  const warning = text.indexOf("MOUNTING THIS MAKES THE DASHBOARD ROOT ON YOUR MACHINE");
  assert.ok(warning > -1, "the compose file mounts the daemon without saying what that costs");
  assert.ok(warning < text.indexOf("# - /var/run/docker.sock"), "the mount appears above the warning");
});
