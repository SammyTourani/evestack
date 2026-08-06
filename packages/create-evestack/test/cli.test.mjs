import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * The bin, run as a process, because what this asserts is what reaches a
 * terminal rather than what a function returns.
 *
 * Both commands report their real refusals by throwing: attach refuses a
 * directory that is not an eve project, and every one of those messages names
 * the exact file it wanted. Whether that arrives as a sentence or as a stack
 * trace is not cosmetic — a stack trace puts the useful line third, under a
 * source excerpt, above a Node version footer. The `evestack` bin has caught
 * these since it grew a `create` command; this one did not.
 */
const BIN = fileURLToPath(new URL("../index.mjs", import.meta.url));
const NOWHERE = "/definitely/not/an/eve/project";

test("a refusal reaches the terminal as its message, not as a crash", () => {
  const { status, stderr, stdout } = spawnSync(process.execPath, [BIN, "attach", NOWHERE], {
    encoding: "utf8",
    input: "",
  });
  assert.equal(status, 1);
  // The message attach actually wrote, both halves of it.
  assert.match(stderr, /No such directory: \/definitely\/not\/an\/eve\/project/);
  assert.match(stderr, /Pass the path to an existing eve project/);
  // And none of the wrapping node adds to an unhandled rejection.
  const all = `${stdout}${stderr}`;
  assert.doesNotMatch(all, /\bat detectEveProject\b/, "a stack trace reached the user");
  assert.doesNotMatch(all, /^Node\.js v/m, "node's crash footer reached the user");
  assert.doesNotMatch(all, /throw new Error/, "node's source excerpt reached the user");
});

test("the stack is still there for whoever actually wants it", () => {
  const { stderr } = spawnSync(process.execPath, [BIN, "attach", NOWHERE], {
    encoding: "utf8",
    input: "",
    env: { ...process.env, EVESTACK_DEBUG: "1" },
  });
  assert.match(stderr, /\bat detectEveProject\b/);
});
