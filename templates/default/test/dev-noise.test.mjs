/**
 * The two blocks `npm run dev` drops, and everything it must not.
 *
 * Both fixtures are the real bytes, captured from a cold scaffold: ANSI colour
 * intact, indentation intact, blank line after the rolldown block intact. That
 * matters, because the filter matches on colour-stripped text and decides where
 * a block ENDS from indentation. A hand-typed approximation of either would
 * pass while the shipped thing leaked.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createDevNoiseFilter } from "../scripts/checks.mjs";

const ESC = "\u001B";

/** rolldown, on every boot and every hot rebuild. Heading, frame, hint, blank. */
const EVAL_BLOCK = [
  `node_modules/@vercel/otel/dist/node/index.js (23:28893) ${ESC}[33m[EVAL] ${ESC}[0mUse of direct \`eval\` function is strongly discouraged as it poses security risks and may cause issues with minification.`,
  " - Use of direct \`eval\` here. in ../../../../../../../../node_modules/@vercel/otel/dist/node/index.js at 254579..254583",
  ` ${ESC}[38;5;240m |${ESC}[0m `,
  ` ${ESC}[38;5;240m |${ESC}[0m ${ESC}[38;5;115mHelp${ESC}[0m: Consider using indirect eval. For more information, check the documentation: https://rolldown.rs/guide/troubleshooting#avoiding-direct-eval`,
  "",
].join("\n");

/** the workflow SDK, once per new session, twice over. Heading and one field. */
const DEPLOYMENT_BLOCK = [
  "[workflow-sdk] deploymentId: 'latest' has no effect in this world and was ignored. It is only supported by worlds with atomic deployments, such as Vercel. The run will target the current deployment.",
  "  currentDeploymentId postgres",
].join("\n");

const KEEP_TRACES =
  "[evestack:traces] could not reach http://127.0.0.1:4000/api/ingest/v1/traces at startup (fetch failed), so trace export is unverified.";

function run(text) {
  const filter = createDevNoiseFilter();
  const out = filter.push(text) + filter.flush();
  return { out, suppressed: filter.suppressed };
}

test("the eval warning and its whole diagnostic go", () => {
  const { out, suppressed } = run(`${EVAL_BLOCK}\n${KEEP_TRACES}\n`);
  assert.equal(suppressed, 1);
  assert.equal(out, `${KEEP_TRACES}\n`);
});

test("the deploymentId notice takes its field with it, both times", () => {
  const { out, suppressed } = run(`${DEPLOYMENT_BLOCK}\n${DEPLOYMENT_BLOCK}\n${KEEP_TRACES}\n`);
  assert.equal(suppressed, 2);
  assert.equal(out, `${KEEP_TRACES}\n`);
});

test("everything else is relayed byte for byte, colour included", () => {
  const noisy = `${ESC}[31mError${ESC}[0m: something real broke\n    at file.ts:1:1\n`;
  const { out, suppressed } = run(noisy);
  assert.equal(suppressed, 0);
  assert.equal(out, noisy);
});

test("an indented line that follows something kept is still kept", () => {
  const stack = "Error: boom\n    at one\n    at two\n";
  const { out } = run(stack);
  assert.equal(out, stack);
});

test("a chunk that splits a heading mid-line still suppresses it", () => {
  const filter = createDevNoiseFilter();
  const text = `${EVAL_BLOCK}\n${KEEP_TRACES}\n`;
  const cut = Math.floor(text.length / 3);
  const out =
    filter.push(text.slice(0, cut)) + filter.push(text.slice(cut)) + filter.flush();
  assert.equal(filter.suppressed, 1);
  assert.equal(out, `${KEEP_TRACES}\n`);
});

test("a write with no newline is held, then released by flush", () => {
  const filter = createDevNoiseFilter();
  assert.equal(filter.push("half a line"), "");
  assert.equal(filter.holding, true);
  assert.equal(filter.flush(), "half a line");
  assert.equal(filter.holding, false);
});
