import assert from "node:assert/strict";
import { test } from "node:test";
import {
  KILLED_EXIT_CODE,
  WORKSPACE,
  exitCodeOf,
  joinOutput,
  killProcessTreeCommand,
  networkPolicyKey,
  resolvePath,
  sameNetworkPolicyKey,
  shellQuote,
  spawnPidFilePath,
  spawnWrapperCommand,
  toOpenSandboxNetworkPolicy,
} from "../dist/translate.js";

/**
 * These functions are the only part of this adapter that runs without an
 * OpenSandbox server, and the first two shipped a bug while they were
 * module-private and therefore untestable. The cases below are those
 * regressions plus the edges that would let another one through.
 */

test("joinOutput restores the newlines OpenSandbox strips per message", () => {
  // The original join("") produced "abc" and every multi-line command the model
  // ran came back mashed together.
  assert.equal(joinOutput([{ text: "a" }, { text: "b" }, { text: "c" }]), "a\nb\nc");
});

test("joinOutput does NOT append a newline the command never wrote", () => {
  // `printf %s x` arrives as one message; eve's Docker backend returns "x", and
  // the over-correction for the bug above returned "x\n" — on almost every
  // command, because a one-line result is the common case for a tool call.
  assert.equal(joinOutput([{ text: "x" }]), "x");
});

test("joinOutput on no output is the empty string, not a bare newline", () => {
  assert.equal(joinOutput([]), "");
  assert.equal(joinOutput(undefined), "");
});

test("joinOutput reads the alternate message shapes, and skips non-strings", () => {
  assert.equal(joinOutput(["a", { content: "b" }, { line: "c" }, { data: "d" }]), "a\nb\nc\nd");
  // A message with no readable text contributes an empty line rather than
  // "undefined" or a dropped line, so line numbering survives.
  assert.equal(joinOutput([{ text: "a" }, { nothing: 1 }, { text: "c" }]), "a\n\nc");
});

test("joinOutput preserves interior blank lines", () => {
  assert.equal(joinOutput([{ text: "a" }, { text: "" }, { text: "b" }]), "a\n\nb");
});

test("resolvePath anchors a relative path to /workspace", () => {
  assert.equal(resolvePath("notes.md"), "/workspace/notes.md");
  assert.equal(resolvePath("a/b/c.txt"), "/workspace/a/b/c.txt");
  assert.equal(WORKSPACE, "/workspace");
});

test("resolvePath passes an absolute path through untouched", () => {
  assert.equal(resolvePath("/etc/hosts"), "/etc/hosts");
  assert.equal(resolvePath("/workspace/x"), "/workspace/x");
});

test("resolvePath expands $HOME/ to /root/", () => {
  assert.equal(resolvePath("$HOME/.bashrc"), "/root/.bashrc");
  // Only the prefix form. A bare "$HOME" is not a path and must not be rewritten
  // into "/root/" with the name eaten.
  assert.equal(resolvePath("$HOME"), "/workspace/$HOME");
  assert.equal(resolvePath("x/$HOME/y"), "/workspace/x/$HOME/y");
});

test("resolvePath is idempotent, because eve's own builder may call it twice", () => {
  for (const path of ["notes.md", "/etc/hosts", "$HOME/.bashrc"]) {
    assert.equal(resolvePath(resolvePath(path)), resolvePath(path), path);
  }
});

// ---------------------------------------------------------------------------
// exitCodeOf
// ---------------------------------------------------------------------------

test("exitCodeOf does NOT report a missing exit code as success", () => {
  // The bug: `execution.exitCode ?? (execution.error ? 1 : 0)` returned 0 for a
  // command that never completed. OpenSandbox's own SDK produces exactly this
  // execution when the SSE stream ends with no completion and no error — a
  // server-side timeout kill, an OOM, a dead container.
  assert.equal(exitCodeOf({ exitCode: null }), KILLED_EXIT_CODE);
  assert.notEqual(exitCodeOf({ exitCode: null }), 0);
  // `background: true` leaves the field absent rather than null; same meaning.
  assert.equal(exitCodeOf({}), KILLED_EXIT_CODE);
  assert.equal(exitCodeOf({ exitCode: undefined }), KILLED_EXIT_CODE);
});

