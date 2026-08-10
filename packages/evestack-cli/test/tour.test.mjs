/**
 * The tour talks to a real agent over two routes, and one of them is a stream.
 *
 * Driving the real thing needs Docker, Postgres, a booted agent and a model key
 * — which is to say it needs the tour to already work — so the parser is tested
 * here against a stub that speaks the shapes eve's compiled channel actually
 * emits:
 *
 *   POST /eve/v1/session            202 { ok, sessionId, continuationToken }
 *   GET  /eve/v1/session/:id/stream NDJSON { type, data }
 *
 * with `message.appended` carrying `data.messageDelta`, `message.completed`
 * carrying the whole `data.message`, and turn.completed / turn.failed ending it.
 * If eve renames one of those, this is where it should go red.
 */
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { startSession, streamReply, tour } from "../src/tour.mjs";

/** Collects what the tour would have printed. */
function sink() {
  const chunks = [];
  return { write: (s) => chunks.push(s), get text() { return chunks.join(""); } };
}

const noEnv = () => undefined;

/** A stub agent. `events` are written to the stream route, one JSON per line. */
async function withAgent(events, run, { status = 202, body } = {}) {
  const seen = { authorization: null, message: null };
  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/eve/v1/session") {
      seen.authorization = req.headers.authorization ?? null;
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        seen.message = JSON.parse(raw || "{}").message ?? null;
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body ?? { ok: true, sessionId: "sess_123", continuationToken: "eve:abc" }));
      });
      return;
    }
    if (req.url?.startsWith("/eve/v1/session/") && req.url.endsWith("/stream")) {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      // Deliberately not one line per write: the parser has to reassemble
      // events split across chunk boundaries, which is the normal case on a
      // real socket and the thing a naive split("\n") gets wrong.
      const payload = events.map((e) => `${JSON.stringify(e)}\n`).join("");
      res.write(payload.slice(0, 7));
      res.write(payload.slice(7));
      res.end();
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await run(base, seen);
  } finally {
    server.close();
  }
}

test("assembles the reply from message.appended deltas", async () => {
  const events = [
    { type: "session.created", data: {} },
    { type: "turn.started", data: {} },
    { type: "message.appended", data: { messageDelta: "Postgres ", sequence: 1 } },
    { type: "message.appended", data: { messageDelta: "on your ", sequence: 2 } },
    { type: "message.appended", data: { messageDelta: "own machine.", sequence: 3 } },
    { type: "message.completed", data: { message: "Postgres on your own machine.", finishReason: "stop" } },
    { type: "turn.completed", data: {} },
  ];
  await withAgent(events, async (base) => {
    const out = sink();
    const reply = await streamReply(base, "sess_123", noEnv, out);
    assert.equal(reply.text, "Postgres on your own machine.");
    assert.equal(reply.failed, null);
    assert.match(out.text, /Postgres on your own machine\./);
  });
});

test("a failed turn is reported, not swallowed", async () => {
  const events = [
    { type: "turn.started", data: {} },
    { type: "message.appended", data: { messageDelta: "thinking" } },
    { type: "turn.failed", data: { error: { message: "MODEL_CALL_FAILED" } } },
  ];
  await withAgent(events, async (base) => {
    const reply = await streamReply(base, "sess_123", noEnv, sink());
    assert.equal(reply.failed, "MODEL_CALL_FAILED");
  });
});

test("an unknown event type is ignored rather than thrown on", async () => {
  // eve's event vocabulary moves upstream. A tour that dies on a name it has
  // not seen is worse than one that prints slightly less.
  const events = [
    { type: "some.future.event", data: { whatever: true } },
    { type: "message.appended", data: { messageDelta: "ok" } },
    { type: "turn.completed", data: {} },
  ];
  await withAgent(events, async (base) => {
    const reply = await streamReply(base, "sess_123", noEnv, sink());
    assert.equal(reply.text, "ok");
    assert.equal(reply.failed, null);
  });
});

test("a stream that cannot be reached degrades instead of throwing", async () => {
  // Nothing is listening on this port. The reply is in the dashboard either way.
  const reply = await streamReply("http://127.0.0.1:1", "sess_123", noEnv, sink());
  assert.equal(reply.text, "");
  assert.equal(reply.failed, null);
});

test("startSession sends the message and returns the session id", async () => {
  await withAgent([], async (base, seen) => {
    const session = await startSession(base, "hello there", noEnv);
    assert.equal(session.sessionId, "sess_123");
    assert.equal(seen.message, "hello there");
    assert.equal(seen.authorization, null, "no credentials configured means no header");
  });
});

