/**
 * The one path in the scaffolder that talks to real Docker.
 *
 * Everything else in this package can be tested against a filesystem, and was.
 * `bringUp` could not, so it shipped unexecuted twice over — and the second
 * time it carried a real bug: `run()` used `spawnSync`, which blocks the event
 * loop for the whole life of the child, so the `setInterval` behind the
 * progress row never fired. Measured on a two-second child: 2 repaints with
 * spawnSync (the first paint and the settle) against 24 with async spawn. An
 * eighteen-second install rendered as a frozen spinner reading `0s`, which is
 * indistinguishable from a hang and worse than the wall of output it replaced.
 *
 * So this starts a real container. It is skipped — not failed — when Docker is
 * not available or the image is not already cached, because neither is true of
 * every machine and a test that fails on a laptop without Docker is a test
 * people learn to ignore. `only: "database"` stops it before the ~230 MB
 * dashboard pull.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  bringUp, childEnv, composeEnvFile, composeFile, localEveBinary, projectNameFor, quoteForCmd,
  spawnTarget, windowsCommandLine,
} from "../create.mjs";
import { freePort } from "../shared.mjs";

const PG_IMAGE = "pgvector/pgvector:pg17";
const dockerUsable =
  spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0 &&
  spawnSync("docker", ["image", "inspect", PG_IMAGE], { stdio: "ignore" }).status === 0;

test(
  "bringUp starts a real Postgres and settles its progress rows",
  { skip: dockerUsable ? false : `needs Docker and a cached ${PG_IMAGE}` },
  async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "evestack-bringup-"));
    // Chosen against this machine with the scaffolder's own helper, well away
    // from 5433 so a developer's running stack is never touched. Hardcoding one
    // failed here on the first run — something already held it — which is the
    // same lesson `create` learned when it assumed 5433.
    const pgPort = await freePort(55440);
    writeFileSync(join(dir, ".env"), composeEnvFile("test-password-not-a-secret"));
    writeFileSync(
      join(dir, "docker-compose.yml"),
      composeFile(projectNameFor(dir), { pgPort, dashboardPort: 54000, agentPort: 52000 }),
    );
    // No package.json script to run, so the schema step is expected to fail —
    // which is the more valuable half of this test: it proves the failure path
    // settles the row, prints the tail, and stops rather than continuing on to
    // the dashboard.
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "t", private: true }));

    t.after(() => {
      spawnSync("docker", ["compose", "down", "-v"], { cwd: dir, stdio: "ignore" });
    });

    // HOSTILE ON PURPOSE, rather than by accident of how the suite was invoked.
    //
    // This test already caught the bug below — but only when the whole suite ran
    // as `pnpm -r --if-present test`, because that is what put
    // npm_config_if_present in the environment. Run any other way it passed, so
    // for a while it looked like flakiness rather than a finding. Setting it
    // here makes the assertion mean the same thing under every invocation.
    const savedIfPresent = process.env.npm_config_if_present;
    process.env.npm_config_if_present = "true";
    t.after(() => {
      if (savedIfPresent === undefined) delete process.env.npm_config_if_present;
      else process.env.npm_config_if_present = savedIfPresent;
    });

    const started = Date.now();
    const up = await bringUp(dir, "npm", 54000, { only: "database" });
    const elapsed = Date.now() - started;

    // The schema step has no `db:bootstrap` to run, so bringUp must report
    // false — and must have stopped there rather than reaching the pull.
    assert.equal(up, false, "a missing db:bootstrap script has to stop the sequence");

    // But Postgres itself really came up, which is the thing Docker was needed
    // for. `--wait` means this only returns once the healthcheck passes.
    const ps = spawnSync("docker", ["compose", "ps", "--format", "{{.Service}}"], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.match(ps.stdout, /postgres/, "the postgres service should be running");
    assert.ok(elapsed > 200, "a real container start takes longer than this");
  },
);

test("the progress row is not blocked by the child process", async () => {
  // The regression itself, at the level it actually broke: a spinner can only
  // animate if the event loop is free while the child runs. Asserted as a
  // property rather than against an implementation, so going back to a blocking
  // spawn fails here instead of silently freezing the UI again.
  //
  // Run in a child with FORCE_COLOR=1 and a faked TTY, because ui.mjs decides
  // colour once at import from the real stdout — under `node --test` that is a
  // pipe, so an in-process version of this measures a spinner that correctly
  // never started, and passes or fails for the wrong reason. It did: it read
  // zero repaints on a build where the animation was working.
  const { execFileSync } = await import("node:child_process");
  const { readFileSync, rmSync } = await import("node:fs");
  // The result goes to a file, not a stream: the spinner owns stdout for the
  // duration and stderr would still be interleaved with anything Node prints.
  const resultFile = join(mkdtempSync(join(tmpdir(), "evestack-spin-")), "result.json");
  const probe = `
    process.stdout.isTTY = true;
    const { writeFileSync } = await import("node:fs");
    const { task } = await import(${JSON.stringify(new URL("../ui.mjs", import.meta.url).pathname)});
    const { spawn, spawnSync } = await import("node:child_process");
    const child = [process.execPath, ["-e", "setTimeout(()=>{},1000)"]];
    async function measure(blocking) {
      let repaints = 0;
      const real = process.stdout.write.bind(process.stdout);
      process.stdout.write = (s) => { if (String(s).includes("\\u001b[2K")) repaints += 1; return true; };
      const t = task("probe", "one second");
      if (blocking) spawnSync(...child);
      else await new Promise((r) => spawn(...child).on("close", r));
      t.done("done");
      process.stdout.write = real;
      return repaints;
    }
    const blocked = await measure(true);
    const free = await measure(false);
    writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ blocked, free }));
  `;
  execFileSync(process.execPath, ["--input-type=module", "-e", probe], {
    env: { ...process.env, FORCE_COLOR: "1" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  const { blocked, free } = JSON.parse(readFileSync(resultFile, "utf8"));
  rmSync(resultFile, { force: true });

  assert.ok(free >= 5, `an async child must leave the loop free to animate; saw ${free} repaints`);
  assert.ok(
    free > blocked * 3,
    `async (${free}) should animate far more than blocking (${blocked}) — if these are close, run() is blocking the event loop again`,
  );
});

test("ui.mjs installs no signal handlers merely by being imported", async () => {
  // The regression this pins is the worse of the two. ui.mjs used to register
  // `process.on("SIGINT", … process.exit(130))` at module scope, and
  // templates/default/scripts/dev.mjs imports it transitively through
  // checks.mjs. Ours ran first and exited the process, so dev.mjs's forwarder —
  // whose whole job is `child.kill(signal)` — never ran, and Ctrl-C left
  // `eve dev` orphaned on the port.
  const { execFileSync } = await import("node:child_process");
  const out = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `await import(${JSON.stringify(new URL("../ui.mjs", import.meta.url).pathname)});
       process.stdout.write(JSON.stringify({
         sigint: process.listenerCount("SIGINT"),
         sigterm: process.listenerCount("SIGTERM"),
         exit: process.listenerCount("exit"),
       }));`,
    ],
    { encoding: "utf8" },
  );
  assert.deepEqual(JSON.parse(out), { sigint: 0, sigterm: 0, exit: 0 });
});

test("npm config that arrives through the environment cannot change what a step means", () => {
  // `npm run <missing-script>` exits 1, and 0 when npm_config_if_present is set
  // — measured, both ways. Every step in bringUp reads its exit code, so an
  // ambient copy of that variable turns "the script does not exist" into
  // success: the schema row prints "workflow tables created" having created
  // nothing, bringUp returns true, and the dashboard starts against an empty
  // database.
  //
  // It reaches a child by inheritance, so it is not something a caller opts
  // into. The root `pnpm -r --if-present test` in this repository exports it.
  const saved = process.env.npm_config_if_present;
  try {
    process.env.npm_config_if_present = "true";
    assert.equal(
      childEnv().npm_config_if_present,
      undefined,
      "npm_config_if_present must not reach a child, or a missing script reads as a completed step",
    );
    // Everything else is passed through: this strips one named variable, it does
    // not sanitise the environment.
    process.env.BRINGUP_CANARY_NOT_AN_EVESTACK_VAR = "kept";
    assert.equal(childEnv().BRINGUP_CANARY_NOT_AN_EVESTACK_VAR, "kept", "unrelated variables still reach the child");
  } finally {
    delete process.env.BRINGUP_CANARY_NOT_AN_EVESTACK_VAR;
    if (saved === undefined) delete process.env.npm_config_if_present;
    else process.env.npm_config_if_present = saved;
  }
});

/* -------------------------------------------------------------------------- */
/* what `run()` hands the operating system                                     */
/* -------------------------------------------------------------------------- */