test("exitCodeOf passes a real exit code through, including a real zero", () => {
  // The other half of the fix: a command that DID exit 0 must still read as
  // success, or every successful tool call would look like a failure.
  assert.equal(exitCodeOf({ exitCode: 0 }), 0);
  assert.equal(exitCodeOf({ exitCode: 1 }), 1);
  assert.equal(exitCodeOf({ exitCode: 137 }), 137);
  assert.equal(exitCodeOf({ exitCode: 0, error: undefined }), 0);
});

test("exitCodeOf reports an error with no parseable code as a generic failure", () => {
  assert.equal(exitCodeOf({ exitCode: null, error: { name: "Error", value: "boom" } }), 1);
});

// ---------------------------------------------------------------------------
// Killing a spawned process
// ---------------------------------------------------------------------------

test("shellQuote survives a single quote in the value", () => {
  assert.equal(shellQuote("plain"), "'plain'");
  assert.equal(shellQuote("it's"), "'it'\\''s'");
  // The quoting has to hold for a command a model wrote, or kill() runs
  // something other than what it meant to.
  assert.equal(shellQuote("a'; rm -rf /; echo '"), "'a'\\''; rm -rf /; echo '\\'''");
});

test("spawnWrapperCommand records a pid without changing the command", () => {
  const pidFile = spawnPidFilePath("abc");
  const wrapped = spawnWrapperCommand("npm install && npm start", pidFile);
  const lines = wrapped.split("\n");

  // The caller's command has to survive verbatim, on its own line. `exec`-ing it
  // would have dropped everything after the first `&&`, and putting it on the
  // same line as the pid write would break a command ending in a `# comment`.
  assert.ok(lines.includes("npm install && npm start"), wrapped);
  assert.equal(lines[0], `echo "$$" > '${pidFile}'`);
  // The command's own exit code must remain the execution's exit code.
  assert.equal(lines.at(-1), "exit $status");
  assert.ok(wrapped.includes("status=$?"), wrapped);
  assert.ok(wrapped.includes(`rm -f '${pidFile}'`), wrapped);
});

test("killProcessTreeCommand kills the recorded pid and its children", () => {
  const pidFile = spawnPidFilePath("abc");
  const command = killProcessTreeCommand(pidFile);
  assert.ok(command.startsWith("bash -c "), command);
  // Killing only the recorded pid leaves the actual workload running: the pid
  // belongs to the shell execd started, and the interesting process is its child.
  assert.ok(command.includes("kill_tree"), command);
  assert.ok(command.includes("kill -9"), command);
  // The pid file arrives as an argument, never interpolated into the script.
  assert.ok(command.endsWith(`'${pidFile}'`), command);
});

test("spawnPidFilePath keeps two spawns on the same session apart", () => {
  assert.notEqual(spawnPidFilePath("one"), spawnPidFilePath("two"));
  assert.ok(spawnPidFilePath("one").startsWith("/tmp/"));
});

// ---------------------------------------------------------------------------
// Network policy
// ---------------------------------------------------------------------------

test("toOpenSandboxNetworkPolicy maps the two coarse policies", () => {
  assert.deepEqual(toOpenSandboxNetworkPolicy("allow-all"), { defaultAction: "allow" });
  assert.deepEqual(toOpenSandboxNetworkPolicy("deny-all"), { defaultAction: "deny", egress: [] });
});

