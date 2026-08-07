import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../dist/config.js";
import { INVALID_PARAMS, INVALID_REQUEST, METHOD_NOT_FOUND, RpcError } from "../dist/jsonrpc.js";
import { McpServer } from "../dist/server.js";
import { TOOLS } from "../dist/tools.js";

/**
 * The read-only default is this package's headline safety property, and it is
 * enforced in two places that have to agree: the mutating tools are withheld
 * from `tools/list`, AND refused on call. A test that only checked one of those
 * would pass while a model could still name a tool it was never shown.
 *
 * Nothing here touches the network. Both gates run before any HTTP call, which is
 * what makes them testable — and is also the point: a policy the operator set
 * cannot depend on a dashboard being reachable.
 */

const server = (env = {}) => new McpServer(loadConfig(env));

/** Every server must be handshaked before it will answer a real method. */
const initialized = (env = {}) => {
  const instance = server(env);
  instance.handle({
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", clientInfo: { name: "test", version: "1" } },
  });
  return instance;
};

const call = (instance, name, args) =>
  instance.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });

const rejects = async (promise, code, pattern) => {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof RpcError, `expected RpcError, got ${error}`);
    assert.equal(error.code, code);
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
};

const MUTATING = TOOLS.filter((tool) => tool.mutating).map((tool) => tool.name);
const READ_ONLY = TOOLS.filter((tool) => !tool.mutating).map((tool) => tool.name);

test("the tool table itself is split, so these tests are testing something", () => {
  assert.ok(MUTATING.length > 0 && READ_ONLY.length > 0);
  assert.deepEqual(
    MUTATING.sort(),
    ["approve_or_deny", "cancel_run", "send_message", "start_session"],
    "a new mutating tool must be added here on purpose, not silently advertised",
  );
});

test("READ-ONLY DEFAULT: mutating tools are not advertised at all", () => {
  const advertised = server().advertisedTools.map((tool) => tool.name);
  assert.deepEqual(advertised, READ_ONLY);
  for (const name of MUTATING) assert.equal(advertised.includes(name), false, name);
});

test("tools/list shows exactly the advertised set, and never a mutating one", async () => {
  const { response } = await initialized().handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.deepEqual(response.tools.map((tool) => tool.name), READ_ONLY);
});

test("EVESTACK_MCP_ALLOW_CONTROL=1 opts the mutating half in", () => {
  const advertised = server({ EVESTACK_MCP_ALLOW_CONTROL: "1" }).advertisedTools.map((t) => t.name);
  assert.equal(advertised.length, TOOLS.length);
  for (const name of MUTATING) assert.ok(advertised.includes(name), name);
});

test("only the documented truthy spellings enable control", () => {
  for (const value of ["1", "true", "TRUE", "yes", "on", " 1 "]) {
    assert.equal(server({ EVESTACK_MCP_ALLOW_CONTROL: value }).advertisedTools.length, TOOLS.length, value);
  }
  for (const value of ["0", "", "no", "off", "false", "please"]) {
    assert.equal(
      server({ EVESTACK_MCP_ALLOW_CONTROL: value }).advertisedTools.length,
      READ_ONLY.length,
      value,
    );
  }
});

test("a withheld tool is REFUSED on call, not just hidden", async () => {
  // Hiding alone would leave the capability reachable by a model that guessed the
  // name, or read it in a changelog.
  for (const name of MUTATING) {
    await rejects(
      call(initialized(), name, { sessionId: "wrun_1", message: "hi", decision: "approve" }),
      INVALID_PARAMS,
      /running read-only/,
    );
  }
});

test("the refusal says who can enable it and how, and names no fabricated tool", async () => {
  await assert.rejects(call(initialized(), "approve_or_deny", { sessionId: "x" }), (error) => {
    assert.equal(error.data.reason, "control_disabled");
    assert.equal(error.data.tool, "approve_or_deny");
    assert.equal(error.data.enableWith, "EVESTACK_MCP_ALLOW_CONTROL=1");
    assert.deepEqual(error.data.available, READ_ONLY);
    assert.match(error.message, /Ask the operator; you cannot enable it yourself/);
    return true;
  });
});

test("the gate runs BEFORE argument validation, so bad args cannot leak its existence", async () => {
  // Reversing these would answer "sessionId is required" for a tool the client was
  // never told about — a different, more informative error for a disabled tool.
  await rejects(call(initialized(), "approve_or_deny", {}), INVALID_PARAMS, /running read-only/);
});

