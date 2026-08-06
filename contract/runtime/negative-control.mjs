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
 * ── What it removes, and why it is no longer the middleware ──────────────────
 *
 * This first removed the `wrapLanguageModel(...)` call, so denied tool results
 * would reach the provider as `output.type = "execution-denied"` — the shape
 * @ai-sdk/openai v2 could not map, producing `output: undefined` and a 400 on
 * the next turn.
 *
 * That stopped working as a control on 2026-08-05, and the reason is worth
 * recording. Run against eve 0.30.8 with @ai-sdk/openai 4.0.30, the deny eval
 * passed 4 gates out of 4 **with the middleware removed** — and not vacuously:
 * `calledTool("forget", { status: "rejected" })` was among the gates that
 * passed, so the tool really was called, really was denied, and
 * `t.respondAll("deny")` really did replay that transcript to the provider.
 * The turn that used to kill the session completed normally.
 *
 * So on the current stack that bug is gone, and removing the fix for it no
 * longer produces a failure. A control has to sabotage something that is
 * actually broken, or it proves nothing.
 *
 * What it sabotages now is the approval gate itself: `approval: always()` is
 * removed from the `forget` tool, so the call never parks. The eval's very
 * first assertion is `turn1.parked()`, which then fails — proving the eval is
 * exercising the human-in-the-loop path rather than passing for some unrelated
 * reason. That is a narrower claim than the original, and it is the honest one:
 * it shows the eval reaches its subject, not that it would catch a
 * serialization regression that no longer exists here.
 *
 * The middleware is left in place in the real template. It is documented as
 * harmless once the provider maps the type correctly, `@evestack/*` peer ranges
 * still admit @ai-sdk/openai v2, and anyone on v2 still needs it.
 *
 * Usage:
 *   node contract/runtime/negative-control.mjs <destination>
 *
 * Prints the destination on success. Exits non-zero if the line it expects to
 * remove is not there — which is itself worth failing on, because it means the
 * thing being sabotaged moved and this control is no longer removing it.
 */
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../lib/repo.mjs";

const TEMPLATE = join(REPO_ROOT, "templates", "default");

/** Relative to the copied project. */
const TARGET_FILE = join("agent", "tools", "forget.ts");

const FIXED = "  approval: always(),";
const SABOTAGED = `  // NEGATIVE CONTROL: the approval gate is deliberately removed, so this tool
  // never parks for a human. The deny eval's first assertion is \`parked()\`, so
  // it MUST fail against this build. If it passes, the eval is not exercising
  // the human-in-the-loop path and nothing it reports about denial means
  // anything.`;

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

const targetPath = join(destination, TARGET_FILE);
const source = readFileSync(targetPath, "utf8");

if (!source.includes(FIXED)) {
  process.stderr.write(
    "negative-control: could not find the line it exists to remove:\n" +
      `  ${FIXED}\n\n` +
      `Looked in ${TARGET_FILE}. The approval gate has moved or been rewritten. Update this\n` +
      "file to remove whatever now gates the tool — a negative control that silently sabotages\n" +
      "nothing is worse than none, because the eval will pass against it and read as proof.\n",
  );
  process.exit(1);
}

writeFileSync(targetPath, source.replace(FIXED, SABOTAGED));
process.stdout.write(`${destination}\n`);
