import assert from "node:assert/strict";
import { test } from "node:test";
import {
  APPROVALS_ENV,
  COMPOSIO_IDENTITY_SEPARATOR,
  COMPOSIO_META_TOOLS,
  DEFAULT_COMPOSIO_USER_ID,
  SHARED_CREDENTIAL_AUTHENTICATORS,
  SHARED_IDENTITY_ENV,
  composioApprovals,
  composioIdentity,
  composioUserId,
  isComposioConfigured,
  isSharedComposioIdentity,
} from "../dist/index.js";

/**
 * The user id is the identity that owns every OAuth grant the agent earns, so
 * "how is it resolved" is a compatibility surface, not a detail: change the
 * answer and the agent silently forgets which accounts it is signed into. These
 * pin the resolution order and the exact default string.
 */

test("the default user id is the literal the dashboard also has to agree with", () => {
  assert.equal(DEFAULT_COMPOSIO_USER_ID, "evestack");
  assert.equal(composioUserId({}), "evestack");
});

test("EVESTACK_COMPOSIO_USER_ID wins when set", () => {
  assert.equal(composioUserId({ EVESTACK_COMPOSIO_USER_ID: "team-a" }), "team-a");
});

test("a blank or whitespace-only override falls back rather than connecting grants to ''", () => {
  for (const value of ["", " ", "\t\n"]) {
    assert.equal(composioUserId({ EVESTACK_COMPOSIO_USER_ID: value }), DEFAULT_COMPOSIO_USER_ID);
  }
});

test("a padded override is trimmed, since a stray space is a different identity", () => {
  assert.equal(composioUserId({ EVESTACK_COMPOSIO_USER_ID: "  team-a  " }), "team-a");
});

test("isComposioConfigured is true only for a non-blank key", () => {
  assert.equal(isComposioConfigured({ COMPOSIO_API_KEY: "ak_1" }), true);
  assert.equal(isComposioConfigured({ COMPOSIO_API_KEY: "  ak_1  " }), true);
  assert.equal(isComposioConfigured({}), false);
  for (const value of ["", " ", "\n"]) {
    assert.equal(isComposioConfigured({ COMPOSIO_API_KEY: value }), false, JSON.stringify(value));
  }
});

test("COMPOSIO_META_TOOLS does not list the legacy execute slug", () => {
  // The router no longer returns COMPOSIO_EXECUTE_TOOL. Listing it meant a caller
  // who spread this into requireApprovalForTools() was gating a tool that never
  // arrives, and would have read that as "execution is approved before it runs".
  assert.equal(COMPOSIO_META_TOOLS.includes("COMPOSIO_EXECUTE_TOOL"), false);
  assert.ok(COMPOSIO_META_TOOLS.includes("COMPOSIO_MULTI_EXECUTE_TOOL"));
});

test("COMPOSIO_META_TOOLS matches the set the README documents, with no duplicates", () => {
  assert.deepEqual([...COMPOSIO_META_TOOLS], [
    "COMPOSIO_SEARCH_TOOLS",
    "COMPOSIO_GET_TOOL_SCHEMAS",
    "COMPOSIO_MANAGE_CONNECTIONS",
    "COMPOSIO_MULTI_EXECUTE_TOOL",
    "COMPOSIO_REMOTE_BASH_TOOL",
    "COMPOSIO_REMOTE_WORKBENCH",
  ]);
  assert.equal(new Set(COMPOSIO_META_TOOLS).size, COMPOSIO_META_TOOLS.length);
  // Every slug is a COMPOSIO_ meta-tool, not an app tool that leaked in.
  for (const slug of COMPOSIO_META_TOOLS) assert.match(slug, /^COMPOSIO_[A-Z_]+$/);
});

/**
 * ─ One Composio identity for everyone ─
 *
 * Everything above pins how the NAMESPACE is resolved. It used to be the whole
 * story: `composioUserId()` was the Composio user id, one string, for every
 * principal that ever reached the agent. Composio hangs OAuth grants off that
 * id, so the Gmail account one person connected through the agent was
 * executable by all of them — every member of a Slack workspace, every holder of
 * a JWT, one inbox. These tests are the isolation the old ones never checked.
 *
 * The contexts below are shaped like eve's `DynamicResolveContext`, and the
 * principals like its `SessionAuthContext`: the field names, and the exact
 * values for `local-dev`, `http-basic`, `none` and the scheduled-run principal,
 * were read out of eve 0.30.8's dist rather than invented.
 */

const ctx = (current, initiator) => ({
  session: { id: "sess_1", auth: { current: current ?? null, initiator: initiator ?? null } },
});

const slack = (userId) => ({
  attributes: {},
  authenticator: "slack-webhook",
  principalId: userId,
  principalType: "user",
});

test("two principals get two different Composio identities", () => {
  // The finding, stated as a test: without this, both sides are "evestack" and
  // whatever Alice connected, Bob can execute.
  const alice = composioIdentity(ctx(slack("U_ALICE")), {}, {});
  const bob = composioIdentity(ctx(slack("U_BOB")), {}, {});

  assert.notEqual(alice, bob);
  assert.notEqual(alice, DEFAULT_COMPOSIO_USER_ID);
  assert.notEqual(bob, DEFAULT_COMPOSIO_USER_ID);
});

