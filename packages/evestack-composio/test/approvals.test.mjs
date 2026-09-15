import assert from "node:assert/strict";
import { test } from "node:test";
import {
  APPROVAL_GATED_META_TOOLS,
  composioApprovals,
  composioProviderOptions,
  isReadOnlyComposioTool,
  requireApprovalForWrites,
} from "../dist/index.js";

/**
 * Its own file, rather than more of identity.test.mjs, because it is a different
 * question with a different failure: that one asks "whose accounts are these",
 * this one asks "who said the agent could use them".
 *
 * The asymmetry it exists to close: `agent/tools/forget.ts` parks the turn and
 * waits for a human to delete one row of local memory, while
 * `COMPOSIO_MULTI_EXECUTE_TOOL` would send mail from the user's account and post
 * to their Slack with nothing in the loop at all — `needsApproval` was simply
 * never set on the provider. Deleting a note asked. Sending the email did not.
 *
 * The batch shape below (`{ tools: [{ tool_slug }] }`) is not invented: it is
 * what `requireApprovalForTools` in @composio/experimental 0.2.1 reads out of
 * `context.toolInput`, which makes it the authority on what the model actually
 * sends.
 */

/** The two arguments EveProvider hands an EveNeedsApproval policy. */
const call = (slug, toolInput) => [{ slug }, { approvedTools: new Set(), callId: "call_1", toolName: slug, toolInput }];

const batch = (...slugs) => ({ tools: slugs.map((slug) => ({ tool_slug: slug, arguments: {} })) });

const asks = (policy, slug, toolInput) => policy(...call(slug, toolInput));

test("connecting an account always asks, because it is how the agent gains a capability", () => {
  // Once or twice a year, and it binds an OAuth grant to this agent's Composio
  // identity. There is no version of "too noisy" that applies to it.
  const policy = requireApprovalForWrites();
  assert.equal(asks(policy, "COMPOSIO_MANAGE_CONNECTIONS", { toolkit: "gmail" }), true);
});

test("the remote sandbox tools ask, when they exist at all", () => {
  const policy = requireApprovalForWrites();
  assert.equal(asks(policy, "COMPOSIO_REMOTE_BASH_TOOL", { command: "ls" }), true);
  assert.equal(asks(policy, "COMPOSIO_REMOTE_WORKBENCH", {}), true);
});

test("reading the catalog never asks, so approvals stay meaningful", () => {
  // A policy that prompts for everything trains people to click yes, which is a
  // worse outcome than not prompting.
  const policy = requireApprovalForWrites();
  assert.equal(asks(policy, "COMPOSIO_SEARCH_TOOLS", { query: "send email" }), false);
  assert.equal(asks(policy, "COMPOSIO_GET_TOOL_SCHEMAS", { tools: ["GMAIL_SEND_EMAIL"] }), false);
});

test("THE ONE THAT MATTERS: a write inside a batched execute asks", () => {
  // The model does not call GMAIL_SEND_EMAIL. It calls
  // COMPOSIO_MULTI_EXECUTE_TOOL with the real tool buried in its arguments, so a
  // policy that only looks at the outer slug gates nothing at all.
  const policy = requireApprovalForWrites();
  assert.equal(asks(policy, "COMPOSIO_MULTI_EXECUTE_TOOL", batch("GMAIL_SEND_EMAIL")), true);
  assert.equal(
    asks(policy, "COMPOSIO_MULTI_EXECUTE_TOOL", batch("GMAIL_FETCH_EMAILS", "SLACK_SEND_MESSAGE")),
    true,
    "one write anywhere in the batch is enough",
  );
});

test("a batch of pure reads runs unattended", () => {
  const policy = requireApprovalForWrites();
  assert.equal(
    asks(policy, "COMPOSIO_MULTI_EXECUTE_TOOL", batch("GMAIL_FETCH_EMAILS", "GITHUB_LIST_ISSUES")),
    false,
  );
});

test("a batch that cannot be read asks", () => {
  // The SDK's own requireApprovalForTools returns false here, which is right for
  // "gate these named tools" and wrong for "gate anything that writes": an
  // unreadable batch is precisely the shape that must not slip through.
  const policy = requireApprovalForWrites();
  const unreadable = [
    undefined,
    {},
    { tools: "GMAIL_SEND_EMAIL" },
    { tools: [null] },
    { tools: [{ toolSlug: "GMAIL_FETCH_EMAILS" }] },
    { tools: [{ tool_slug: 42 }] },
  ];
  for (const toolInput of unreadable) {
    assert.equal(
      asks(policy, "COMPOSIO_MULTI_EXECUTE_TOOL", toolInput),
      true,
      JSON.stringify(toolInput ?? null),
    );
  }
});

test("the legacy single-execute slug is read the same way, not waved through", () => {
  // The current router does not return COMPOSIO_EXECUTE_TOOL — which is why it
  // is not in COMPOSIO_META_TOOLS — but the SDK still routes hooks for it, and a
  // slug this policy does not recognise must not pass just because it starts
  // with COMPOSIO_.
  const policy = requireApprovalForWrites();
  assert.equal(asks(policy, "COMPOSIO_EXECUTE_TOOL", { tool_slug: "GMAIL_SEND_EMAIL" }), true);
  assert.equal(asks(policy, "COMPOSIO_EXECUTE_TOOL", { tool_slug: "GMAIL_FETCH_EMAILS" }), false);
  assert.equal(asks(policy, "COMPOSIO_EXECUTE_TOOL", {}), true);
});

