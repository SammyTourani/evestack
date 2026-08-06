import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";

// `ask` answers "" both when someone pressed Enter and when stdin closed under
// it, and `confirm` mapped "" to the default. So Ctrl-D at a (Y/n) prompt read
// as yes — and the prompts this wizard asks with defaultYes are the ones that
// START a container runtime. Nobody typed anything; that is not consent.

const SHARED = join(dirname(fileURLToPath(import.meta.url)), "..", "shared.mjs");

function answerWith(stdin, defaultYes = true) {
  const script =
    `import { makePrompter } from ${JSON.stringify(SHARED)};` +
    `const p = await makePrompter(false);` +
    `console.log("RESULT:" + (await p.confirm("go?", ${defaultYes})));` +
    `p.close();`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    input: stdin,
    encoding: "utf8",
    timeout: 15_000,
  });
  const m = /RESULT:(true|false)/.exec(r.stdout ?? "");
  assert.ok(m, `no result; stdout=${r.stdout} stderr=${r.stderr}`);
  return m[1] === "true";
}

test("a closed stdin declines, even when the default is yes", () => {
  assert.equal(answerWith("", true), false);
});

test("pressing Enter still takes the default", () => {
  assert.equal(answerWith("\n", true), true);
  assert.equal(answerWith("\n", false), false);
});

test("an explicit answer still wins", () => {
  assert.equal(answerWith("y\n", false), true);
  assert.equal(answerWith("n\n", true), false);
});
