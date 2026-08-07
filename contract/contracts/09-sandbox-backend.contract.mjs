/**
 * The sandbox backend interface, at run time.
 *
 * `@evestack/sandbox-opensandbox` is published to npm and implements eve's
 * `SandboxBackend` *structurally* — it declares its own `SandboxBackendLike`
 * interface rather than importing eve's types, so that eve stays a peer
 * dependency and one package build works across a range of eve versions.
 *
 * That used to mean `tsc` had nothing to compare the two against, and it cost
 * us: `captureState()` shipped through 0.2.0 without the `sessionKey` eve
 * requires, so no sandbox ever reattached and every turn silently leaked the
 * previous one. The package now carries type-only conformance assertions
 * against eve's real declarations (src/index.ts), so a renamed or added field
 * fails `pnpm -r typecheck`.
 *
 * This contract is still worth running, because those assertions check the
 * *declarations* and this checks the object eve's runtime actually hands over —
 * a .d.ts and a shipped implementation can disagree.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../lib/repo.mjs";

const BACKEND_METHODS = ["create", "prewarm"];

/** Members `packages/sandbox-opensandbox/src/index.ts` implements by hand. */
const HANDLE_MEMBERS = ["session", "useSessionFn", "captureState", "shutdown"];
const SESSION_MEMBERS = [
  "id",
  "resolvePath",
  "run",
  "spawn",
  "setNetworkPolicy",
  "removePath",
  "readTextFile",
  "writeTextFile",
  "readBinaryFile",
  "writeBinaryFile",
  "readFile",
  "writeFile",
];

/** The wrapper whose session object has to satisfy eve. */
const WRAPPER = join("packages", "sandbox-opensandbox", "src");

/**
 * Every non-optional member eve declares on `SandboxSession`, read from the
 * declaration rather than listed here.
 *
 * A HAND-MAINTAINED LIST CANNOT CATCH THIS. SESSION_MEMBERS above was exactly
 * the nine members the wrapper happened to implement, asserted to be a SUBSET of
 * eve's declarations — which catches a name we implement and eve has dropped,
 * and is structurally blind to the opposite. eve requires `spawn`,
 * `setNetworkPolicy` and `removePath`; the wrapper shipped without all three,
 * every assertion here passed, and the failure surfaced as
 * `session.removePath is not a function` at the first tool call that deleted a
 * file. Deriving the list from the interface is the only version of this check
 * that can fail for the right reason.
 */
function requiredSessionMembers(declaration) {
  const start = declaration.indexOf("interface SandboxSession");
  if (start < 0) return [];
  let depth = 0;
  let body = "";
  for (let i = declaration.indexOf("{", start); i < declaration.length; i += 1) {
    const ch = declaration[i];
    if (ch === "{") depth += 1;
    if (depth > 0) body += ch;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const required = [];
  // `foo(...)` or `foo: T`, but never `foo?(...)` / `foo?: T`. Comment lines and
  // nested object types are skipped by requiring the name to start the line.
  for (const line of body.split("\n")) {
    const match = /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*(\??)\s*[(:<]/.exec(line);
    if (!match) continue;
    if (match[2] === "?") continue;
    if (!required.includes(match[1])) required.push(match[1]);
  }
  return required;
}

/** Concatenated wrapper source — the session is assembled across more than one file. */
function wrapperSource() {
  const dir = join(REPO_ROOT, WRAPPER);
  return readFileSync(join(dir, "index.ts"), "utf8");
}

export default {
  id: "sandbox/backend-interface-is-structurally-stable",
  title: "eve's SandboxBackend still has the shape @evestack/sandbox-opensandbox duck-types",
  assumption:
    "A SandboxBackend is `{ name, create(input), prewarm(input) }`; its handle exposes session/useSessionFn/" +
    "captureState/shutdown; create takes templateKey + sessionKey + existingMetadata; prewarm takes " +
    "templateKey + seedFiles and returns `{ reused }`.",
  evestackUse:
    "packages/sandbox-opensandbox is published to npm and declares its own copy of this interface so eve can " +
    "stay a peer dependency — which means `tsc` never compares the two and CI cannot notice them diverging. " +
    "templates/default/agent/sandbox/sandbox.ts wires `docker()` the same way, and the README offers the " +
    "OpenSandbox backend as a one-line swap. A renamed method or a changed create/prewarm input ships a " +
    "green build to npm and breaks at the user's first `eve build` with a type error in a package they did " +
    "not write.",

  async check(eve, t) {
    // Runtime first: whatever the .d.ts says, this is the object eve's runtime
    // is actually handed when a scaffolded agent boots.
    const { docker } = await eve.loadPublic("eve/sandbox/docker");
    const backend = docker();
    t.equal(typeof backend.name, "string", "a built-in backend still exposes a string `name`");
    for (const method of BACKEND_METHODS) {
      t.equal(typeof backend[method], "function", `a built-in backend still implements \`${method}()\``);
    }

    const { defineSandbox } = await eve.loadPublic("eve/sandbox");
    t.equal(typeof defineSandbox, "function", "eve/sandbox still exports defineSandbox()");
    const definition = defineSandbox({ backend });
    t.ok(definition !== null && typeof definition === "object", "defineSandbox({ backend }) still returns a definition");

    // Then the declaration our package was written against. Runtime cannot
    // reach the handle or the session without a Docker daemon, and the suite
    // must stay daemon-free.
    const types = eve.readFile("dist/src/shared/sandbox-backend.d.ts");
    t.contains(types, "interface SandboxBackend", "eve still declares the SandboxBackend interface");
    for (const member of HANDLE_MEMBERS) {
      t.contains(types, member, `SandboxBackendHandle still carries \`${member}\``);
    }
    for (const field of ["templateKey", "sessionKey", "existingMetadata"]) {
      t.contains(types, field, `SandboxBackendCreateInput still carries \`${field}\``);
    }
    for (const field of ["seedFiles", "bootstrap"]) {
      t.contains(types, field, `SandboxBackendPrewarmInput still carries \`${field}\``);
    }
    t.contains(types, "reused", "prewarm() still reports `reused`");

    // The session surface, checked in BOTH directions.
    const sessionTypes = eve.readFile("dist/src/shared/sandbox-session.d.ts");

    // Outward: a name we implement that eve has stopped calling is dead code.
    for (const member of SESSION_MEMBERS) {
      t.contains(sessionTypes, member, `SandboxSession still declares \`${member}\``);
    }

    // Inward: a name eve REQUIRES that we do not implement is a TypeError at the
    // user's first tool call. This is the direction that was missing.
    const required = requiredSessionMembers(sessionTypes);
    t.ok(
      required.length > 0,
      "eve's SandboxSession declaration could still be parsed for required members",
      required.length > 0 ? {} : { actual: "parsed zero members — the declaration shape changed" },
    );
    const wrapper = wrapperSource();
    for (const member of required) {
      // Implemented as a property or a method on the returned session object.
      const implemented =
        new RegExp(`\\b${member}\\s*[(:]`).test(wrapper) || new RegExp(`\\b${member}\\s*,`).test(wrapper);
      t.ok(implemented, `the wrapper implements eve's required \`${member}\``, implemented ? {} : {
        actual: `packages/sandbox-opensandbox/src/index.ts never defines \`${member}\``,
      });
    }
  },
};
