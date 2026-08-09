import assert from "node:assert/strict";
import { test } from "node:test";
import * as sdk from "@alibaba-group/opensandbox";

import { opensandbox } from "../dist/index.js";
import { KILLED_EXIT_CODE } from "../dist/translate.js";

/**
 * The session surface, exercised without an OpenSandbox server.
 *
 * translate.test.mjs covers the pure functions; everything else in index.ts
 * needs a sandbox, which used to mean none of it was covered at all — and three
 * defects lived in exactly that gap: `run()` reported a killed command as exit
 * 0, `kill()` never asked the sandbox to kill anything, and an unimplemented
 * network-policy option was accepted and dropped.
 *
 * `Sandbox.create` / `.connect` / `.resume` are static methods on the class the
 * adapter imports, so replacing them replaces the whole server. The adapter's
 * own code path — create(), wrapSession(), the reattach ladder, captureState —
 * runs for real; only the wire is fake. Statics are restored after every test
 * because node:test shares one process per file.
 */

const REAL_STATICS = {
  create: sdk.Sandbox.create,
  connect: sdk.Sandbox.connect,
  resume: sdk.Sandbox.resume,
};

function restoreStatics() {
  sdk.Sandbox.create = REAL_STATICS.create;
  sdk.Sandbox.connect = REAL_STATICS.connect;
  sdk.Sandbox.resume = REAL_STATICS.resume;
}

/**
 * A sandbox whose `commands.run` is whatever the test needs, recording every
 * call so a test can assert on what the adapter actually sent.
 */
function fakeSandbox({ id = "sbx-1", run }) {
  const calls = [];
  return {
    calls,
    sandbox: {
      id,
      files: { createDirectories: async () => {} },
      commands: {
        run: (command, options, handlers, signal) => {
          calls.push({ command, options, signal });
          return run(command, options, handlers, signal);
        },
      },
      pause: async () => {},
      kill: async () => {},
    },
  };
}

/** One completed execution, in the shape the SDK's `run()` resolves with. */
function execution({ exitCode = 0, stdout = [], stderr = [], error } = {}) {
  return {
    logs: { stdout: stdout.map((text) => ({ text })), stderr: stderr.map((text) => ({ text })) },
    result: [],
    exitCode,
    ...(error ? { error } : {}),
  };
}

async function createSession(fake, { backend = opensandbox(), metadata } = {}) {
  sdk.Sandbox.create = async () => fake.sandbox;
  return backend.create({
    templateKey: null,
    sessionKey: "session-under-test",
    ...(metadata ? { existingMetadata: metadata } : {}),
    runtimeContext: { appRoot: "/tmp/app" },
  });
}

// ---------------------------------------------------------------------------
// A command that did not complete is not a command that succeeded
// ---------------------------------------------------------------------------

test("run() reports a killed command as failure, not exit 0", async (t) => {
  t.after(restoreStatics);
  // What the SDK hands back when the SSE stream ends with neither a completion
  // nor an error event: a server-side timeout kill, an OOM, a dead container.
  const fake = fakeSandbox({ run: async () => execution({ exitCode: null, stdout: ["partial"] }) });
  const handle = await createSession(fake);

  const result = await handle.session.run({ command: "sleep 100" });

  // Before the fix this was 0, and the model was told the command succeeded.
  assert.equal(result.exitCode, KILLED_EXIT_CODE);
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.stdout, "partial");
});

test("run() still reports a genuine exit 0 as success", async (t) => {
  t.after(restoreStatics);
  const fake = fakeSandbox({ run: async () => execution({ exitCode: 0, stdout: ["ok"] }) });
  const handle = await createSession(fake);

  assert.deepEqual(await handle.session.run({ command: "true" }), {
    stdout: "ok",
    stderr: "",
    exitCode: 0,
  });
});

// ---------------------------------------------------------------------------
// kill() actually kills
// ---------------------------------------------------------------------------

