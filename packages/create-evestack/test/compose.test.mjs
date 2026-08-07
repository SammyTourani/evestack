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
