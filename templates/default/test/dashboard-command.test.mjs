/**
 * `/dashboard`, from this side of the line.
 *
 * The command exists because eve's TUI slash-command list is a module constant
 * with no registration hook, and an unrecognised `/word` is forwarded as an
 * ordinary message. lib/dashboard-command.ts turns that into a real command
 * using the channel's documented pre-dispatch hook. What has to hold:
 *
 *   - a command is recognised and an ordinary message is not, because the hook
 *     runs on EVERY inbound message and a false positive eats someone's chat;
 *   - the browser is launched from the agent process, not promised to the model;
 *   - a dashboard that is down produces the instruction to start it rather than
 *     a window that lands on a connection error;
 *   - the port comes from the project's own recorded URL, since the scaffolder
 *     picks a free one and assuming 4000 is how you open another project's
 *     dashboard.
 *
 * `spawn` is stubbed rather than allowed to run: a test suite that opens five
 * browser windows is a test suite people stop running.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

/** Every argv `spawn()` was handed, in order. */
const SPAWNS = [];
globalThis.__evestackSpawns = SPAWNS;

const STUB = `data:text/javascript,${encodeURIComponent(
  "export function spawn(command, args) {\n" +
    "  globalThis.__evestackSpawns.push([command, args]);\n" +
    "  return { unref() {} };\n" +
    "}\n",
)}`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "node:child_process") return { url: STUB, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

// Dynamic, so the hook is installed before the module resolves its own imports.
const { handleSlashCommand, dashboardUrl } = await import("../lib/dashboard-command.ts");

/**
 * A module instance of its own.
 *
 * The reopen cooldown is module state, deliberately — it exists so a held Enter
 * key does not stack browser tabs. That makes any two tests which both expect to
 * open a window order-dependent: the first arms the cooldown and the second
 * silently observes it. A fresh instance per test is the fix that does not put a
 * reset hook into product code for a test's convenience. The resolve hook above
 * is registered process-wide, so each copy still gets the recording `spawn`.
 */
let instance = 0;
async function freshModule() {
  return import(`../lib/dashboard-command.ts?instance=${(instance += 1)}`);
}

/** Answer every health probe with `ok`, or refuse to connect. */
function withFetch(ok, body) {
  const before = globalThis.fetch;
  globalThis.fetch = async () => {
    if (!ok) throw new Error("ECONNREFUSED");
    return { ok: true };
  };
  return Promise.resolve(body()).finally(() => {
    globalThis.fetch = before;
  });
}

/** A fresh env that never opens a browser unless a test asks for one. */
function env(extra = {}) {
  return { EVESTACK_NO_BROWSER: "1", ...extra };
}

/* -------------------------------------------------------------------------- */
/* recognition                                                                 */
/* -------------------------------------------------------------------------- */

test("recognises the command, in both spellings and any case", async () => {
  for (const text of ["/dashboard", "/dash", "/Dashboard", "  /DASH  "]) {
    const result = await withFetch(true, () => handleSlashCommand(text, env()));
    assert.equal(result.handled, true, `${JSON.stringify(text)} should be a command`);
  }
});

test("an ordinary message is not a command, and costs no probe", async () => {
  // No fetch stub at all: a message that reaches the network here would throw,
  // which is exactly the regression worth catching — every chat message pays
  // this path.
  for (const text of [
    "what does /dashboard do?",
    "/dashboards",
    "/model",
    "dashboard",
    "",
    "   ",
  ]) {
    const result = await handleSlashCommand(text, env());
    assert.deepEqual(result, { handled: false }, `${JSON.stringify(text)} is conversation`);
  }
});

test("a single text part is a command; anything richer is conversation", async () => {
  const single = await withFetch(true, () =>
    handleSlashCommand([{ type: "text", text: "/dashboard" }], env()),
  );
  assert.equal(single.handled, true);

  // An attachment beside the word, or two parts, is a person talking.
  for (const message of [
    [{ type: "text", text: "/dashboard" }, { type: "file", url: "x" }],
    [{ type: "file", url: "x" }],
    [],
    null,
    undefined,
    42,
  ]) {
    const result = await handleSlashCommand(message, env());
    assert.equal(result.handled, false, `${JSON.stringify(message)} is not a command`);
  }
});

/* -------------------------------------------------------------------------- */
/* the action                                                                  */
/* -------------------------------------------------------------------------- */

test("launches the browser itself, rather than asking the model to", async () => {
  const fresh = await freshModule();
  SPAWNS.length = 0;
  const result = await withFetch(true, () =>
    // No EVESTACK_NO_BROWSER, and EVE_DEV marks an interactive dev process.
    fresh.handleSlashCommand("/dashboard", {
      EVE_DEV: "1",
      EVESTACK_DASHBOARD_URL: "http://localhost:4173/api/ingest/v1/traces",
    }),
  );
  assert.equal(result.handled, true);
  assert.equal(SPAWNS.length, 1, "the command did not open anything");
  assert.ok(
    SPAWNS[0][1].some((argument) => argument.includes("http://localhost:4173")),
    `the browser was pointed somewhere else: ${JSON.stringify(SPAWNS[0])}`,
  );
  assert.match(result.context[0], /Opening the evestack dashboard/);
});

test("repeats inside the cooldown do not open a second window", async () => {
  const fresh = await freshModule();
  SPAWNS.length = 0;
  const once = async () =>
    withFetch(true, () => fresh.handleSlashCommand("/dashboard", { EVE_DEV: "1" }));
  await once();
  await once();
  assert.equal(SPAWNS.length, 1, "a held Enter key should not stack browser tabs");
});

test("opens nothing when there is no screen to open it on", async () => {
  const fresh = await freshModule();
  SPAWNS.length = 0;
  // A service process: no TTY, no EVE_DEV. The command still answers.
  const result = await withFetch(true, () => fresh.handleSlashCommand("/dashboard", {}));
  const wouldHaveOpened = process.stdout.isTTY === true;
  if (!wouldHaveOpened) {
    assert.equal(SPAWNS.length, 0, "a headless agent must not spawn a browser");
    assert.match(result.context[0], /is running at/);
  }
  assert.equal(result.handled, true);
});

test("the explicit opt-out is honoured", async () => {
  const fresh = await freshModule();
  SPAWNS.length = 0;
  const result = await withFetch(true, () =>
    fresh.handleSlashCommand("/dashboard", { EVE_DEV: "1", EVESTACK_NO_BROWSER: "1" }),
  );
  assert.equal(SPAWNS.length, 0);
  assert.equal(result.handled, true);
  assert.match(result.context[0], /is running at/);
});

/* -------------------------------------------------------------------------- */
/* what it says                                                                */
/* -------------------------------------------------------------------------- */

test("a dashboard that is down gets the command to start it, and no window", async () => {
  const fresh = await freshModule();
  SPAWNS.length = 0;
  const result = await withFetch(false, () =>
    fresh.handleSlashCommand("/dashboard", { EVE_DEV: "1" }),
  );
  assert.equal(SPAWNS.length, 0, "opening a tab onto a refused connection helps nobody");
  assert.match(result.context[0], /docker compose --profile dashboard up -d/);
});

test("the reply is pinned to one line, so a command answers the same way twice", async () => {
  const result = await withFetch(true, () => handleSlashCommand("/dashboard", env()));
  assert.equal(result.context.length, 1);
  assert.match(result.context[0], /Reply with exactly this line and nothing else/);
  assert.equal(result.title, "/dashboard", "the session list should not fill with slash commands");
});

/* -------------------------------------------------------------------------- */
/* which dashboard                                                             */
/* -------------------------------------------------------------------------- */

test("the port comes from the project, not from a guess", () => {
  assert.equal(
    dashboardUrl({ EVESTACK_DASHBOARD_URL: "http://127.0.0.1:4173/api/ingest/v1/traces" }),
    "http://localhost:4173",
    "127.0.0.1 is rewritten because this string goes in front of a person",
  );
  assert.equal(dashboardUrl({}), "http://localhost:4000", "the documented default");
  assert.equal(
    dashboardUrl({ EVESTACK_DASHBOARD_URL: "not a url" }),
    "http://localhost:4000",
    "a malformed value is not worth failing a command over",
  );
});
