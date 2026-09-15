/**
 * The one credential this wizard does not write down.
 *
 * Every other provider ends with a line in .env.local. A ChatGPT plan ends with
 * a browser tab and a refresh token in the OS secret store, which means the
 * wizard has to drive eve's own sign-in — and it reaches it by FILE PATH into
 * the scaffold's node_modules, because eve exports the model (`chatgpt()`, from
 * `eve/models/openai`) and not the flow that authenticates it.
 *
 * That path is the fragile part, and it is fragile in a quiet way: if eve moves
 * the module, nothing throws, nothing fails to install, and the scaffold simply
 * stops offering to sign anyone in — the easiest option on the list degrades
 * into a sentence of homework, and no test would have noticed. So the first
 * test here is not about behaviour at all. It reads the real installed eve and
 * asserts the module is where create.mjs says it is.
 *
 * The rest pin the property that matters more than the sign-in succeeding: this
 * step can NEVER take the scaffold down with it. A project with everything
 * written, installed and running is a good outcome even when the sign-in did
 * not happen — the model is one command away and the command is printed.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { signInToChatGpt } from "../create.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");

test("eve still keeps its ChatGPT sign-in where the wizard looks for it", { skip: skipWithoutEve() }, async () => {
  // The canary. `templates/default` is the same tree the scaffold is copied
  // from and it installs the same eve, so its node_modules is the honest
  // stand-in for a freshly scaffolded project.
  //
  // If this fails, nothing is broken yet — the fallback below already handles a
  // missing module. What has happened is that the wizard has silently stopped
  // being able to sign anyone in, and the fix is to find the module's new home
  // and update CHATGPT_AUTH_PATH in create.mjs.
  const target = join(repo, "templates", "default");
  const result = await signInToChatGpt({
    target,
    // Not the real import: this asserts the path resolves to eve's module, not
    // that a browser opens. Calling `ensureChatGptAuth` here would start an
    // OAuth listener on :1455 and read the OS keychain, from a unit test.
    importer: async (url) => {
      assert.match(url, /node_modules\/eve\/.*chatgpt-auth\.js$/, url);
      assert.ok(existsSync(fileURLToPath(url)), `eve no longer has ${url}`);
      return { ensureChatGptAuth: async () => {} };
    },
  });

  assert.equal(result.state, "ready");
});

test("an eve that moved its sign-in costs a sentence, not the scaffold", async () => {
  const result = await signInToChatGpt({
    target: join(repo, "no", "such", "project"),
    importer: () => { throw new Error("ERR_MODULE_NOT_FOUND"); },
  });

  assert.equal(result.state, "skipped");
  // The recovery is the same for every ending here, and it has to be, because
  // the reader cannot tell these endings apart and does not need to.
  assert.match(result.command, /\/model/);
});

test("a module that resolves to something else is not called", async () => {
  // A path that still exists but no longer exports the flow. Reaching into
  // another package's internals means this is a real possibility, and calling
  // `undefined()` would throw from inside a scaffold that was otherwise done.
  const result = await signInToChatGpt({
    target: join(repo, "templates", "default"),
    importer: async () => ({ ensureChatGptAuth: "no longer a function" }),
  });

  assert.equal(result.state, "skipped");
});

test("--yes does not open a browser nobody asked for", async () => {
  let imported = false;
  const result = await signInToChatGpt({
    target: join(repo, "templates", "default"),
    nonInteractive: true,
    importer: async () => { imported = true; return {}; },
  });

  assert.equal(imported, false, "CI has no browser and no one to look at it");
  assert.equal(result.state, "skipped");
  assert.match(result.command, /\/model/);
});

test("a sign-in that fails is reported with its reason, and is not thrown", async () => {
  const result = await signInToChatGpt({
    target: join(repo, "templates", "default"),
    importer: async () => ({
      ensureChatGptAuth: async () => { throw new Error("ChatGPT sign-in timed out."); },
    }),
  });

  assert.equal(result.state, "failed");
  assert.match(result.why, /timed out/);
  assert.match(result.command, /\/model/);
});

/**
 * eve is a workspace dependency of the template, so a checkout that has not
 * installed yet has no node_modules to read. Skipping beats failing: the canary
 * is about eve MOVING the module, and "not installed" is not that.
 */
function skipWithoutEve() {
  const installed = existsSync(join(repo, "templates", "default", "node_modules", "eve"));
  return installed ? false : "templates/default has no node_modules — run pnpm install";
}
