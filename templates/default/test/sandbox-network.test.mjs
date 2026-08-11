/**
 * The sandbox's egress default, from this side of the line.
 *
 * contract/contracts/18-sandbox-network.contract.mjs drives eve's real Docker
 * binding and proves that `networkPolicy: "deny-all"` still puts
 * `--network none` on the `docker run` argv, with a negative control for
 * allow-all. That half is sound and stays where it is. It says nothing about
 * whether this template still ASKS for deny-all: measured, the contract stays
 * fully green with `resolveNetworkPolicy` deleted and the field gone. eve's own
 * default is allow-all, so what is left is a container on Docker's default
 * bridge — a shell the model drives reaching the LAN, the router, a cloud
 * instance's metadata endpoint and the internet — with a green suite.
 *
 * ─ Why this stubs `eve/sandbox/docker` instead of calling the helper ─────────
 *
 * `resolveNetworkPolicy()` on its own cannot catch the edit that matters most:
 * replacing `networkPolicy: resolveNetworkPolicy()` with a literal, or dropping
 * the field so eve's allow-all default applies. The value has to be observed
 * where it is handed over. `docker()` captures its options in a closure and
 * hands back `{ name, create, prewarm }`, so nothing can be read back off the
 * backend without starting a container — hence a resolve hook that points the
 * specifier at a recording stub. The module under test is otherwise the real
 * one, imported through the real `defineSandbox`, and the argument recorded is
 * the argument eve would have been given.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

/** Every options object `docker()` was handed, in order. */
const CALLS = [];
globalThis.__evestackDockerCalls = CALLS;

const STUB = `data:text/javascript,${encodeURIComponent(
  "export function docker(options) {\n" +
    "  globalThis.__evestackDockerCalls.push(options);\n" +
    "  return { name: 'docker', create() {}, prewarm() {} };\n" +
    "}\n",
)}`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "eve/sandbox/docker") return { url: STUB, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

// Dynamic, because the hook has to be installed before this module resolves its
// own imports. `import type { DockerSandboxNetworkPolicy }` is erased by Node's
// type stripping and never reaches the hook.
const { default: definition, resolveNetworkPolicy } = await import("../agent/sandbox/sandbox.ts");

/** Runs `body` with EVESTACK_SANDBOX_NETWORK set to exactly `value`. */
function withNetwork(value, body) {
  const before = process.env.EVESTACK_SANDBOX_NETWORK;
  if (value === undefined) delete process.env.EVESTACK_SANDBOX_NETWORK;
  else process.env.EVESTACK_SANDBOX_NETWORK = value;
  try {
    return body();
  } finally {
    if (before === undefined) delete process.env.EVESTACK_SANDBOX_NETWORK;
    else process.env.EVESTACK_SANDBOX_NETWORK = before;
  }
}

/** The options `docker()` is handed for the current environment. */
function optionsHandedToDocker() {
  const before = CALLS.length;
  const backend = definition.backend();
  assert.equal(CALLS.length, before + 1, "the backend factory did not call docker()");
  assert.equal(backend.name, "docker", "and it returned what docker() gave it");
  return CALLS[CALLS.length - 1];
}

/* -------------------------------------------------------------------------- */
/* the default                                                                 */
/* -------------------------------------------------------------------------- */

test("with nothing configured, the template asks for deny-all", () => {
  withNetwork(undefined, () => {
    assert.equal(resolveNetworkPolicy(), "deny-all");
    assert.equal(
      optionsHandedToDocker().networkPolicy,
      "deny-all",
      "eve's own default is allow-all, so an absent field is an open container",
    );
  });
});

test("the factory is lazy, so the value is read per call and not at import", () => {
  // The reason `backend` is a function rather than `docker({...})`: eve loads
  // .env/.env.local after this module. Resolved eagerly, the policy would be
  // whatever the environment looked like before the project's own files were
  // read, which for a project that sets allow-all in .env.local is the opposite
  // of what it asked for.
  withNetwork("allow-all", () => {
    assert.equal(optionsHandedToDocker().networkPolicy, "allow-all");
  });
  withNetwork(undefined, () => {
    assert.equal(optionsHandedToDocker().networkPolicy, "deny-all");
  });
});

/* -------------------------------------------------------------------------- */
/* every branch                                                                */
/* -------------------------------------------------------------------------- */

/** Value, the policy it must produce, and why it is in this table. */
const ACCEPTED = [
  [undefined, "deny-all", "unset — the shipped default"],
  ["", "deny-all", "exported empty, which is a variable nobody set"],
  ["   ", "deny-all", "whitespace only, the same thing after trim"],
  ["deny-all", "deny-all", "asked for explicitly"],
  [" deny-all ", "deny-all", "padded, as a .env line with a trailing space gives it"],
  ["allow-all", "allow-all", "the one opt-out, spelled exactly"],
  ["\tallow-all\n", "allow-all", "padded opt-out"],
];

test("every accepted value maps to the policy it names", () => {
  for (const [value, expected, why] of ACCEPTED) {
    withNetwork(value, () => {
      assert.equal(resolveNetworkPolicy(), expected, `${JSON.stringify(value)}: ${why}`);
      assert.equal(optionsHandedToDocker().networkPolicy, expected, `${JSON.stringify(value)} reaches docker()`);
    });
  }
});

/*
 * The question this file exists to answer: is there any value a person could
 * set believing it RESTRICTS egress that ends up with the network on?
 *
 * The answer has to be no for all three shapes of mistake — a synonym for
 * "off", a synonym for "on" that is misspelled, and the right word in the wrong
 * case — and "no" has two acceptable forms: deny-all, or a refusal. What is not
 * acceptable is allow-all, and that is asserted directly rather than inferred
 * from the two branches above, because it is the property that matters and it
 * must survive whatever the branches are rewritten into.
 */
const NOT_ALLOW_ALL = [
  "none",
  "off",
  "no",
  "false",
  "0",
  "disabled",
  "deny",
  "denyall",
  "deny_all",
  "DENY-ALL",
  "Deny-All",
  "ALLOW-ALL",
  "allow_all",
  "allowall",
  "allow all",
  "all",
  "true",
  "1",
  "bridge",
  "host",
];

test("nothing a person might type for 'no network' opens one", () => {
  for (const value of NOT_ALLOW_ALL) {
    withNetwork(value, () => {
      let policy;
      try {
        policy = resolveNetworkPolicy();
      } catch {
        return; // refused, which is the other acceptable answer
      }
      assert.notEqual(policy, "allow-all", `EVESTACK_SANDBOX_NETWORK=${value} opened the container`);
    });
  }
});

test("an unrecognized value refuses instead of guessing, and names both choices", () => {
  withNetwork("none", () => {
    assert.throws(
      () => resolveNetworkPolicy(),
      (error) => {
        assert.match(error.message, /EVESTACK_SANDBOX_NETWORK/);
        assert.match(error.message, /"deny-all"/);
        assert.match(error.message, /"allow-all"/);
        assert.match(error.message, /none/, "and it quotes back what was actually set");
        return true;
      },
    );
  });
});

test("a refused value never reaches docker() at all", () => {
  // Fail-closed is the whole point: eve's `lazyBackend` calls this factory and
  // does not catch, so the sandbox does not start. A version that caught the
  // throw and carried on would start one on eve's allow-all default, which is
  // the worst outcome available and would look like a working stack.
  withNetwork("allow_all", () => {
    const before = CALLS.length;
    assert.throws(() => definition.backend(), /EVESTACK_SANDBOX_NETWORK/);
    assert.equal(CALLS.length, before, "docker() was called with a policy nobody chose");
  });
});