/**
 * THE DEFECT: `shell: process.platform === "win32"`, under a comment that said
 * "Every argument this file passes is a literal without spaces, which is what
 * makes the shell safe to use here."
 *
 * Two of them are not literals. `addOne` passes `item.id`, which comes off the
 * live registry at eve.dev, and every `--answer` string, which is built from
 * that item's own NDJSON output. Node's `shell: true` on Windows does this:
 *
 *     command = [file, ...args].join(' ')            // no quoting, no escaping
 *     args    = ['/d', '/s', '/c', `"${command}"`]   // handed to cmd.exe
 *
 * so `eve add channel/x&calc` is a command line with `&` in it, and cmd.exe
 * means something by that. The id is never rendered in the picker — rows show
 * `title` — so the person who ticked "Slack" has no way to see what they chose.
 *
 * These assert on the escaping rather than on the spawn, because the Windows
 * branch cannot be executed here. They are the reason `spawnTarget` takes a
 * `platform` parameter at all.
 */

/**
 * cmd.exe's own parse, done here so the assertions can be about the ARGUMENT a
 * child would receive rather than about a string of carets.
 *
 * Outside a quoted region cmd removes each caret and takes the next character
 * literally. Everything `quoteForCmd` emits is outside a quoted region — that
 * is the point of caret-escaping the quotes it adds — so this single rule is
 * the whole of cmd's pass over it.
 */
