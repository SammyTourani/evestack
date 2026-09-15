/**
 * Two ways a scaffolded project could end up unauthenticated, and the checks
 * that now refuse to let it happen quietly.
 *
 *   1. EVE_DEV. eve's `localDev()` grants an unauthenticated principal on
 *      `EVE_DEV === "1"` alone — it is a flag, not a credential, and it does not
 *      care which command is running. `npm start` is
 *      `node --env-file-if-exists=.env.local scripts/start.mjs`, so every line
 *      of .env.local is in the environment before anything is spawned: one
 *      stray `EVE_DEV=1` left after a debugging session and the BUILT server,
 *      whose entire point is that eve fails closed on it, answers every route
 *      with no password. Nothing on screen says so, because a waved-through
 *      request and an authenticated one look identical from outside.
 *
 *   2. `EVESTACK_AUTH_PASSWORD=change-me`, which `.env.example` ships so the
 *      line has a shape, and which nothing anywhere refused. A scaffolded
 *      project never meets it — the wizard generates 24 random characters — but
 *      setting the project up by hand from the example is the documented path
 *      for a deployment, and it is the one that could reach production with a
 *      password printed in this repository.
 *
 * WHY THESE LIVE HERE rather than in templates/default/test/. The scripts under
 * test ship inside THIS package: `packages/create-evestack/template/` is
 * generated from `templates/default` at pack time, and this package's own
 * `package.json` exports `./template/scripts/checks.mjs` for exactly that
 * reason. Three sibling files here already import from that generated copy.
 *
 * This one imports from `templates/default` instead, because the generated copy
 * is a build artifact that is only refreshed by the pretest step, and a test
 * that reads it is testing whenever that step last ran rather than what is in
 * the tree. Skipped outside the monorepo, the way test/ui-sync.test.mjs is, for
 * the same reason: a published tarball has `template/` and no `templates/`.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, "..", "..", "..", "templates", "default", "scripts");
const IN_MONOREPO = existsSync(join(SCRIPTS, "checks.mjs"));
const skip = IN_MONOREPO ? false : "templates/default is not in a published tarball";

/**
 * The source-of-truth module, loaded only when the source tree is there.
 *
 * `pathToFileURL`, not the bare path. A dynamic `import()` takes a URL, and an
 * absolute POSIX path happens to work because `/a/b.mjs` resolves against this
 * file's own `file:` URL. A Windows one does not: `C:\...\checks.mjs` looks
 * like a URL whose scheme is `c:`, and Node rejects it outright with
 * ERR_UNSUPPORTED_ESM_URL_SCHEME. This file is largely about a Windows-shaped
 * failure and CI runs this package's suite on windows-latest, so importing in a
 * way that only works on the developer's machine would have made every
 * assertion here a macOS assertion.
 */
async function checks() {
  return import(pathToFileURL(join(SCRIPTS, "checks.mjs")).href);
}

/* -------------------------------------------------------------------------- */
/* EVE_DEV must not reach a built server                                       */
/* -------------------------------------------------------------------------- */

test("productionEnv removes the flag that turns off authentication", { skip }, async () => {
  const { productionEnv } = await checks();

  assert.equal(productionEnv({ EVE_DEV: "1" }).EVE_DEV, undefined);
  // Any value, not just "1". eve compares against "1", but a project whose file
  // says EVE_DEV=true is a project whose author meant the same thing, and
  // leaving it through would make the strip depend on eve's comparison staying
  // exactly as it is.
  assert.equal(productionEnv({ EVE_DEV: "true" }).EVE_DEV, undefined);

  // Everything else passes through: this removes one named variable, it does
  // not sanitise the environment.
  assert.equal(productionEnv({ EVE_DEV: "1", OPENAI_API_KEY: "sk-x" }).OPENAI_API_KEY, "sk-x");

  // NODE_ENV before the spread, so an orchestrator that sets it still wins.
  assert.equal(productionEnv({}).NODE_ENV, "production");
  assert.equal(productionEnv({ NODE_ENV: "staging" }).NODE_ENV, "staging");

  // The way back, for someone genuinely running a built server behind their own
  // front door. Named so it is obvious in a shell history what it turned on.
  const { ALLOW_DEV_GRANT_VAR } = await checks();
  assert.equal(ALLOW_DEV_GRANT_VAR, "EVESTACK_ALLOW_EVE_DEV");
  assert.equal(productionEnv({ EVE_DEV: "1", [ALLOW_DEV_GRANT_VAR]: "1" }).EVE_DEV, "1");
});

/**
 * A copy of the template's scripts with a fake `eve` under it, so `start.mjs`
 * can actually be run.
 *
 * `eveBinary` resolves `node_modules/.bin/eve` relative to the SCRIPT's own
 * location — `<root>/scripts/x.mjs` means `<root>` — so the copy is what makes
 * the stub reachable. Running the real `templates/default/scripts/start.mjs` in
 * place would find `templates/default/node_modules/.bin/eve` on a machine that
 * has installed the workspace and start a real agent.
 */
