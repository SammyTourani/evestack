import assert from "node:assert/strict";
import { test } from "node:test";
import { composeFile } from "../create.mjs";

/**
 * The compose file a stranger actually gets.
 *
 * This exists because the scaffolder shipped `POSTGRES_PASSWORD: evestack` and
 * published `"5433:5432"` — no interface prefix, so 0.0.0.0 — for long enough
 * that another machine on the same network connected to it and authenticated.
 * That database holds every prompt, tool result and memory the agent has
 * produced. The dashboard in the same generated file was already pinned to
 * 127.0.0.1 with a comment about control planes, so one file disagreed with
 * itself, and the half that was wrong was the more valuable target.
 *
 * `create.mjs` generates the dashboard password and the ingest token and says
 * in a comment why a shipped default would be indefensible. The database
 * password was the one credential that comment did not cover.
 */

const PASSWORD = "GENERATED-pw_abc123";
const compose = () => composeFile("my-agent", PASSWORD);

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

test("the database password is the generated one, never a default", () => {
  const text = compose();
  assert.match(text, new RegExp(`POSTGRES_PASSWORD: "${PASSWORD}"`));
  assert.ok(
    !text.includes("POSTGRES_PASSWORD: evestack"),
    "a default database password is shipped in the compose file",
  );
});

test("no connection string carries the old default credentials", () => {
  const text = compose();
  assert.ok(
    !text.includes("evestack:evestack"),
    "postgres://evestack:evestack survives somewhere in the compose file",
  );
  // Both halves must reach the same database, or the dashboard reads nothing.
  assert.ok(
    text.includes(`postgres://evestack:${PASSWORD}@postgres:5432/evestack`),
    "the dashboard's connection string does not use the generated password",
  );
});

test("a password with URL-significant characters is still quoted in YAML", () => {
  // base64url yields A-Za-z0-9-_ ; a leading '-' must not be read as a sequence.
  const text = composeFile("my-agent", "-leading-dash_ok");
  assert.match(text, /POSTGRES_PASSWORD: "-leading-dash_ok"/);
});

test("a relocated Postgres port reaches the compose file, still on loopback", () => {
  const text = composeFile("my-agent", PASSWORD, { pgPort: 5436, dashboardPort: 4002 });
  const ports = publishedPorts(text);
  assert.ok(ports.includes("127.0.0.1:5436:5432"), `Postgres published as ${ports}`);
  assert.ok(
    !ports.some((entry) => entry.includes(":5433:")),
    "the hardcoded default port survived somewhere in the compose file",
  );
});

test("a relocated dashboard port keeps its DASHBOARD_PORT override", () => {
  // The env var stays an override; only its default moves. Someone who has set
  // DASHBOARD_PORT means it, whatever this scaffold measured.
  const text = composeFile("my-agent", PASSWORD, { pgPort: 5433, dashboardPort: 4002 });
  assert.match(text, /\$\{DASHBOARD_PORT:-4002\}:4000/);
});

test("omitting the ports keeps the documented defaults", () => {
  const ports = publishedPorts(compose());
  assert.ok(ports.includes("127.0.0.1:5433:5432"));
  assert.match(compose(), /\$\{DASHBOARD_PORT:-4000\}:4000/);
});

test("a moved port leaves no trace of the port it moved off", () => {
  // Every number in this file is generated from one variable except the one
  // in the dashboard comment, which was typed. Read while debugging exactly
  // the case that moved the port, it names a port nothing is listening on.
  const text = composeFile("my-agent", PASSWORD, { pgPort: 5434, dashboardPort: 4001 });
  assert.ok(
    !/5433/.test(text.replace(/Publishing "5433:5432"/, "")),
    "the compose file still refers to 5433 after Postgres moved to 5434",
  );
  assert.match(text, /\.env\.local says localhost:5434/);
});