test("basic credentials are sent when the project has them", async () => {
  // A built server refuses loopback too — from eve 0.30 localDev() grants only
  // inside `eve dev` — so the tour must carry the project's Basic credentials.
  const env = (key) => ({ EVESTACK_AUTH_USER: "evestack", EVESTACK_AUTH_PASSWORD: "s3cret" })[key];
  await withAgent([], async (base, seen) => {
    await startSession(base, "hi", env);
    assert.equal(seen.authorization, `Basic ${Buffer.from("evestack:s3cret").toString("base64")}`);
  });
});

test("a 401 names the credentials rather than the status code", async () => {
  await withAgent([], async (base) => {
    await assert.rejects(
      () => startSession(base, "hi", noEnv),
      /401 .* EVESTACK_AUTH_\* in \.env\.local/s,
    );
  }, { status: 401, body: { ok: false, error: "Unauthorized" } });
});

/**
 * Not a terminal is not consent.
 *
 * `yes` was `--yes || -y || !process.stdin.isTTY`, so CI, a pipe, or
 * `evestack tour < /dev/null` skipped the "Send it?" gate and billed a real
 * model call nobody approved — and `confirm()` returned true off a TTY as well,
 * so removing either bypass alone would have left the other. Exit 3 is the
 * whole signal here: nothing is broken, the command declined to spend money.
 */
test("off a TTY the tour refuses to send rather than assuming yes", async () => {
  // A real project directory, because the not-a-project check runs first and
  // correctly returns 2 before any of this is reached. `.env.local` is the
  // marker findProjectEnv looks for.
  const dir = mkdtempSync(join(tmpdir(), "evestack-tour-"));
  writeFileSync(join(dir, ".env.local"), "EVESTACK_AGENT_PORT=2000\n");
  const cwd = process.cwd();
  const stdin = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
  process.chdir(dir);
  try {
    const err = sink();
    const code = await tour([], { stdout: sink(), stderr: err });
    assert.equal(code, 3, "a refusal to spend is not exit 0, and not exit 1 either");
    assert.match(err.text, /--yes/, "must name the flag that grants consent");
    assert.match(err.text, /real model call/i, "must say why it stopped");
  } finally {
    process.chdir(cwd);
    if (stdin) Object.defineProperty(process.stdin, "isTTY", stdin);
    rmSync(dir, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------------- */
/* what it costs                                                              */
/* -------------------------------------------------------------------------- */

/**
 * A server that answers nothing and counts what it was asked for.
 *
 * The tests below assert an absence, and an absence is the easiest thing in
 * the world to assert vacuously: a tour pointed at a port nobody is listening
 * on also sends no billable turn. So the port is real, something is listening,
 * and the count is read out of it.
 */
async function withCountingAgent(run, { answerHealth = false } = {}) {
  const seen = { health: 0, sessions: 0, streams: 0, paths: [] };
  const server = createServer((req, res) => {
    seen.paths.push(`${req.method} ${req.url}`);
    if (req.url === "/eve/v1/health") {
      seen.health += 1;
      // Dropped rather than answered. The fixture's own line above is "a
      // server that answers nothing", and a 503 is not nothing — status now
      // tells a socket that replied apart from one that did not, and reports
      // the first as "something answered 503 here". The request is still
      // counted, so the assertions below are as strong as they were.
      if (!answerHealth) return void res.destroy();
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ ok: true, status: "ready" }));
    }
    if (req.method === "POST" && req.url === "/eve/v1/session") {
      seen.sessions += 1;
      res.writeHead(202, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ ok: true, sessionId: "sess_billed" }));
    }
    if (req.url?.includes("/stream")) seen.streams += 1;
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    return await run(port, seen);
  } finally {
    server.close();
  }
}


/**
 * The tour prints its report through create-evestack/ui, which writes to the
 * real process.stdout rather than to the injected stream. The injected one
 * carries only the usage text and the refusal. Both are worth reading, so this
 * captures the real one too; a test that asserted on the sink alone would be
 * asserting on an empty string and passing for the wrong reason.
 *
 * ─ Why it separates the writes by async context instead of eating them ─
 *
 * `node --test` runs this file in a child process and the runner reports what
 * happened by WRITING IT TO THAT CHILD'S STDOUT. A capture that replaces
 * `process.stdout.write` and returns `true` without forwarding therefore eats
 * the runner's own result lines for every test that finishes while the capture
 * is installed. Measured on this file before the fix: 14 top-level tests
 * declared, `tests 9` reported, and the missing five included whichever ones
 * happened to complete inside the window. A failure in one of them still turned
 * the file red — as a bare `not ok` with no name and no assertion message,
 * which is the worst possible way to learn a test broke.
 *
 * So the interceptor keeps only what `run` printed. `AsyncLocalStorage`
 * propagates through the awaits inside `run`, and the runner's reporting
 * happens in its own context, so "did the code under test write this?" is a
 * question that can be asked rather than guessed. Anything that is not ours is
 * forwarded to the real stream untouched, which also means a write this cannot
 * attribute shows up on the console instead of vanishing — the failure lands
 * where someone will see it.
 */
