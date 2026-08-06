#!/usr/bin/env node
/**
 * Builds a deliberately-broken copy of the agent, so the deny gate can be proven
 * capable of failing.
 *
 * ── Why ──────────────────────────────────────────────────────────────────────
 *
 * `evals/deny-survives.eval.ts` guards the worst bug this project has shipped a
 * fix for: before the `surviveDeniedToolResults` middleware, answering "no" to a
 * gated tool call ended the durable session permanently. The eval passing is
 * meant to mean "that fix still works".
 *
 * It does not mean that on its own. The eval has a documented vacuous failure
 * mode — the model answers in prose, never calls the gated tool, and the test
 * never reaches its subject — and the inverse is just as possible: a change to
 * the harness, the prompt, or eve's event vocabulary could leave the eval
 * passing without ever exercising the denial. A green gate that cannot go red is
 * not evidence; it is decoration. This repository has already shipped one of
 * those (a QA check that asserted nothing), which is why the contract suite is
 * pointed at eve 0.29.5 to prove it still catches the auth bypass.
 *
 * This is the same idea for the runtime tier: take the real template, remove the
 * one line that fixes the bug, and require the eval to fail against it. If it
 * passes, the eval is not testing what its name says.
 *
 * ── What it removes, and why only this ───────────────────────────────────────
 *
 * Exactly one edit: `wrapLanguageModel(...)` is replaced with the bare model, so
 * denied tool results reach the provider in the shape eve records them —
 * `output.type = "execution-denied"`, which @ai-sdk/openai cannot map, producing
 * `output: undefined` and an OpenAI 400 on the next turn. That is the original
 * bug, reproduced by subtraction rather than by simulation. Nothing else is
 * touched, so a failure cannot be blamed on the sabotage having broken
 * something unrelated.
 *
 * Usage:
 *   node contract/runtime/negative-control.mjs <destination>
 *
 * Prints the destination on success. Exits non-zero if the line it expects to
 * remove is not there — which is itself worth failing on, because it means the
 * fix moved and this control is no longer removing it.
 */
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../lib/repo.mjs";

const TEMPLATE = join(REPO_ROOT, "templates", "default");

const FIXED = "const model = wrapLanguageModel({ model: baseModel, middleware: surviveDeniedToolResults });";
const SABOTAGED = `// NEGATIVE CONTROL: the middleware is deliberately bypassed here, so a denied
// tool result reaches the provider in the shape eve records it. If the deny
// eval still passes against this build, the eval is not testing what it claims.
const model = baseModel;`;

const destination = process.argv[2];
if (!destination) {
  process.stderr.write("usage: node contract/runtime/negative-control.mjs <destination>\n");
  process.exit(2);
}

if (!existsSync(TEMPLATE)) {
  process.stderr.write(`${TEMPLATE} does not exist — run this from an evestack checkout.\n`);
  process.exit(2);
}

rmSync(destination, { recursive: true, force: true });
cpSync(TEMPLATE, destination, {
  recursive: true,
  // node_modules and eve's dev-runtime snapshots are large and are rebuilt in
  // the copy anyway; .eve in particular carries workflow state from previous
  // runs, and copying it would re-enqueue someone else's sessions.
  filter: (src) => !/[/\\](node_modules|\.eve|\.next|dist)([/\\]|$)/.test(src),
});

/**
 * `workspace:*` only resolves for a package that is a member of the pnpm
 * workspace, and the whole point of this copy is that it is not one — it lives
 * outside the repo so a sabotaged agent can never be mistaken for the real
 * template. The first version ignored that and died on install:
 *
 *   ERR_PNPM_WORKSPACE_PKG_NOT_FOUND  "@evestack/budget@workspace:*" is in the
 *   dependencies but no package named "@evestack/budget" is present
 *
 * `link:` points at the same directories the workspace protocol would have
 * resolved to, without requiring membership. Absolute, because the copy is not
 * at a fixed depth relative to the repo.
 */
const manifestPath = join(destination, "package.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const linked = [];
for (const field of ["dependencies", "devDependencies"]) {
  for (const [name, range] of Object.entries(manifest[field] ?? {})) {
    if (typeof range !== "string" || !range.startsWith("workspace:")) continue;
    // Directory names do not match scoped package names (@evestack/budget lives
    // in packages/evestack-budget), so the location is read from the workspace
    // rather than derived from the name.
    const dir = readdirSync(join(REPO_ROOT, "packages")).find((d) => {
      const file = join(REPO_ROOT, "packages", d, "package.json");
      if (!existsSync(file)) return false;
      return JSON.parse(readFileSync(file, "utf8")).name === name;
    });
    if (dir === undefined) {
      process.stderr.write(`negative-control: ${name} is declared workspace:* but is not in packages/\n`);
      process.exit(1);
    }
    manifest[field][name] = `link:${join(REPO_ROOT, "packages", dir)}`;
    linked.push(name);
  }
}
if (linked.length > 0) {
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stderr.write(`negative-control: linked ${linked.join(", ")} out of the workspace\n`);
}

const agentPath = join(destination, "agent", "agent.ts");
const source = readFileSync(agentPath, "utf8");

if (!source.includes(FIXED)) {
  process.stderr.write(
    "negative-control: could not find the line it exists to remove:\n" +
      `  ${FIXED}\n\n` +
      "The deny-path fix has moved or been rewritten. Update this file to remove whatever\n" +
      "now applies the middleware — a negative control that silently sabotages nothing is\n" +
      "worse than none, because the eval will pass against it and that will read as proof.\n",
  );
  process.exit(1);
}

writeFileSync(agentPath, source.replace(FIXED, SABOTAGED));
process.stdout.write(`${destination}\n`);