test("the same principal resolves to the same identity, every time and after a restart", () => {
  // It is a pure function of the principal, with no process state in it — which
  // is what lets a connected account survive a redeploy.
  assert.equal(
    composioIdentity(ctx(slack("U_ALICE")), {}, {}),
    composioIdentity(ctx(slack("U_ALICE")), {}, {}),
  );
});

test("the same id from two issuers is two people", () => {
  // eve keys its own connection principals `user:${issuer}:${id}` for exactly
  // this reason: "alice" at one identity provider is not "alice" at another.
  const first = composioIdentity(
    ctx({ authenticator: "oidc", issuer: "https://a.example", principalId: "alice" }),
    {},
    {},
  );
  const second = composioIdentity(
    ctx({ authenticator: "oidc", issuer: "https://b.example", principalId: "alice" }),
    {},
    {},
  );
  assert.notEqual(first, second);
});

test("A SINGLE-USER INSTALL IS UNCHANGED: every install-wide principal is the bare namespace", () => {
  // The compatibility half of the fix, and the reason each of these is on the
  // shared list. If any of them started resolving to a namespaced id, an
  // existing install would silently lose the accounts it has already connected:
  // `eve dev` would stop seeing them, or the dashboard would, or every
  // scheduled run would.
  const installWide = [
    { attributes: {}, authenticator: "local-dev", principalId: "local-dev", principalType: "local-dev" },
    { attributes: {}, authenticator: "http-basic", principalId: "evestack", principalType: "user" },
    { attributes: {}, authenticator: "none", principalId: "anonymous", principalType: "anonymous" },
    { attributes: {}, authenticator: "app", principalId: "eve:app", principalType: "runtime" },
  ];
  for (const principal of installWide) {
    assert.equal(
      composioIdentity(ctx(principal), {}, {}),
      DEFAULT_COMPOSIO_USER_ID,
      `${principal.authenticator} must still resolve to the identity its grants are already under`,
    );
  }

  // And so do the shapes that carry no principal at all: a session eve never
  // authenticated, and a caller resolving tools outside a step.
  assert.equal(composioIdentity(ctx(null, null), {}, {}), DEFAULT_COMPOSIO_USER_ID);
  assert.equal(composioIdentity(undefined, {}, {}), DEFAULT_COMPOSIO_USER_ID);
  assert.equal(composioIdentity({}, {}, {}), DEFAULT_COMPOSIO_USER_ID);
});

test("EVESTACK_COMPOSIO_USER_ID still works, now as the namespace under every identity", () => {
  const env = { EVESTACK_COMPOSIO_USER_ID: "team-a" };
  assert.equal(composioIdentity(ctx(null), {}, env), "team-a");
  assert.ok(composioIdentity(ctx(slack("U_ALICE")), {}, env).startsWith("team-a--"));
});

test("the escape hatch puts everyone back on one identity, from either direction", () => {
  // Named and documented rather than left as the default. It is the only way to
  // get the old behaviour, and setting it is a statement that every caller of
  // this agent is the same person.
  const alice = ctx(slack("U_ALICE"));
  const bob = ctx(slack("U_BOB"));

  for (const value of ["1", "true"]) {
    const env = { EVESTACK_COMPOSIO_SHARED_IDENTITY: value };
    assert.equal(composioIdentity(alice, {}, env), DEFAULT_COMPOSIO_USER_ID);
    assert.equal(composioIdentity(bob, {}, env), DEFAULT_COMPOSIO_USER_ID);
  }

  assert.equal(composioIdentity(alice, { shared: true }, {}), DEFAULT_COMPOSIO_USER_ID);
  // An explicit `false` beats the env var, so a caller who has decided cannot be
  // undone by a variable someone left in .env.local.
  assert.notEqual(
    composioIdentity(alice, { shared: false }, { EVESTACK_COMPOSIO_SHARED_IDENTITY: "1" }),
    DEFAULT_COMPOSIO_USER_ID,
  );
});

test("isSharedComposioIdentity reads only the values it documents", () => {
  for (const value of ["1", "true", "TRUE", "yes", "on", " 1 "]) {
    assert.equal(isSharedComposioIdentity({ EVESTACK_COMPOSIO_SHARED_IDENTITY: value }), true, value);
  }
  for (const value of ["0", "false", "off", "", "  ", "maybe", undefined]) {
    assert.equal(
      isSharedComposioIdentity({ EVESTACK_COMPOSIO_SHARED_IDENTITY: value }),
      false,
      JSON.stringify(value),
    );
  }
});

