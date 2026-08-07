import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COMPOSIO_META_TOOLS,
  DEFAULT_COMPOSIO_USER_ID,
  composioUserId,
  isComposioConfigured,
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