function projectWithStubEve() {
  const dir = mkdtempSync(join(tmpdir(), "evestack-start-"));
  mkdirSync(join(dir, "scripts"), { recursive: true });
  for (const name of ["start.mjs", "checks.mjs", "ui.mjs"]) {
    copyFileSync(join(SCRIPTS, name), join(dir, "scripts", name));
  }
  const bin = join(dir, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  // Reports the two variables under test and exits. `sh` rather than node so
  // nothing here depends on this project having any dependencies installed.
  writeFileSync(
    join(bin, "eve"),
    '#!/bin/sh\necho "EVE_DEV=${EVE_DEV-<unset>} NODE_ENV=${NODE_ENV-<unset>} ARGS=$*"\n',
  );
  chmodSync(join(bin, "eve"), 0o755);
  return dir;
}

test(
  "a stray EVE_DEV in the environment does not reach the built agent",
  { skip: skip || (process.platform === "win32" ? "the stub eve is a /bin/sh script" : false) },
  () => {
    const dir = projectWithStubEve();
    const result = spawnSync(process.execPath, [join(dir, "scripts", "start.mjs")], {
      cwd: dir,
      encoding: "utf8",
      // Exactly what `--env-file-if-exists=.env.local` would have produced from
      // a file with `EVE_DEV=1` in it, which is how this gets set in real life.
      env: { ...process.env, EVE_DEV: "1", EVESTACK_AGENT_PORT: "2043" },
    });

    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(
      result.stdout,
      /EVE_DEV=<unset>/,
      `the built agent inherited EVE_DEV, so localDev() would grant every request:\n${result.stdout}`,
    );
    // The rest of what start.mjs is for has to keep working, or this "fix"
    // would be a regression wearing a security label.
    assert.match(result.stdout, /NODE_ENV=production/);
    assert.match(result.stdout, /ARGS=start --port 2043/);
  },
);

test(
  "and the override really does put it back",
  { skip: skip || (process.platform === "win32" ? "the stub eve is a /bin/sh script" : false) },
  () => {
    const dir = projectWithStubEve();
    const result = spawnSync(process.execPath, [join(dir, "scripts", "start.mjs")], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, EVE_DEV: "1", EVESTACK_ALLOW_EVE_DEV: "1" },
    });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /EVE_DEV=1/);
  },
);

test("dev.mjs is deliberately left alone", { skip }, () => {
  // The grant is the intended behaviour under `eve dev`: it is a developer's
  // own machine, EVESTACK_AUTH_* is usually unset, and stripping it there would
  // break the ordinary loop to fix nothing. If someone ever "fixes" dev.mjs to
  // match start.mjs, this is the line that should make them explain why.
  const dev = readFileSync(join(SCRIPTS, "dev.mjs"), "utf8");
  assert.doesNotMatch(dev, /productionEnv/, "dev.mjs must keep its own development environment");
  assert.match(dev, /NODE_ENV: "development"/);
});

/* -------------------------------------------------------------------------- */
/* the password .env.example ships                                             */
/* -------------------------------------------------------------------------- */

test("the placeholder from .env.example is recognised, and a real password is not", { skip }, async () => {
  const { isPlaceholderAuthPassword, PLACEHOLDER_AUTH_PASSWORD, PLACEHOLDER_AUTH_FIX } = await checks();

  // The value, read out of the file that ships it, so this cannot drift into
  // testing a constant against itself.
  const example = join(SCRIPTS, "..", ".env.example");
  const shipped = /^EVESTACK_AUTH_PASSWORD=(.+)$/m.exec(readFileSync(example, "utf8"))?.[1];
  assert.equal(shipped, PLACEHOLDER_AUTH_PASSWORD, ".env.example and the check disagree about the placeholder");

  assert.equal(isPlaceholderAuthPassword("change-me"), true);
  // The same mistake, typed differently.
  assert.equal(isPlaceholderAuthPassword("  CHANGE-ME  "), true);
  // And not a heuristic: only the value this repository actually ships. A
  // general "does this look weak?" test would have false positives, and a
  // yellow line that is sometimes wrong is a yellow line people scroll past.
  for (const real of ["change-me-please", "hunter2", "", undefined, null, 42]) {
    assert.equal(isPlaceholderAuthPassword(real), false, JSON.stringify(real));
  }

  // The sentence both preflight and verify print, in one place so they cannot
  // describe one problem two ways.
  assert.match(PLACEHOLDER_AUTH_FIX, /EVESTACK_AUTH_PASSWORD/);
  assert.match(PLACEHOLDER_AUTH_FIX, /change-me/);
  assert.match(PLACEHOLDER_AUTH_FIX, /openssl rand/);
});

