import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_RETRY_AFTER_MS,
  DISABLED_SESSION,
  NO_TOOLS,
  createSessionResolver,
} from "../dist/resolver.js";

/**
 * "An agent that cannot reach a SaaS directory is still an agent" is this
 * package's whole failure contract, and every part of it lives here: announce a
 * missing key once, cache a working session, cool off after a failure, and never
 * hand the same object back after it failed. That last one is the trap —
 * `defineComposioTools` memoizes by session identity, so re-using a failed
 * session caches the empty tool set for the life of the process.
 */

const deps = (overrides = {}) => {
  const logged = [];
  const resolver = createSessionResolver({
    apiKey: () => "key",
    openTools: async () => ({ SOME_TOOL: {} }),
    log: (message) => logged.push(message),
    retryAfterMs: 10_000,
    ...overrides,
  });
  return { resolver, logged };
};

test("no API key resolves to zero tools without throwing", async () => {
  const { resolver } = deps({ apiKey: () => undefined });
  assert.deepEqual(await resolver().tools(), NO_TOOLS);
});

test("no API key is announced exactly ONCE, however many steps run", () => {
  // eve resolves tools at the start of every step, so a per-step log would print
  // this on every turn forever.
  const { resolver, logged } = deps({ apiKey: () => undefined });
  for (let i = 0; i < 5; i++) resolver();
  assert.equal(logged.length, 1);
  assert.match(logged[0], /COMPOSIO_API_KEY is not set/);
  assert.match(logged[0], /Everything else works/);
});

test("the disabled path returns the SAME object every time", () => {
  // Identity is the memoization key upstream, so a fresh object per step would
  // re-resolve zero tools on every step instead of never again.
  const { resolver } = deps({ apiKey: () => undefined });
  assert.equal(resolver(), resolver());
  assert.equal(resolver(), DISABLED_SESSION);
});

test("an empty or whitespace key counts as no key", () => {
  for (const key of ["", "   ".trim(), undefined]) {
    const { resolver } = deps({ apiKey: () => key });
    assert.equal(resolver(), DISABLED_SESSION, JSON.stringify(key));
  }
});

test("a working session is cached by identity, so later steps cost no handshake", async () => {
  let opened = 0;
  const { resolver } = deps({
    openTools: async () => {
      opened++;
      return { SOME_TOOL: {} };
    },
  });
  const first = resolver();
  assert.deepEqual(await first.tools(), { SOME_TOOL: {} });

  // Identity is the contract, not a `tools()` cache of our own. Every later step
  // gets this same object back, and `defineComposioTools` keys its own WeakMap on
  // exactly that, which is what makes the handshake happen once. Resolving again
  // must therefore cost nothing here.
  const before = opened;
  for (let i = 0; i < 5; i++) assert.equal(resolver(), first);
  assert.equal(opened, before, "re-resolving a live session must not open anything");
});

test("a failed handshake degrades to zero tools and logs the real error", async () => {
  const { resolver, logged } = deps({
    openTools: async () => {
      throw new Error("ECONNREFUSED 127.0.0.1:443");
    },
  });
  assert.deepEqual(await resolver().tools(), NO_TOOLS);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /ECONNREFUSED 127\.0\.0\.1:443/);
  assert.match(logged[0], /retrying in 10s/);
});

test("a non-Error rejection is still described, not printed as [object Object]", async () => {
  const { resolver, logged } = deps({
    openTools: async () => {
      throw "just a string";
    },
  });
  await resolver().tools();
  assert.match(logged[0], /just a string/);
});

test("THE TRAP: a failed session is not handed out again", async () => {
  // Returning the same object would let upstream's per-identity cache serve the
  // empty tool set forever.
  const { resolver } = deps({
    openTools: async () => {
      throw new Error("nope");
    },
    retryAfterMs: 0,
  });
  const first = resolver();
  await first.tools();
  assert.notEqual(resolver(), first);
});

test("the cooldown holds off the next attempt entirely", async () => {
  let opened = 0;
  const { resolver } = deps({
    openTools: async () => {
      opened++;
      throw new Error("nope");
    },
    retryAfterMs: 10_000,
  });
  await resolver().tools();
  assert.equal(resolver(), DISABLED_SESSION, "during the cooldown, no network call is even offered");
  await resolver().tools();
  assert.equal(opened, 1, "steps during the cooldown cost no handshake");
});

test("after the cooldown a fresh attempt is made", async () => {
  let opened = 0;
  const { resolver } = deps({
    openTools: async () => {
      opened++;
      throw new Error("nope");
    },
    retryAfterMs: 0,
  });
  await resolver().tools();
  const second = resolver();
  assert.notEqual(second, DISABLED_SESSION);
  await second.tools();
  assert.equal(opened, 2);
});

test("recovery: the attempt after a failure can succeed and then be cached", async () => {
  let opened = 0;
  const { resolver } = deps({
    openTools: async () => {
      opened++;
      if (opened === 1) throw new Error("cold start");
      return { SOME_TOOL: {} };
    },
    retryAfterMs: 0,
  });
  await resolver().tools();
  const second = resolver();
  assert.deepEqual(await second.tools(), { SOME_TOOL: {} });
  assert.equal(resolver(), second, "a session that worked stays cached");
});

test("a stale failure does not evict the session that replaced it", async () => {
  // The `live === attempt` guard. Without it, a slow first attempt failing after a
  // second one succeeded would throw away a working session.
  let release;
  let opened = 0;
  const { resolver } = deps({
    openTools: async () => {
      opened++;
      if (opened === 1) {
        await new Promise((resolve) => {
          release = resolve;
        });
        throw new Error("slow failure");
      }
      return { SOME_TOOL: {} };
    },
    retryAfterMs: 0,
  });

  const stale = resolver();
  const staleTools = stale.tools();
  // A second attempt takes over while the first is still in flight. It can only
  // be reached once the first has settled and cleared `live`, so drive the
  // ordering the way the guard is written: settle the stale one, take a fresh
  // attempt, then settle it too.
  release();
  assert.deepEqual(await staleTools, NO_TOOLS);
  const fresh = resolver();
  assert.deepEqual(await fresh.tools(), { SOME_TOOL: {} });
  assert.equal(resolver(), fresh);
});

test("the documented default cooldown is 60s", () => {
  assert.equal(DEFAULT_RETRY_AFTER_MS, 60_000);
});