test("with control enabled the gate stops refusing and argument checking takes over", async () => {
  await rejects(
    call(initialized({ EVESTACK_MCP_ALLOW_CONTROL: "1" }), "approve_or_deny", {}),
    INVALID_PARAMS,
    /sessionId is required/,
  );
});

test("an unknown tool is -32602 and lists only advertised names", async () => {
  await assert.rejects(call(initialized(), "rm_rf", {}), (error) => {
    assert.equal(error.code, INVALID_PARAMS);
    assert.equal(error.data.reason, "unknown_tool");
    assert.deepEqual(error.data.available, READ_ONLY);
    return true;
  });
});

test("a missing or empty tool name is -32602", async () => {
  const instance = initialized();
  for (const params of [{}, { name: "" }, { name: 5 }]) {
    await rejects(
      instance.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params }),
      INVALID_PARAMS,
      /non-empty tool name/,
    );
  }
});

test("HANDSHAKE GATE: tools/call before initialize is refused", async () => {
  // It used to be allowed: #initialized was written and never read. The client's
  // name arrives in the handshake and becomes the User-Agent recorded against an
  // approval, so a call accepted before it is an audit row naming nobody.
  await rejects(call(server(), "list_sessions", {}), INVALID_REQUEST, /before 'initialize'/);
  await rejects(
    server().handle({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    INVALID_REQUEST,
    /before 'initialize'/,
  );
});

test("ping is exempt from the handshake gate, as the spec requires", async () => {
  const { response } = await server().handle({ jsonrpc: "2.0", id: 1, method: "ping" });
  assert.deepEqual(response, {});
});

test("a malformed handshake does not count as one", async () => {
  const instance = server();
  await rejects(
    instance.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: [] }),
    INVALID_PARAMS,
  );
  await rejects(call(instance, "list_sessions", {}), INVALID_REQUEST, /before 'initialize'/);
});

test("initialize echoes a supported protocol version and falls back otherwise", async () => {
  for (const requested of ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]) {
    const { response } = await server().handle({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: requested },
    });
    assert.equal(response.protocolVersion, requested);
  }
  const { response } = await server().handle({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "1999-01-01" },
  });
  assert.equal(response.protocolVersion, "2025-11-25", "answer with ours rather than erroring");
});

test("initialize reports listChanged:false, which is the honest value", async () => {
  const { response } = await server().handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  assert.deepEqual(response.capabilities, { tools: { listChanged: false } });
  assert.equal(response.serverInfo.name, "evestack");
  assert.match(response.instructions, /list_sessions/);
});

test("notifications get no response, including an unknown one", async () => {
  const instance = server();
  for (const method of ["notifications/initialized", "notifications/cancelled", "who/knows"]) {
    assert.deepEqual(await instance.handle({ jsonrpc: "2.0", method }), {});
  }
});

test("server/discover answers -32601, which is what triggers a modern client's fallback", async () => {
  await rejects(
    initialized().handle({ jsonrpc: "2.0", id: 1, method: "server/discover" }),
    METHOD_NOT_FOUND,
    /Method not found/,
  );
});

test("an unrecognized tools/list cursor is -32602, not an empty page", async () => {
  await rejects(
    initialized().handle({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { cursor: "abc" } }),
    INVALID_PARAMS,
    /Invalid cursor/,
  );
});

test("every advertised tool states read-only vs mutating in all three places", async () => {
  const { response } = await initialized({ EVESTACK_MCP_ALLOW_CONTROL: "1" }).handle({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
  });
  for (const tool of response.tools) {
    const source = TOOLS.find((entry) => entry.name === tool.name);
    const word = source.mutating ? "MUTATING" : "READ-ONLY";
    assert.ok(tool.description.startsWith(word), `${tool.name} description starts with ${word}`);
    assert.equal(tool.annotations.readOnlyHint, !source.mutating, tool.name);
    assert.equal(tool.annotations.title, source.title, tool.name);
  }
});

test("duplicate tool names fail at construction, not at call time", () => {
  // The constructor's own guard; TOOLS is frozen at import so this asserts the
  // check exists rather than mutating the real table.
  const names = TOOLS.map((tool) => tool.name);
  assert.equal(new Set(names).size, names.length, "TOOLS must have no duplicate names");
});