/** A `commands.run` that never settles until its signal aborts. */
function longRunningRun() {
  const state = { aborted: false };
  const run = (command, options, handlers, signal) =>
    new Promise((resolve, reject) => {
      if (signal === undefined) {
        // The kill command itself: a normal, immediately-finishing execution.
        resolve(execution({ exitCode: 0 }));
        return;
      }
      signal.addEventListener(
        "abort",
        () => {
          state.aborted = true;
          reject(signal.reason ?? new Error("aborted"));
        },
        { once: true },
      );
    });
  return { run, state };
}

test("kill() terminates the process inside the sandbox", async (t) => {
  t.after(restoreStatics);
  const { run } = longRunningRun();
  const fake = fakeSandbox({ run });
  const handle = await createSession(fake);

  const spawned = await handle.session.spawn({ command: "sleep 1000" });
  const spawnCall = fake.calls.at(-1);
  await spawned.kill();

  // Before the fix, kill() called AbortController.abort() and nothing else:
  // exactly one call was ever made to the sandbox, and whether the command died
  // was left to whatever execd does when a client hangs up.
  assert.equal(fake.calls.length, 2, "kill() must send a termination command");
  const killCall = fake.calls.at(-1);
  assert.ok(killCall.command.includes("kill -9"), killCall.command);
  // ...aimed at the pid the spawn wrapper recorded, not at some other process.
  const pidFile = /'(\/tmp\/\.evestack-sbx-spawn-[^']+\.pid)'/.exec(spawnCall.command)?.[1];
  assert.ok(pidFile, spawnCall.command);
  assert.ok(killCall.command.includes(pidFile), killCall.command);
});

test("wait() after kill() reports termination rather than success", async (t) => {
  t.after(restoreStatics);
  const { run } = longRunningRun();
  const handle = await createSession(fakeSandbox({ run }));

  const spawned = await handle.session.spawn({ command: "sleep 1000" });
  await spawned.kill();

  // Before the fix this rejected with AbortError, so no exit code was reported
  // at all; the requirement is that the exit-code path says "terminated".
  const waited = await spawned.wait();
  assert.equal(waited.exitCode, KILLED_EXIT_CODE);
  assert.notEqual(waited.exitCode, 0);
});

/**
 * The kill as it actually happens on a wire.
 *
 * `longRunningRun` above resolves the kill command synchronously, which hides
 * the ordering that matters: on a real server the kill request is a round trip,
 * the server kills the process BEFORE it answers, and so the spawned command's
 * SSE stream dies while `killTree()` is still in flight. That is the window the
 * intent flag has to already be set for.
 */
function killRacesTheStream() {
  let failSpawn;
  const run = (command, options, handlers, signal) => {
    if (signal === undefined) {
      // The kill command. The process dies inside the sandbox first; our
      // response comes back after.
      return new Promise((resolve) => {
        setTimeout(() => {
          failSpawn(new Error("stream closed: process terminated"));
          setTimeout(() => resolve(execution({ exitCode: 0 })), 0);
        }, 0);
      });
    }
    return new Promise((_resolve, reject) => {
      failSpawn = reject;
    });
  };
  return { run };
}

test("wait() resolves with 137 when the stream dies DURING the kill round trip", async (t) => {
  t.after(restoreStatics);
  const handle = await createSession(fakeSandbox(killRacesTheStream()));

  const spawned = await handle.session.spawn({ command: "sleep 1000" });
  await spawned.kill();

  // Before the fix, `kill()` was `await killTree(); killedByCaller = true;` —
  // the flag went up only after the round trip, so a stream that broke because
  // of our own kill took the "broke unexpectedly" branch. Reproduced on that
  // build: `wait() REJECTED: Error: stream closed: process terminated`, from a
  // kill that worked perfectly.
  const waited = await spawned.wait();
  assert.equal(waited.exitCode, KILLED_EXIT_CODE);

  // ...and a consumer of the output must not be handed an error either: it also
  // errored both byte sinks. `close()` is what a killed process's stream does.
  assert.deepEqual(await spawned.stdout.getReader().read(), { done: true, value: undefined });
});