test("an unknown COMPOSIO_ meta-tool asks", () => {
  const policy = requireApprovalForWrites();
  assert.equal(asks(policy, "COMPOSIO_SOMETHING_NEW", {}), true);
});

test("an app tool the router exposes directly is judged on its own slug", () => {
  const policy = requireApprovalForWrites();
  assert.equal(asks(policy, "GMAIL_SEND_EMAIL", { to: "a@b.c" }), true);
  assert.equal(asks(policy, "GMAIL_FETCH_EMAILS", {}), false);
});

test("alsoRequire gates the reads a particular install considers sensitive", () => {
  const policy = requireApprovalForWrites("GMAIL_FETCH_EMAILS");
  assert.equal(asks(policy, "GMAIL_FETCH_EMAILS", {}), true);
  assert.equal(asks(policy, "COMPOSIO_MULTI_EXECUTE_TOOL", batch("GMAIL_FETCH_EMAILS")), true);
  assert.equal(asks(policy, "COMPOSIO_MULTI_EXECUTE_TOOL", batch("GITHUB_LIST_ISSUES")), false);
  // Case and padding are the caller's, not the model's, so neither should matter.
  assert.equal(asks(requireApprovalForWrites(" gmail_fetch_emails "), "GMAIL_FETCH_EMAILS", {}), true);
});

test("the read/write rule reads both ends of a slug, and fails closed on the rest", () => {
  // Composio slugs are TOOLKIT_ACTION in caps and both word orders are in the
  // catalog, so the verb can be at either end.
  for (const slug of [
    "GMAIL_FETCH_EMAILS",
    "GITHUB_LIST_ISSUES",
    "GOOGLECALENDAR_EVENTS_LIST",
    "NOTION_SEARCH_PAGES",
    "SLACK_GET_CHANNEL_INFO",
  ]) {
    assert.equal(isReadOnlyComposioTool(slug), true, slug);
  }

  for (const slug of [
    "GMAIL_SEND_EMAIL",
    "SLACK_SEND_MESSAGE",
    "GITHUB_CREATE_ISSUE",
    "STRIPE_CREATE_PAYMENT",
    "GMAIL_DELETE_DRAFT_LIST", // a write verb anywhere beats the read verb at the end
    "NOTION_PAGES_ARCHIVE",
  ]) {
    assert.equal(isReadOnlyComposioTool(slug), false, slug);
  }

  // Shapes with no readable verb at all: unknown means ask.
  for (const slug of ["", "GMAIL", "NOTION_PAGES", "_", "SOMETOOL_DOES_SOMETHING"]) {
    assert.equal(isReadOnlyComposioTool(slug), false, JSON.stringify(slug));
  }

  // Case is not the model's to decide.
  assert.equal(isReadOnlyComposioTool("gmail_send_email"), false);
  assert.equal(isReadOnlyComposioTool("gmail_fetch_emails"), true);
});

test("APPROVAL_GATED_META_TOOLS is the documented set", () => {
  assert.deepEqual([...APPROVAL_GATED_META_TOOLS], [
    "COMPOSIO_MANAGE_CONNECTIONS",
    "COMPOSIO_REMOTE_BASH_TOOL",
    "COMPOSIO_REMOTE_WORKBENCH",
  ]);
});

test("composioApprovals is on by default and off only when asked", () => {
  assert.equal(typeof composioApprovals({}), "function");
  for (const value of ["off", "OFF", "0", "false", "none", " off "]) {
    assert.equal(composioApprovals({ EVESTACK_COMPOSIO_APPROVALS: value }), undefined, value);
  }
  // Anything else is not a way to turn a security control off by accident.
  for (const value of ["on", "", "yes", "maybe"]) {
    assert.equal(typeof composioApprovals({ EVESTACK_COMPOSIO_APPROVALS: value }), "function", value);
  }
});

test("THE FIX: an agent that configures nothing still gets an approval policy", () => {
  // `needsApproval` was never set, on any path, by any caller — which is how
  // COMPOSIO_MULTI_EXECUTE_TOOL came to run with no human in the loop. The
  // default is now the safe one.
  assert.equal(typeof composioProviderOptions().needsApproval, "function");
  assert.equal(typeof composioProviderOptions({ provider: { strict: true } }).needsApproval, "function");
});

test("a caller's own policy is never quietly replaced, including 'no policy'", () => {
  const mine = () => true;
  assert.equal(composioProviderOptions({ provider: { needsApproval: mine } }).needsApproval, mine);

  // `needsApproval: undefined` written out is a decision, not an omission. It is
  // also exactly what EveProvider reads as "no approval policy", so this is the
  // in-code twin of EVESTACK_COMPOSIO_APPROVALS=off.
  assert.equal(
    composioProviderOptions({ provider: { needsApproval: undefined } }).needsApproval,
    undefined,
  );
});

test("the connect-link hook survives the approval wiring", () => {
  // Both live on the provider options, and an earlier draft of this function
  // built `hooks` and `needsApproval` in two places; a spread in the wrong order
  // would silently drop one of them.
  const seen = [];
  const options = composioProviderOptions({ onConnectLink: (url) => seen.push(url) });
  assert.equal(typeof options.hooks?.onAuthLink, "function");
  options.hooks.onAuthLink({ url: "https://backend.composio.dev/s/abc" }, () => "next");
  assert.deepEqual(seen, ["https://backend.composio.dev/s/abc"]);
});