/**
 * `npm run dev` says so out loud, and still starts.
 *
 * A warning and not a refusal, deliberately: `eve dev` grants through
 * localDev() and never checks this value, so refusing here would break a
 * working single-user install to prevent a problem that only exists once that
 * install is built and served. It is checked FIRST, before the database branch,
 * because that branch returns early when WORKFLOW_POSTGRES_URL is unset — and a
 * project set up by hand from .env.example is exactly the one most likely to be
 * missing both lines.
 */
test("preflight warns about it before anything else can return early", { skip }, async () => {
  const { preflight } = await checks();

  const dir = mkdtempSync(join(tmpdir(), "evestack-preflight-"));
  writeFileSync(join(dir, ".env.local"), "EVESTACK_AUTH_PASSWORD=change-me\n");

  const cwd = process.cwd();
  const warn = console.warn;
  const saved = {
    password: process.env.EVESTACK_AUTH_PASSWORD,
    pg: process.env.WORKFLOW_POSTGRES_URL,
  };
  const said = [];
  try {
    // envValue reads the real environment first, so an ambient copy of either
    // would make this pass or fail for a reason that has nothing to do with the
    // file — which is the class of thing this check exists to catch.
    delete process.env.EVESTACK_AUTH_PASSWORD;
    delete process.env.WORKFLOW_POSTGRES_URL;
    console.warn = (...args) => said.push(args.join(" "));
    process.chdir(dir);
    // No database configured, so this returns after the two warnings and opens
    // no socket of any kind.
    await preflight({ label: "npm run dev" });
  } finally {
    process.chdir(cwd);
    console.warn = warn;
    if (saved.password === undefined) delete process.env.EVESTACK_AUTH_PASSWORD;
    else process.env.EVESTACK_AUTH_PASSWORD = saved.password;
    if (saved.pg === undefined) delete process.env.WORKFLOW_POSTGRES_URL;
    else process.env.WORKFLOW_POSTGRES_URL = saved.pg;
  }

  const text = said.join("\n");
  assert.match(text, /change-me/, `preflight said nothing about the placeholder:\n${text}`);
  assert.match(text, /EVESTACK_AUTH_PASSWORD/);
  // The database warning is still there, so the new check did not swallow the
  // one that was already correct.
  assert.match(text, /WORKFLOW_POSTGRES_URL is not set/);
});

test("a project with a real password gets no such line", { skip }, async () => {
  const { preflight } = await checks();

  const dir = mkdtempSync(join(tmpdir(), "evestack-preflight-ok-"));
  writeFileSync(join(dir, ".env.local"), "EVESTACK_AUTH_PASSWORD=NGYyM2QyZTYtY2I\n");

  const cwd = process.cwd();
  const warn = console.warn;
  const savedPg = process.env.WORKFLOW_POSTGRES_URL;
  const savedPassword = process.env.EVESTACK_AUTH_PASSWORD;
  const said = [];
  try {
    delete process.env.EVESTACK_AUTH_PASSWORD;
    delete process.env.WORKFLOW_POSTGRES_URL;
    console.warn = (...args) => said.push(args.join(" "));
    process.chdir(dir);
    await preflight({ label: "npm run dev" });
  } finally {
    process.chdir(cwd);
    console.warn = warn;
    if (savedPg === undefined) delete process.env.WORKFLOW_POSTGRES_URL;
    else process.env.WORKFLOW_POSTGRES_URL = savedPg;
    if (savedPassword === undefined) delete process.env.EVESTACK_AUTH_PASSWORD;
    else process.env.EVESTACK_AUTH_PASSWORD = savedPassword;
  }
  assert.doesNotMatch(said.join("\n"), /change-me/, "a correct project was scolded");
});

/* -------------------------------------------------------------------------- */
/* who may see a generated credential                                          */
/* -------------------------------------------------------------------------- */

test("showSecrets is the isTTY question, plus one named way back", { skip }, async () => {
  const { showSecrets } = await checks();
  const saved = process.env.EVESTACK_PRINT_SECRETS;
  try {
    delete process.env.EVESTACK_PRINT_SECRETS;
    assert.equal(showSecrets({ isTTY: true }), true);
    assert.equal(showSecrets({ isTTY: false }), false);
    // A stream that has no opinion is not a terminal. `undefined` must not be
    // truthy here: an unknown stream is the captured case, not the watched one.
    assert.equal(showSecrets({}), false);
    assert.equal(showSecrets(undefined), false);

    process.env.EVESTACK_PRINT_SECRETS = "1";
    assert.equal(showSecrets({ isTTY: false }), true, "the documented override does nothing");
  } finally {
    if (saved === undefined) delete process.env.EVESTACK_PRINT_SECRETS;
    else process.env.EVESTACK_PRINT_SECRETS = saved;
  }
});