test("kill() is idempotent, and a process that already exited keeps its code", async (t) => {
  t.after(restoreStatics);
  let settleSpawn;
  const fake = fakeSandbox({
    run: (command, options, handlers, signal) =>
      signal === undefined
        ? Promise.resolve(execution({ exitCode: 0 }))
        : new Promise((resolve) => {
            settleSpawn = resolve;
          }),
  });
  const handle = await createSession(fake);

  const spawned = await handle.session.spawn({ command: "echo hi" });
  settleSpawn(execution({ exitCode: 0 }));
  assert.deepEqual(await spawned.wait(), { exitCode: 0 });

  // Killing something that already finished must not rewrite its result into a
  // termination, and must not throw on the second call.
  await spawned.kill();
  await spawned.kill();
  assert.deepEqual(await spawned.wait(), { exitCode: 0 });
});

test("kill() throws when the termination request never reached the sandbox", async (t) => {
  t.after(restoreStatics);
  const fake = fakeSandbox({
    run: (command, options, handlers, signal) =>
      signal === undefined
        ? Promise.reject(new Error("connection reset"))
        : new Promise(() => {}),
  });
  const handle = await createSession(fake);

  const spawned = await handle.session.spawn({ command: "sleep 1000" });
  // Reporting a successful kill here is the bug this method already had. If the
  // request did not land, the process may still be running and the caller is the
  // only one who can do anything about it.
  await assert.rejects(() => spawned.kill(), /connection reset/);
});

test("a kill that never landed does not turn a later stream break into a 137", async (t) => {
  t.after(restoreStatics);
  let failSpawn;
  const fake = fakeSandbox({
    run: (command, options, handlers, signal) =>
      signal === undefined
        ? Promise.reject(new Error("connection reset"))
        : new Promise((_resolve, reject) => {
            failSpawn = reject;
          }),
  });
  const handle = await createSession(fake);

  const spawned = await handle.session.spawn({ command: "sleep 1000" });
  await assert.rejects(() => spawned.kill(), /connection reset/);

  // This pins the `catch` branch that takes the intent flag back down. The flag
  // now goes UP before the round trip, so without that reset a kill we know did
  // not reach the sandbox would still make every later stream failure report a
  // clean termination — the same "reporting a kill that may not have happened"
  // the test above exists to prevent, moved one method along.
  failSpawn(new Error("sandbox went away"));
  await assert.rejects(() => spawned.wait(), /sandbox went away/);
});