const stripCarets = (line) => line.replace(/\^(.)/g, "$1");

/**
 * The C runtime's argv splitter, which is what the child program itself uses.
 * Backslashes are literal except before a quote, where pairs collapse and an
 * odd one escapes the quote.
 */
function crtSplit(line) {
  const args = [];
  let current = "";
  let quoted = false;
  let started = false;
  let slashes = 0;
  const flushSlashes = (half) => {
    current += "\\".repeat(half ? slashes >> 1 : slashes);
    slashes = 0;
  };
  for (const ch of line) {
    if (ch === "\\") {
      slashes += 1;
      started = true;
      continue;
    }
    if (ch === '"') {
      const escaped = slashes % 2 === 1;
      flushSlashes(true);
      started = true;
      if (escaped) current += '"';
      else quoted = !quoted;
      continue;
    }
    flushSlashes(false);
    if (ch === " " && !quoted) {
      if (started) args.push(current);
      current = "";
      started = false;
      continue;
    }
    started = true;
    current += ch;
  }
  flushSlashes(false);
  if (started) args.push(current);
  return args;
}

/** command + args, put through both parsers in the order Windows applies them. */
function roundTrip(command, args) {
  const spawned = spawnTarget(command, args, "win32");
  // `/s` strips the first and last character when both are quotes, then cmd
  // parses what is left. Node does the same wrapping under `shell: true`.
  const line = spawned.args[3];
  assert.equal(line[0], '"');
  assert.equal(line.at(-1), '"');
  return crtSplit(stripCarets(line.slice(1, -1)));
}

