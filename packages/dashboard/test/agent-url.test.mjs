/**
 * The URL printed for a human to paste must be one that resolves for them.
 *
 * The dashboard runs in a container whose EVESTACK_AGENT_URL is
 * `http://host.docker.internal:2001` — right for a fetch from inside, and
 * unusable in the terminal the Sessions empty state invites you to paste into,
 * where that name does not resolve at all. A name that does not resolve reads as
 * a network problem; a wrong port at least fails immediately.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { agentBaseUrl, agentUrlForHumans } from "../lib/agent-client.ts";

let saved;
beforeEach(() => {
  saved = process.env.EVESTACK_AGENT_URL;
  delete process.env.EVESTACK_AGENT_URL;
});
afterEach(() => {
  if (saved === undefined) delete process.env.EVESTACK_AGENT_URL;
  else process.env.EVESTACK_AGENT_URL = saved;
});

test("a container-only host becomes one a person can type, port intact", () => {
  process.env.EVESTACK_AGENT_URL = "http://host.docker.internal:2001";
  assert.equal(agentUrlForHumans(), "http://localhost:2001");
  // and the address the process itself uses is untouched
  assert.equal(agentBaseUrl(), "http://host.docker.internal:2001");
});

test("a bind-all address is not a destination either", () => {
  process.env.EVESTACK_AGENT_URL = "http://0.0.0.0:2003";
  assert.equal(agentUrlForHumans(), "http://localhost:2003");
});

test("a real hostname is left exactly as configured", () => {
  process.env.EVESTACK_AGENT_URL = "https://agent.example.com";
  assert.equal(agentUrlForHumans(), "https://agent.example.com");
  process.env.EVESTACK_AGENT_URL = "http://127.0.0.1:2000";
  assert.equal(agentUrlForHumans(), "http://127.0.0.1:2000");
});

test("a host that merely contains the magic name is not rewritten", () => {
  // `host.docker.internal.evil.example` must not be mistaken for the Docker
  // alias, and neither must a host that ends with it.
  process.env.EVESTACK_AGENT_URL = "http://host.docker.internal.evil.example:2000";
  assert.equal(agentUrlForHumans(), "http://host.docker.internal.evil.example:2000");
});