test("toOpenSandboxNetworkPolicy makes an allow-list deny by default", () => {
  // eve's rule: an allow-list denies everything it does not name. Translating it
  // to defaultAction "allow" would invert the request.
  assert.deepEqual(toOpenSandboxNetworkPolicy({ allow: ["github.com", "*.npmjs.org"] }), {
    defaultAction: "deny",
    egress: [
      { action: "allow", target: "github.com" },
      { action: "allow", target: "*.npmjs.org" },
    ],
  });
  assert.deepEqual(toOpenSandboxNetworkPolicy({ allow: { "github.com": [] } }), {
    defaultAction: "deny",
    egress: [{ action: "allow", target: "github.com" }],
  });
  // An empty allow-list is a restriction, not an absence of one.
  assert.deepEqual(toOpenSandboxNetworkPolicy({ allow: [] }), {
    defaultAction: "deny",
    egress: [],
  });
  assert.deepEqual(toOpenSandboxNetworkPolicy({}), { defaultAction: "deny", egress: [] });
});

test("toOpenSandboxNetworkPolicy refuses what OpenSandbox cannot express", () => {
  // Each of these would otherwise be applied in part: the parts that do map get
  // sent, the restriction that does not simply disappears, and the call reports
  // success. That is the one outcome worse than refusing.
  assert.throws(
    () => toOpenSandboxNetworkPolicy({ subnets: { deny: ["169.254.169.254/32"] } }),
    /subnets/,
  );
  assert.throws(
    () =>
      toOpenSandboxNetworkPolicy({
        allow: { "gateway.example": [{ transform: [{ headers: { authorization: "Bearer x" } }] }] },
      }),
    /per-domain rule/,
  );
  assert.throws(() => toOpenSandboxNetworkPolicy("deny-most"), /unrecognised policy/);
  assert.throws(() => toOpenSandboxNetworkPolicy({ allow: [42] }), /non-string entry/);
});

test("networkPolicyKey distinguishes the policies a sandbox cannot switch between", () => {
  // Reattach compares this string; two policies that collide here would let a
  // sandbox created under one be handed back under the other.
  const denyAll = networkPolicyKey(toOpenSandboxNetworkPolicy("deny-all"));
  const allowAll = networkPolicyKey(toOpenSandboxNetworkPolicy("allow-all"));
  const oneDomain = networkPolicyKey(toOpenSandboxNetworkPolicy({ allow: ["github.com"] }));
  assert.equal(new Set([denyAll, allowAll, oneDomain, networkPolicyKey(undefined)]).size, 4);
  // Stable, or every restart would look like a policy change.
  assert.equal(oneDomain, networkPolicyKey(toOpenSandboxNetworkPolicy({ allow: ["github.com"] })));
  // A session persisted before this option existed has no key; "unset" is what
  // it has to compare equal to, or the upgrade breaks every live session.
  assert.equal(networkPolicyKey(undefined), "unset");
});

test("sameNetworkPolicyKey treats no policy and allow-all as the same egress", () => {
  const unset = networkPolicyKey(undefined);
  const allowAll = networkPolicyKey(toOpenSandboxNetworkPolicy("allow-all"));
  const denyAll = networkPolicyKey(toOpenSandboxNetworkPolicy("deny-all"));
  const oneDomain = networkPolicyKey(toOpenSandboxNetworkPolicy({ allow: ["github.com"] }));

  // The keys stay distinct — captureState persists what the sandbox was really
  // created with — but they describe one sandbox state. Comparing the raw
  // strings is what made `networkPolicy: "allow-all"`, a semantic no-op, refuse
  // to reattach to every existing session.
  assert.notEqual(unset, allowAll);
  assert.ok(sameNetworkPolicyKey(unset, allowAll));
  assert.ok(sameNetworkPolicyKey(allowAll, unset));

  // Everything that really is a different egress stays different. A sandbox
  // cannot be moved between these, so reattaching across them has to refuse.
  for (const restricted of [denyAll, oneDomain]) {
    assert.ok(!sameNetworkPolicyKey(unset, restricted), restricted);
    assert.ok(!sameNetworkPolicyKey(allowAll, restricted), restricted);
    assert.ok(sameNetworkPolicyKey(restricted, restricted), restricted);
  }
  assert.ok(!sameNetworkPolicyKey(denyAll, oneDomain));
});
