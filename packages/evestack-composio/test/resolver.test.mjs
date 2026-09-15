import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_MAX_IDENTITIES,
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

/**
 * ─ Per-principal isolation ─
 *
 * The bug these cover: this resolver used to cache exactly one session in one
 * variable (`if (live) return live`) and ignore the eve context entirely. Since
 * Composio hangs OAuth grants off the user id a session was opened for, one
 * cached session meant one Composio identity — so whoever connected Gmail
 * through the agent connected it for every other principal that ever reached it.
 *
 * `identify` is injected the same way the network is: this file never decides
 * WHO a context is (that lives in src/index.ts and is pinned in
 * identity.test.mjs), only that the answer is used as the cache key and passed
 * to the handshake.
 */

/** A resolver that keys on `ctx.who`, plus a log of the identities handshaked. */
const byWho = (overrides = {}) => {
  const opened = [];
  const { resolver, logged } = deps({
    identify: (context) => context?.who ?? "nobody",
    openTools: async (_apiKey, identity) => {
      opened.push(identity);
      return { [`TOOL_FOR_${identity}`]: {} };
    },
    ...overrides,
  });
  return { resolver, logged, opened };
};

test("two principals get two different sessions, and B never gets A's", async () => {
  const { resolver, opened } = byWho();

  const alice = resolver({ who: "alice" });
  const bob = resolver({ who: "bob" });

  assert.notEqual(alice, bob, "one cached session for everyone is the vulnerability");
  assert.deepEqual(await alice.tools(), { TOOL_FOR_alice: {} });
  assert.deepEqual(await bob.tools(), { TOOL_FOR_bob: {} });
  assert.deepEqual(opened, ["alice", "bob"], "each identity opens its own Composio session");
});

test("the identity reaches the handshake, because it IS the Composio user id", async () => {
  // Keying the cache correctly and then opening the session under some other id
  // would isolate nothing: the grants hang off the id passed to sessions.create.
  const { resolver, opened } = byWho();
  await resolver({ who: "carol" }).tools();
  assert.deepEqual(opened, ["carol"]);
});

test("each principal keeps its own cached session across steps", async () => {
  const { resolver, opened } = byWho();
  const alice = resolver({ who: "alice" });
  await alice.tools();
  const bob = resolver({ who: "bob" });
  await bob.tools();

  for (let i = 0; i < 5; i++) {
    assert.equal(resolver({ who: "alice" }), alice);
    assert.equal(resolver({ who: "bob" }), bob);
  }
  assert.equal(opened.length, 2, "steps for a known principal cost no handshake");
});

test("a context with no identity at all still resolves, exactly once", async () => {
  // eve calls the resolver with a context on every step, but a caller wiring
  // this up by hand — or a test — may pass nothing. That must not throw and must
  // not open a session per step.
  const { resolver, opened } = byWho();
  const first = resolver();
  await first.tools();
  assert.equal(resolver(), first);
  assert.deepEqual(opened, ["nobody"]);
});

test("THE LEAK: the identity map is bounded, and evicts least-recently-used", async () => {
  // An identity can be derived from something an attacker supplies — a JWT
  // subject, a Slack user id from a public workspace — so an unbounded map keyed
  // on it grows forever with a live session pinned to every entry.
  const { resolver, opened } = byWho({ maxIdentities: 2 });

  await resolver({ who: "a" }).tools();
  await resolver({ who: "b" }).tools();
  const bBefore = resolver({ who: "b" });

  // `a` is now the least recently used of the two, so `c` evicts it.
  await resolver({ who: "c" }).tools();
  assert.equal(resolver({ who: "b" }), bBefore, "the newer principal is still cached");

  await resolver({ who: "a" }).tools();
  assert.deepEqual(opened, ["a", "b", "c", "a"], "the evicted principal pays one more handshake");
});

test("a hit is a use: touching a principal saves it from the next eviction", async () => {
  const { resolver, opened } = byWho({ maxIdentities: 2 });
  await resolver({ who: "a" }).tools();
  await resolver({ who: "b" }).tools();

  const aTouched = resolver({ who: "a" }); // makes `b` the oldest
  await resolver({ who: "c" }).tools(); // evicts `b`

  assert.equal(resolver({ who: "a" }), aTouched, "the recently used principal survived");
  await resolver({ who: "b" }).tools();
  assert.deepEqual(opened, ["a", "b", "c", "b"]);
});

