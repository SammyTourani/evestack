/**
 * Which key a provider needs, and the one entry that needs none.
 *
 * This was a ternary — `anthropic ? ANTHROPIC_API_KEY : OPENAI_API_KEY` — which
 * is correct only while there are exactly two remote providers. Adding a gateway
 * broke it in the most confusing possible way: the message named the provider
 * correctly ("this project is configured for openrouter") and then demanded a
 * variable belonging to a different one.
 *
 * The replacement then broke a second time, in a way worth pinning forever. The
 * map has one entry deliberately set to `null` — an OpenAI-compatible server on
 * loopback authenticates nobody — and it was read back with
 * `?? "OPENAI_API_KEY"`. `??` falls back on null, so "no key needed" came out of
 * the lookup as a required OpenAI key, and a scaffold pointed at LM Studio
 * refused to start until a key it will never call was set.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { providerKeyVar } from "../scripts/checks.mjs";

test("each remote provider asks for its own key", () => {
  assert.equal(providerKeyVar("openai"), "OPENAI_API_KEY");
  assert.equal(providerKeyVar("anthropic"), "ANTHROPIC_API_KEY");
  assert.equal(providerKeyVar("openrouter"), "OPENROUTER_API_KEY");
});

test("a compatible endpoint needs no key, and null survives the lookup", () => {
  // The whole bug in one assertion: this must be null and not OPENAI_API_KEY.
  assert.equal(providerKeyVar("compatible"), null);
});

test("a provider nobody recognises is not the same as one needing no key", () => {
  // Unknown falls back to OpenAI because unset has always meant openai. That is
  // a different case from `compatible`, and collapsing the two is what `??` did.
  assert.equal(providerKeyVar("ollamma"), "OPENAI_API_KEY");
  assert.equal(providerKeyVar(undefined), "OPENAI_API_KEY");
});