const capturedWrites = new AsyncLocalStorage();

async function captureStdout(run) {
  const original = process.stdout.write.bind(process.stdout);
  // A fresh token per call, so a nested capture cannot claim the outer one's
  // writes and a stale context cannot claim anything.
  const mine = Symbol("captureStdout");
  let text = "";
  process.stdout.write = (chunk, ...rest) => {
    if (capturedWrites.getStore() !== mine) return original(chunk, ...rest);
    text += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  };
  try {
    await capturedWrites.run(mine, run);
  } finally {
    process.stdout.write = original;
  }
  return text;
}

/** A project directory pointed at `port`, plus the chdir/TTY dance. */
async function inProject(port, { stdinTty, extraEnv = "" }, run) {
  const dir = mkdtempSync(join(tmpdir(), "evestack-tour-"));
  writeFileSync(join(dir, ".env.local"), `EVESTACK_AGENT_PORT=${port}\n${extraEnv}`);
  const cwd = process.cwd();
  const stdin = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const stdout = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value: stdinTty, configurable: true });
  // Never a TTY on stdout in a test: it makes --no-open default on, so nothing
  // below can launch a browser on the machine running the suite.
  Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
  try {
    process.chdir(dir);
    return await run(dir);
  } finally {
    process.chdir(cwd);
    if (stdin) Object.defineProperty(process.stdin, "isTTY", stdin);
    if (stdout) Object.defineProperty(process.stdout, "isTTY", stdout);
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The regression this file exists for.
 *
 * 920a439 is titled "tour billed without asking". Exit 3 is already covered
 * above, and exit 3 is the symptom rather than the harm: what actually went
 * wrong is that a provider got called. So this one asserts the harm directly,
 * against a listening agent that would have answered 202 to a session POST.
 */
test("off a TTY the tour reaches no provider at all, not merely exits 3", async () => {
  await withCountingAgent(async (port, seen) => {
    await inProject(port, { stdinTty: false }, async () => {
      const code = await tour([], { stdout: sink(), stderr: sink() });
      assert.equal(code, 3);
    });
    assert.equal(seen.sessions, 0, "no session was started, so no turn was billed");
    assert.equal(seen.streams, 0, "and nothing streamed a reply back");
    // Stronger than the two above together: the consent gate is ahead of the
    // stack check, so a refused tour does not even look at the agent. If a
    // future refactor moves the gate after probeAll this goes red, which is
    // the warning worth having.
    assert.deepEqual(seen.paths, [], `the tour called the agent: ${seen.paths.join(", ")}`);
  });
});

test("--yes is consent to spend, but a stack that is down still stops first", async () => {
  await withCountingAgent(
    async (port, seen) => {
      await inProject(port, { stdinTty: false }, async () => {
        let code;
        const printed = await captureStdout(async () => {
          code = await tour(["--yes"], { stdout: sink(), stderr: sink() });
        });
        assert.equal(code, 1, "a down stack is exit 1, not a refusal and not a success");
        assert.match(printed, /agent/i, "and it says which part is not answering");
        assert.match(printed, /not answering/i, "in words, not as a status code");
      });
      assert.equal(
        seen.sessions,
        0,
        "--yes authorises one message, it does not authorise sending it into a broken stack",
      );
      assert.ok(seen.health > 0, "the stack check really ran, so this is not vacuous");
    },
    { answerHealth: false },
  );
});

test("-y is accepted as consent, so the documented short flag is real", async () => {
  await withCountingAgent(async (port) => {
    await inProject(port, { stdinTty: false }, async () => {
      const code = await tour(["-y"], { stdout: sink(), stderr: sink() });
      // Not 3. Exit 3 here would mean the short form documented in TOUR_USAGE
      // does not grant consent, so a caller following the help text gets a
      // refusal and no explanation.
      assert.notEqual(code, 3, "-y must grant consent exactly as --yes does");
    });
  });
});

test("--help states the cost before anything happens, and calls nothing", async () => {
  const { TOUR_USAGE } = await import("../src/tour.mjs");
  await withCountingAgent(async (port, seen) => {
    await inProject(port, { stdinTty: false }, async () => {
      const stdout = sink();
      const code = await tour(["--help"], { stdout, stderr: sink() });
      assert.equal(code, 0);
      assert.equal(stdout.text, TOUR_USAGE, "--help prints the usage and nothing else");
    });
    assert.deepEqual(seen.paths, [], "--help is not a dry run of the tour, it is text");
  });

  // The claim under test is not that a flag exists. It is that someone reading
  // the help learns it will spend money BEFORE they run it.
  assert.match(TOUR_USAGE, /real model call/i, "the help must say a real model call happens");
  assert.match(TOUR_USAGE, /asks before sending/i, "and that consent is asked for");
  assert.match(TOUR_USAGE, /--yes/, "and name the flag that skips the question");
  assert.match(TOUR_USAGE, /exits 3|exit 3|  3  /i, "and document the refusal code");
});

/**
 * The other half of the claim: the tour is supposed to teach the product, not
 * just prove the stack is up. If it stops naming the four things that make
 * evestack worth running over plain eve, it has become a health check with a
 * model call attached, which is strictly worse than a health check.
 */
test("the tour teaches the product it is a tour of", async () => {
  const { TOUR_USAGE } = await import("../src/tour.mjs");
  assert.match(TOUR_USAGE, /dashboard/i, "the dashboard is the thing plain eve does not have");
  assert.match(TOUR_USAGE, /four steps/i, "and the shape is stated up front");

  await withCountingAgent(async (port) => {
    await inProject(port, { stdinTty: false }, async () => {
      const printed = await captureStdout(async () => {
        await tour(["--yes"], { stdout: sink(), stderr: sink() });
      });
      // Printed before the stack check, so a down stack still shows the plan.
      for (const word of ["the stack", "a turn", "where it went", "what is next"]) {
        assert.match(printed, new RegExp(word, "i"), `step "${word}" is missing`);
      }
    });
  });
});

test("outside a project it exits 2 without touching an agent", async () => {
  await withCountingAgent(async (port, seen) => {
    const dir = mkdtempSync(join(tmpdir(), "evestack-not-a-project-"));
    const cwd = process.cwd();
    try {
      process.chdir(dir);
      const code = await tour(["--yes"], { stdout: sink(), stderr: sink() });
      assert.equal(code, 2, "not an evestack project is its own exit code");
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
    assert.deepEqual(seen.paths, [], `nothing should have been called: ${seen.paths.join(", ")}`);
    void port;
  });
});


/**
 * The capture helper, tested, because the version of it that was here quietly
 * cost this file five of its own results.
 *
 * The bug it pins is not "the assertions were wrong". Every assertion above
 * passed the whole time. What broke was the REPORT: `node --test` counted 9 of
 * 14, and the five it lost were the ones whose result lines happened to be
 * flushed while a capture was installed. A suite that under-reports itself is a
 * suite nobody can trust to have run, so the split it now makes — ours versus
 * the runner's — is worth a test of its own rather than a comment.
 */
test("captureStdout keeps what the tour printed and forwards what it did not", async () => {
  const real = process.stdout.write;
  let forwarded = "";
  // Swallows the two synthetic markers and forwards everything else, so this
  // test cannot reintroduce the very bug it is pinning.
  process.stdout.write = (chunk, ...rest) => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    if (text.includes("-LINE")) {
      forwarded += text;
      return true;
    }
    return real.call(process.stdout, chunk, ...rest);
  };
  let captured;
  try {
    // Registered OUTSIDE the capture, which is what makes it stand in for the
    // test runner: its callback runs during the capture window but was created
    // in a different async context, exactly as the reporter's writes are.
    const fromElsewhere = new Promise((resolve) => {
      setTimeout(() => {
        process.stdout.write("RUNNER-RESULT-LINE\n");
        resolve();
      }, 5);
    });
    captured = await captureStdout(async () => {
      process.stdout.write("TOUR-OUTPUT-LINE\n");
      await fromElsewhere;
    });
  } finally {
    process.stdout.write = real;
  }

  assert.match(captured, /TOUR-OUTPUT-LINE/, "the tour's own output is still captured");
  assert.doesNotMatch(captured, /RUNNER-RESULT-LINE/, "and nothing else is folded into it");
  assert.match(
    forwarded,
    /RUNNER-RESULT-LINE/,
    "a write from outside the capture reaches the real stream — this is the regression",
  );
  assert.doesNotMatch(forwarded, /TOUR-OUTPUT-LINE/, "and the captured output is not also printed");
});
