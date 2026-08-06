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

const BACKEND_METHODS = ["create", "prewarm"];

/** Members `packages/sandbox-opensandbox/src/index.ts` implements by hand. */
const HANDLE_MEMBERS = ["session", "useSessionFn", "captureState", "shutdown"];
const SESSION_MEMBERS = [
  "id",
  "resolvePath",
  "run",
  "readTextFile",
  "writeTextFile",
  "readBinaryFile",
  "writeBinaryFile",
  "readFile",
  "writeFile",
];

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

    // The session surface our wrapper hand-implements. Asserting our members
    // are a subset of eve's catches the drift that matters: a name we still
    // implement that eve has stopped calling is dead code the runtime will
    // never reach.
    const sessionTypes = eve.readFile("dist/src/shared/sandbox-session.d.ts");
    for (const member of SESSION_MEMBERS) {
      t.contains(sessionTypes, member, `SandboxSession still declares \`${member}\``);
    }
  },
};