test("an external abortSignal kills the process and still rejects wait()", async (t) => {
  t.after(restoreStatics);
  const { run } = longRunningRun();
  const fake = fakeSandbox({ run });
  const handle = await createSession(fake);

  const controller = new AbortController();
  const spawned = await handle.session.spawn({
    command: "sleep 1000",
    abortSignal: controller.signal,
  });
  const waited = spawned.wait();
  controller.abort(new Error("turn cancelled"));

  // eve documents the abortSignal path as rejecting with the abort reason, so
  // that half is unchanged — but the process still has to die.
  await assert.rejects(() => waited, /turn cancelled/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(
    fake.calls.some((call) => call.command.includes("kill -9")),
    "an aborted spawn must also terminate the process",
  );
});

test("spawn() runs the caller's command unchanged", async (t) => {
  t.after(restoreStatics);
  const fake = fakeSandbox({ run: async () => execution({ exitCode: 0 }) });
  const handle = await createSession(fake);

  await handle.session.spawn({ command: "npm install && npm start" });

  // The pid wrapper exists so kill() has something to aim at; it must not change
  // what the caller asked to run.
  assert.ok(
    fake.calls[0].command.split("\n").includes("npm install && npm start"),
    fake.calls[0].command,
  );
  assert.equal(fake.calls[0].options.workingDirectory, "/workspace");
});

// ---------------------------------------------------------------------------
// A requested network restriction is never silently dropped
// ---------------------------------------------------------------------------

test("an option this backend does not implement is refused, not ignored", async (t) => {
  t.after(restoreStatics);
  // Verified against the previous build: `opensandbox({ initialNetworkPolicy:
  // "deny-all" })` called Sandbox.create with {"image":"ubuntu"} and said
  // nothing, so a caller who asked for a locked-down network got an open one.
  assert.throws(
    () => opensandbox({ initialNetworkPolicy: "deny-all" }),
    /initialNetworkPolicy[\s\S]*networkPolicy/,
  );
  assert.throws(() => opensandbox({ typo: 1 }), /`typo`/);
  // The supported spelling still constructs.
  assert.doesNotThrow(() => opensandbox({ networkPolicy: "deny-all" }));
});

test("an unrepresentable policy fails at construction, not at the first turn", async (t) => {
  t.after(restoreStatics);
  assert.throws(
    () => opensandbox({ networkPolicy: { subnets: { deny: ["169.254.169.254/32"] } } }),
    /subnets/,
  );
});

test("networkPolicy reaches Sandbox.create", async (t) => {
  t.after(restoreStatics);
  let createOptions;
  const fake = fakeSandbox({ run: async () => execution({}) });
  sdk.Sandbox.create = async (options) => {
    createOptions = options;
    return fake.sandbox;
  };

  await opensandbox({ networkPolicy: { allow: ["github.com"] } }).create({
    templateKey: null,
    sessionKey: "session-under-test",
    runtimeContext: { appRoot: "/tmp/app" },
  });

  assert.deepEqual(createOptions.networkPolicy, {
    defaultAction: "deny",
    egress: [{ action: "allow", target: "github.com" }],
  });
});

test("a backend with no networkPolicy sends the request it always sent", async (t) => {
  t.after(restoreStatics);
  let createOptions;
  const fake = fakeSandbox({ run: async () => execution({}) });
  sdk.Sandbox.create = async (options) => {
    createOptions = options;
    return fake.sandbox;
  };

  await opensandbox().create({
    templateKey: null,
    sessionKey: "session-under-test",
    runtimeContext: { appRoot: "/tmp/app" },
  });

  assert.deepEqual(createOptions, { image: "ubuntu" });
});

test("captureState persists the policy the sandbox was created under", async (t) => {
  t.after(restoreStatics);
  const fake = fakeSandbox({ run: async () => execution({}) });
  const handle = await createSession(fake, { backend: opensandbox({ networkPolicy: "deny-all" }) });

  const state = await handle.captureState();
  assert.equal(state.metadata.sandboxId, "sbx-1");
  assert.equal(state.metadata.networkPolicyKey, "deny|");
});

test("reattach refuses a sandbox created under a different network policy", async (t) => {
  t.after(restoreStatics);
  const fake = fakeSandbox({ run: async () => execution({}) });
  let paused = 0;
  fake.sandbox.pause = async () => {
    paused += 1;
  };
  sdk.Sandbox.create = async () => fake.sandbox;
  sdk.Sandbox.connect = async () => fake.sandbox;

  // OpenSandbox fixes egress at creation, so this sandbox cannot be brought up
  // to the new policy. Handing it back would run the agent with open egress
  // while the source says deny-all.
  await assert.rejects(
    () =>
      opensandbox({ networkPolicy: "deny-all" }).create({
        templateKey: null,
        sessionKey: "session-under-test",
        existingMetadata: { sandboxId: "sbx-1", networkPolicyKey: "unset" },
        runtimeContext: { appRoot: "/tmp/app" },
      }),
    /network policy/,
  );
  // The refusal now happens after the reconnect ladder, so a sandbox has been
  // woken by the time we decide not to use it. Nothing else will pause it —
  // create() threw, so there is no handle and no shutdown().
  assert.equal(paused, 1, "a recovered-then-refused sandbox must not be left running");
});

test("a reaped sandbox plus a new network policy creates one, it does not deadlock", async (t) => {
  t.after(restoreStatics);
  const fake = fakeSandbox({ id: "sbx-fresh", run: async () => execution({}) });
  let creates = 0;
  let createOptions;
  sdk.Sandbox.create = async (options) => {
    creates += 1;
    createOptions = options;
    return fake.sandbox;
  };
  const gone = async () => {
    throw new Error("404 sandbox not found");
  };
  sdk.Sandbox.connect = gone;
  sdk.Sandbox.resume = gone;

  // The guard used to run BEFORE the reconnect ladder, on the strength of the
  // persisted id alone. So a session whose sandbox had been reaped upstream —
  // nothing to reattach to, nothing to protect — threw on every turn, for ever,
  // because the metadata that triggers it is the metadata eve keeps handing
  // back. Reproduced on that build: `Sandbox.create calls: 0`.
  const handle = await opensandbox({ networkPolicy: "deny-all" }).create({
    templateKey: null,
    sessionKey: "session-under-test",
    existingMetadata: { sandboxId: "sbx-reaped", networkPolicyKey: "unset" },
    runtimeContext: { appRoot: "/tmp/app" },
  });

  assert.equal(creates, 1, "a gone sandbox must fall through to create()");
  assert.equal(handle.session.id, "sbx-fresh");
  // ...and the fresh one is built under the NEW policy, which is what the
  // operator asked for and the reason refusing here protected nothing.
  assert.deepEqual(createOptions.networkPolicy, { defaultAction: "deny", egress: [] });
  assert.equal((await handle.captureState()).metadata.networkPolicyKey, "deny|");
});

test("adding an explicit allow-all does not brick a live session", async (t) => {
  t.after(restoreStatics);
  const fake = fakeSandbox({ id: "sbx-live", run: async () => execution({}) });
  let connectedTo;
  sdk.Sandbox.connect = async ({ sandboxId }) => {
    connectedTo = sandboxId;
    return fake.sandbox;
  };
  sdk.Sandbox.create = async () => {
    throw new Error("must not create a fresh sandbox for a reattachable session");
  };

  // `networkPolicy: "allow-all"` is a no-op on the wire — a sandbox created
  // without a policy is already allow-all ("passing an empty object or null
  // results in allow-all behavior at startup", the SDK's own NetworkPolicy
  // schema). The keys still differ as strings ("unset" vs "allow|"), and
  // comparing them as strings made writing that option down refuse to reattach
  // to every session that existed. Reproduced on the previous build, in both
  // directions.
  const added = await opensandbox({ networkPolicy: "allow-all" }).create({
    templateKey: null,
    sessionKey: "session-under-test",
    existingMetadata: { sandboxId: "sbx-live", networkPolicyKey: "unset" },
    runtimeContext: { appRoot: "/tmp/app" },
  });
  assert.equal(connectedTo, "sbx-live");
  assert.equal(added.session.id, "sbx-live");

  // ...and taking it away again, which is the same no-op in reverse.
  const removed = await opensandbox().create({
    templateKey: null,
    sessionKey: "session-under-test",
    existingMetadata: { sandboxId: "sbx-live", networkPolicyKey: "allow|" },
    runtimeContext: { appRoot: "/tmp/app" },
  });
  assert.equal(removed.session.id, "sbx-live");
});

test("reattach still works for a session persisted before the option existed", async (t) => {
  t.after(restoreStatics);
  const fake = fakeSandbox({ id: "sbx-old", run: async () => execution({}) });
  let connectedTo;
  sdk.Sandbox.connect = async ({ sandboxId }) => {
    connectedTo = sandboxId;
    return fake.sandbox;
  };
  sdk.Sandbox.create = async () => {
    throw new Error("must not create a fresh sandbox for a reattachable session");
  };

  const handle = await opensandbox().create({
    templateKey: null,
    sessionKey: "session-under-test",
    // No networkPolicyKey at all, which is every session written by 0.3.0.
    existingMetadata: { sandboxId: "sbx-old" },
    runtimeContext: { appRoot: "/tmp/app" },
  });

  assert.equal(connectedTo, "sbx-old");
  assert.equal(handle.session.id, "sbx-old");
});