test("the current caller wins over the one who opened the session", () => {
  // Same precedence as principalOf() in @evestack/budget: a shared session is
  // charged to, and here acts as, whoever is actually driving it.
  assert.equal(
    composioIdentity(ctx(slack("U_BOB"), slack("U_ALICE")), {}, {}),
    composioIdentity(ctx(slack("U_BOB")), {}, {}),
  );

  // With no current caller it falls back to the initiator rather than to the
  // installation, because a session opened by Alice is still Alice's.
  assert.equal(
    composioIdentity(ctx(null, slack("U_ALICE")), {}, {}),
    composioIdentity(ctx(slack("U_ALICE")), {}, {}),
  );
});

test("sharedAuthenticators is overridable, for an install with several Basic users", () => {
  const two = ["alice", "bob"].map((name) =>
    composioIdentity(
      ctx({ authenticator: "http-basic", principalId: name, principalType: "user" }),
      { sharedAuthenticators: ["local-dev"] },
      {},
    ),
  );
  assert.notEqual(two[0], two[1]);
  for (const identity of two) assert.notEqual(identity, DEFAULT_COMPOSIO_USER_ID);
});

test("an authenticator nobody has heard of is treated as a person, not as the install", () => {
  // Fails closed. The cost of being wrong this way is one extra Connect Link;
  // the cost of the other way is one shared mailbox.
  assert.notEqual(
    composioIdentity(ctx({ authenticator: "some-future-sso", principalId: "alice" }), {}, {}),
    DEFAULT_COMPOSIO_USER_ID,
  );
});

test("a principal with no usable id gets a dead end, never the installation's accounts", () => {
  for (const principalId of [undefined, "", "   "]) {
    const identity = composioIdentity(ctx({ authenticator: "oidc", principalId }), {}, {});
    assert.notEqual(identity, DEFAULT_COMPOSIO_USER_ID, JSON.stringify(principalId));
    assert.match(identity, /unidentified/);
  }
});

test("a hostile principal id cannot shape the Composio user id", () => {
  // principalId can be attacker-supplied (a JWT subject, a webhook payload), and
  // it travels to Composio as a user id — so it is sanitized to the
  // URL-unreserved set and bounded in length rather than passed through.
  const nasty = `../../admin?x=1 &${"A".repeat(400)}${String.fromCharCode(10, 0)}`;
  const identity = composioIdentity(ctx({ authenticator: "oidc", principalId: nasty }), {}, {});
  assert.match(identity, /^[A-Za-z0-9._-]+$/);
  assert.ok(identity.length < 120, `identity was ${identity.length} characters`);
});

test("truncation cannot merge two people into one identity", () => {
  // The readable half of the identity is truncated, which is lossy; the digest
  // after it is taken over the untruncated principal, which is what keeps two
  // long ids sharing a prefix apart.
  const long = (suffix) => ctx({ authenticator: "oidc", principalId: `${"u".repeat(200)}${suffix}` });
  assert.notEqual(composioIdentity(long("1"), {}, {}), composioIdentity(long("2"), {}, {}));

  // Same for two ids that differ only in characters that sanitize to `_`.
  const punctuated = (id) => ctx({ authenticator: "oidc", principalId: id });
  assert.notEqual(
    composioIdentity(punctuated("alice@example.com"), {}, {}),
    composioIdentity(punctuated("alice+example.com"), {}, {}),
  );
});

test("an isolated identity is recognisable as one, and namespaced under the install", () => {
  const identity = composioIdentity(ctx(slack("U_ALICE")), {}, {});
  assert.ok(identity.startsWith(`${DEFAULT_COMPOSIO_USER_ID}${COMPOSIO_IDENTITY_SEPARATOR}`));
  // The label carries enough to recognise the principal in Composio's own
  // dashboard without reversing a hash.
  assert.match(identity, /slack-webhook_U_ALICE/);
});

test("SHARED_CREDENTIAL_AUTHENTICATORS is the documented set, with no duplicates", () => {
  assert.deepEqual([...SHARED_CREDENTIAL_AUTHENTICATORS], ["local-dev", "http-basic", "none", "app"]);
  assert.equal(new Set(SHARED_CREDENTIAL_AUTHENTICATORS).size, SHARED_CREDENTIAL_AUTHENTICATORS.length);
});

test("the env-name constants are the names the code actually reads", () => {
  // The two are written out separately on purpose — see the comment on
  // isSharedComposioIdentity: the reads are dotted so the env-names contract can
  // find them, and the constants exist for the README and the log line. This is
  // the tie that stops them drifting into two different variable names, one of
  // which would be documented and never read.
  assert.equal(SHARED_IDENTITY_ENV, "EVESTACK_COMPOSIO_SHARED_IDENTITY");
  assert.equal(APPROVALS_ENV, "EVESTACK_COMPOSIO_APPROVALS");
  assert.equal(isSharedComposioIdentity({ [SHARED_IDENTITY_ENV]: "1" }), true);
  assert.equal(composioApprovals({ [APPROVALS_ENV]: "off" }), undefined);
  assert.equal(
    composioIdentity(ctx(slack("U_ALICE")), {}, { [SHARED_IDENTITY_ENV]: "1" }),
    DEFAULT_COMPOSIO_USER_ID,
  );
});