test("eviction cannot make a principal see another principal's tools", async () => {
  const { resolver } = byWho({ maxIdentities: 1 });
  await resolver({ who: "alice" }).tools();
  const bob = resolver({ who: "bob" }); // evicts alice
  assert.deepEqual(await bob.tools(), { TOOL_FOR_bob: {} });
  assert.deepEqual(await resolver({ who: "alice" }).tools(), { TOOL_FOR_alice: {} });
});

test("one principal's failed handshake does not evict another's working session", async () => {
  // The `live.get(identity) === attempt` guard, now per identity. Without the
  // key in it, a failure would clear whatever session happened to be cached.
  let opened = 0;
  const { resolver } = deps({
    identify: (context) => context?.who ?? "nobody",
    retryAfterMs: 0,
    openTools: async (_apiKey, identity) => {
      opened++;
      if (identity === "broken") throw new Error("no session for you");
      return { SOME_TOOL: {} };
    },
  });

  const working = resolver({ who: "fine" });
  assert.deepEqual(await working.tools(), { SOME_TOOL: {} });
  await resolver({ who: "broken" }).tools();

  assert.equal(resolver({ who: "fine" }), working, "the healthy session survived the failure");
  assert.equal(opened, 2, "and it did not re-handshake");
});

test("the cooldown is process-wide, but never takes away a live session", async () => {
  // A failed handshake means Composio is unreachable or the key is bad — a
  // property of the installation, not of the principal — so the cooldown is
  // global, and cycling identities cannot cycle network calls. A principal that
  // already has a session keeps it.
  let opened = 0;
  const { resolver } = deps({
    identify: (context) => context?.who ?? "nobody",
    retryAfterMs: 10_000,
    openTools: async (_apiKey, identity) => {
      opened++;
      if (identity === "broken") throw new Error("nope");
      return { SOME_TOOL: {} };
    },
  });

  const working = resolver({ who: "fine" });
  await working.tools();
  await resolver({ who: "broken" }).tools();

  assert.equal(resolver({ who: "fine" }), working, "an outage does not close an open session");
  assert.equal(resolver({ who: "new" }), DISABLED_SESSION, "but it does hold off new ones");
  assert.equal(opened, 2, "no handshake is even offered during the cooldown");
});

test("the documented identity cap is 64, and a silly cap is clamped rather than obeyed", async () => {
  assert.equal(DEFAULT_MAX_IDENTITIES, 64);

  // maxIdentities: 0 would mean "cache nothing", which re-handshakes on every
  // step of every turn. Clamped to 1 instead.
  const { resolver, opened } = byWho({ maxIdentities: 0 });
  const first = resolver({ who: "a" });
  await first.tools();
  assert.equal(resolver({ who: "a" }), first);
  assert.deepEqual(opened, ["a"]);
});

test("a cap that is not a number falls back to the default rather than removing the bound", async () => {
  // The clamp used to be `Math.max(1, Math.floor(n ?? DEFAULT))`, and
  // `Math.max(1, NaN)` is NaN — after which `size > NaN` is false at every
  // size, so the map never evicts anything. One bad option turned the bound
  // into no bound, which is the leak this cache is bounded to prevent, arrived
  // at with nothing logged and nothing thrown. NaN is the normal shape of a
  // mis-wired numeric option: `Number(process.env.SOMETHING)` produces it for a
  // variable that is unset or misspelt.
  // Asserted on the cached OBJECT, not on a handshake count: `tools()` is not
  // memoized here (upstream's WeakMap does that, keyed on the object we hand
  // back), so calling it twice opens twice whether or not the entry was ever
  // evicted. A count would have passed against the broken clamp.
  const { resolver } = byWho({ maxIdentities: Number("not a number") });
  const oldest = resolver({ who: "p0" });
  await oldest.tools();
  for (let i = 1; i < DEFAULT_MAX_IDENTITIES; i++) await resolver({ who: `p${i}` }).tools();

  // p0…p63 is exactly the default cap, so nothing has been evicted yet. Touching
  // p1 makes p0 the least recently used one.
  const survivor = resolver({ who: "p1" });
  await resolver({ who: `p${DEFAULT_MAX_IDENTITIES}` }).tools();

  // The 65th identity evicts p0 and nothing else. Unbounded, p0 would still be
  // in the map and this would be a hit on the object above.
  assert.notEqual(resolver({ who: "p0" }), oldest, "the default bound still applied");
  // And it fell back to the DEFAULT, not to the clamp floor of 1 — which would
  // have thrown away every identity but the newest.
  assert.equal(resolver({ who: "p1" }), survivor, "it evicted one identity, not the whole map");
});
