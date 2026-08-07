/**
 * The template filter, tested against the paths that broke it.
 *
 * The bug class, twice: a substring match against the ABSOLUTE path. In
 * `create.mjs` it meant `npx create-evestack` copied nothing, because npm stages
 * the package at ~/.npm/_npx/<hash>/node_modules/create-evestack/template and
 * every source path therefore contains "node_modules". That one was fixed. The
 * identical regex survived in scripts/sync-template.mjs, one step earlier in the
 * pipeline, where the excluded words are matched against the developer's own
 * checkout path — so a repo at ~/dist/evestack, ~/Projects/distro/evestack
 * ("dist" is a substring of "distro"), ~/work/distributed-systems/evestack, or
 * /Users/steve.everett/evestack (".eve") copied nothing at all. And because the
 * sync deletes the destination first, the next line read a package.json that no
 * longer existed and died on a raw ENOENT naming a generated path.
 *
 * Both callers now share this one function, so there is one place to get the
 * segment matching right and one place that is tested.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { isTemplateFile } from "../create.mjs";

/** Would this whole template be copied out of a root at `root`? */
function copies(root, relatives) {
  return relatives.every((rel) => isTemplateFile(root, join(root, rel)));
}

const TEMPLATE = ["package.json", "agent/agent.ts", "lib/memory.ts", "scripts/verify.mjs"];

test("a checkout path containing an excluded word still copies everything", () => {
  for (const root of [
    "/Users/someone/.npm/_npx/abc123/node_modules/create-evestack/template",
    "/Users/someone/dist/evestack/templates/default",
    "/Users/someone/Projects/distro/evestack/templates/default",
    "/Users/someone/work/distributed-systems/evestack/templates/default",
    "/Users/steve.everett/evestack/templates/default",
    "/Users/someone/.next-big-thing/evestack/templates/default",
  ]) {
    assert.ok(copies(root, TEMPLATE), `copied nothing out of ${root}`);
  }
});

test("the template root itself is copied", () => {
  const root = "/Users/someone/evestack/templates/default";
  assert.equal(isTemplateFile(root, root), true);
});

test("build leftovers and secrets inside the template are still excluded", () => {
  const root = "/Users/someone/evestack/templates/default";
  for (const rel of [
    "node_modules/eve/package.json",
    ".eve/traces/run.jsonl",
    ".output/server/index.mjs",
    ".next/build-manifest.json",
    "dist/agent.js",
    ".env.local",
    "tsconfig.tsbuildinfo",
    "agent/node_modules/x/index.js",
  ]) {
    assert.equal(isTemplateFile(root, join(root, rel)), false, `${rel} was copied`);
  }
});

test("a segment is a whole segment, not a substring of one", () => {
  // The other half of the same mistake: excluding "dist" must not exclude
  // "distro", and excluding ".eve" must not exclude ".eve-notes" or "evals".
  const root = "/Users/someone/evestack/templates/default";
  for (const rel of [
    "distro/thing.ts",
    "lib/distributed.ts",
    ".eve-notes/keep.md",
    "evals/basic.eval.ts",
    "agent/distinct.ts",
    "src/dist-helpers.ts",
  ]) {
    assert.equal(isTemplateFile(root, join(root, rel)), true, `${rel} was excluded`);
  }
});

test("the sync script and the scaffolder use the same filter", async () => {
  // Not a style point: they had two copies, one fixed and one not, and the broken
  // one ran first. A grep is the only way to assert "no second implementation"
  // without importing a script whose top level deletes and rewrites a directory.
  const { readFileSync } = await import("node:fs");
  const url = new URL("../scripts/sync-template.mjs", import.meta.url);
  const source = readFileSync(url, "utf8");
  assert.match(source, /import \{ isTemplateFile \} from "\.\.\/create\.mjs"/);
  assert.ok(
    !/filter:\s*\(src\)\s*=>\s*!\//.test(source),
    "sync-template.mjs has its own inline regex filter again",
  );
});
