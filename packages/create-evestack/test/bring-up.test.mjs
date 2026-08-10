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
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { bringUp, childEnv, composeEnvFile, composeFile, projectNameFor } from "../create.mjs";
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
