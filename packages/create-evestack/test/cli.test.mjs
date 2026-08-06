import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * The bin, run as a process, because what this asserts is what reaches a
 * terminal rather than what a function returns.
 *
 * Both commands report their real refusals by throwing: attach refuses a
 * directory that is not an eve project, and every one of those messages names
 * the exact file it wanted. Whether that arrives as a sentence or as a stack
 * trace is not cosmetic — a stack trace puts the useful line third, under a
 * source excerpt, above a Node version footer. The `evestack` bin has caught
 * these since it grew a `create` command; this one did not.
 */
const BIN = fileURLToPath(new URL("../index.mjs", import.meta.url));
const NOWHERE = "/definitely/not/an/eve/project";

test("a refusal reaches the terminal as its message, not as a crash", () => {
  const { status, stderr, stdout } = spawnSync(process.execPath, [BIN, "attach", NOWHERE], {
    encoding: "utf8",
    input: "",
  });
  assert.equal(status, 1);
  // The message attach actually wrote, both halves of it.
  assert.match(stderr, /No such directory: \/definitely\/not\/an\/eve\/project/);
  assert.match(stderr, /Pass the path to an existing eve project/);
  // And none of the wrapping node adds to an unhandled rejection.
  const all = `${stdout}${stderr}`;
  assert.doesNotMatch(all, /\bat detectEveProject\b/, "a stack trace reached the user");
  assert.doesNotMatch(all, /^Node\.js v/m, "node's crash footer reached the user");
  assert.doesNotMatch(all, /throw new Error/, "node's source excerpt reached the user");
});

test("the stack is still there for whoever actually wants it", () => {
  const { stderr } = spawnSync(process.execPath, [BIN, "attach", NOWHERE], {
    encoding: "utf8",
    input: "",
    env: { ...process.env, EVESTACK_DEBUG: "1" },
  });
  assert.match(stderr, /\bat detectEveProject\b/);
});

/* ------------------------------------------------------------------ */
/* attach's printed credentials                                       */
/* ------------------------------------------------------------------ */

const ANSI = /\x1b\[[0-9;]*m/g;

/**
 * A minimal eve project that already has both compose files.
 *
 * That combination is the one branch where attach writes no compose file
 * of its own and prints the service block for the reader to paste, which
 * makes it the branch where two separately printed halves of one
 * credential can disagree with nothing failing until Postgres refuses
 * the login.
 */
function bothComposeFilesProject() {
  const dir = mkdtempSync(join(tmpdir(), "evestack-attach-"));
  mkdirSync(join(dir, "agent"), { recursive: true });
  const pkg = { name: "probe-agent", dependencies: { eve: "^0.30.8" } };
  writeFileSync(join(dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  writeFileSync(
    join(dir, "agent", "agent.ts"),
    'export default defineAgent({ model: "x" });\n',
  );
  writeFileSync(join(dir, "docker-compose.yml"), "services: {}\n");
  writeFileSync(join(dir, "docker-compose.evestack.yml"), "services: {}\n");
  return dir;
}

test("the Postgres attach prints and the one it connects to share a password", () => {
  const dir = bothComposeFilesProject();
  try {
    const { stdout } = spawnSync(process.execPath, [BIN, "attach", dir, "--yes"], {
      encoding: "utf8",
      input: "",
    });
    const text = stdout.replace(ANSI, "");
    // The service block the reader is told to paste into their compose file.
    const inCompose = /POSTGRES_PASSWORD: "([^"]+)"/.exec(text);
    // The connection string the dashboard is started with, two screens up.
    const inDashboard = /WORKFLOW_POSTGRES_URL='postgres:[/][/]evestack:([^@]+)@/.exec(text);
    assert.ok(inCompose, "no compose service was printed for the manual branch");
    assert.ok(inDashboard, "no dashboard connection string was printed");
    assert.equal(
      inDashboard[1],
      inCompose[1],
      "the dashboard points at a database whose password was never printed",
    );
    // The port has always agreed. Asserted so that fixing the password
    // cannot quietly break the other half of the same pairing.
    const port = /- "127[.]0[.]0[.]1:(\d+):5432"/.exec(text);
    assert.ok(port, "no published Postgres port was printed");
    assert.match(text, new RegExp(`@host[.]docker[.]internal:${port[1]}/evestack`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