test("a registry id that is a shell fragment arrives as one argument, not a command", () => {
  // The whole finding, in one assertion. Under the old `shell: true` the line
  // was `eve add channel/x&calc --non-interactive`, and cmd.exe runs `calc`.
  assert.deepEqual(
    roundTrip("eve", ["add", "channel/x&calc", "--non-interactive"]),
    ["eve", "add", "channel/x&calc", "--non-interactive"],
  );
});

test("every cmd.exe metacharacter survives as text", () => {
  const nasty = [
    "a&b", "a|b", "a>b", "a<b", "a&&b", "a||b", "a^b", "%PATH%", "!DELAYED!",
    "a(b)c", "a;b", "a,b", "a b", "a*b", "a?b", "a`b", 'a"b', "a\\b", "a\\\\b", 'end\\',
  ];
  assert.deepEqual(roundTrip("eve", nasty), ["eve", ...nasty]);
});

test("an --answer built from the registry's own JSON round-trips exactly", () => {
  // `recommendedAnswer` produces `key=<JSON>`, so quotes are not an edge case
  // here, they are every case — and a JSON string can hold anything at all.
  const answers = [
    'channel=["web"]',
    'token={"name":"a b","then":"& calc"}',
    'path={"dir":"C:\\\\Users\\\\a b\\\\x"}',
  ];
  assert.deepEqual(roundTrip("eve", ["add", "channel/web", ...answers]), [
    "eve", "add", "channel/web", ...answers,
  ]);
});

test("POSIX is the identity case, with no shell anywhere in it", () => {
  // The escaping above exists for one platform. Everywhere else argv goes
  // straight to execve, and a change that started quoting on macOS would break
  // every spawn in the file — so this is pinned, not assumed.
  const args = ["add", "channel/x&calc", "--non-interactive"];
  assert.deepEqual(spawnTarget("eve", args, "linux"), {
    file: "eve",
    args,
    windowsVerbatimArguments: false,
  });
  assert.deepEqual(spawnTarget("eve", args, "darwin").args, args);
});

test("the Windows launcher is the one Node's own shell:true would have used", () => {
  // Same interpreter, same switches, same verbatim flag: the only thing that
  // changes is that the tokens are escaped. That equivalence is what makes this
  // safe to ship without a Windows machine to try it on.
  const launched = spawnTarget("npm", ["install"], "win32");
  assert.match(launched.file, /cmd(\.exe)?$/i);
  assert.deepEqual(launched.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.equal(launched.windowsVerbatimArguments, true);
  assert.equal(launched.args[3], windowsCommandLine("npm", ["install"]));
  // And nothing is left bare: a token with a metacharacter in it cannot appear
  // in the command line unescaped.
  assert.doesNotMatch(spawnTarget("npm", ["a&b"], "win32").args[3], /[^^]&/);
  assert.equal(quoteForCmd("a&b"), '^"a^&b^"');
});

test("the local eve is resolved to the shim Windows can actually execute", () => {
  // npm writes three files for one bin on Windows: `eve` (an sh script, which
  // neither CreateProcess nor cmd.exe can run), `eve.ps1`, and `eve.cmd`.
  // `existsSync(<no extension>)` said yes to the first of those.
  const dir = mkdtempSync(join(tmpdir(), "evestack-evebin-"));
  const bin = join(dir, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });

  assert.equal(localEveBinary(dir, "win32"), null, "nothing installed is null, not a path");
  assert.equal(localEveBinary(dir, "linux"), null);

  writeFileSync(join(bin, "eve"), "#!/bin/sh\n");
  assert.equal(localEveBinary(dir, "linux"), join(bin, "eve"));

  writeFileSync(join(bin, "eve.cmd"), "@echo off\n");
  assert.equal(localEveBinary(dir, "win32"), join(bin, "eve.cmd"), "the .cmd shim is the runnable one");
  assert.equal(localEveBinary(dir, "linux"), join(bin, "eve"), "and POSIX is untouched by it");
});
