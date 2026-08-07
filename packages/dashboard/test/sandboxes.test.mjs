import assert from "node:assert/strict";
import { test } from "node:test";

import { concerns, cpuFraction, ORPHAN_AFTER_MS, SANDBOX_LABELS } from "../lib/sandboxes.ts";

/**
 * The editorial rules of the sandboxes page, tested without a daemon.
 *
 * `concerns` decides the only three things the page interrupts anyone about, so
 * it is a pure function rather than a condition inside JSX — a rule that lives
 * in a template cannot be checked, and these are exactly the rules a reader
 * will trust without verifying.
 */

const box = (over = {}) => ({
  id: "c1",
  name: "sbx",
  image: "alpine",
  state: "running",
  status: "Up",
  startedAt: new Date().toISOString(),
  uptimeMs: 1000,
  networkMode: "none",
  sessionId: "wrun_1",
  agent: null,
  channel: null,
  templateKey: null,
  role: "session",
  stats: null,
  ...over,
});

test("an isolated sandbox with a live session is not a concern", () => {
  assert.deepEqual(concerns([box()], new Set(["wrun_1"])), []);
});

test("a sandbox that can reach the network is always flagged", () => {
  const flags = concerns([box({ networkMode: "bridge" })], new Set(["wrun_1"]));
  assert.deepEqual(
    flags.map((f) => f.kind),
    ["networked"],
  );
  // `none` is eve's isolated setting and the only one that is not a concern.
  assert.deepEqual(concerns([box({ networkMode: "none" })], new Set(["wrun_1"])), []);
});

test("a container outliving its session is flagged, which is how they pile up", () => {
  const flags = concerns([box({ sessionId: "wrun_gone" })], new Set(["wrun_1"]));
  assert.deepEqual(
    flags.map((f) => f.kind),
    ["session-gone"],
  );
});

test("a sandbox with no session label is not called an orphan", () => {
  // A container with no sessionId names no session, so it cannot have outlived
  // one. Flagging it would make every non-session sandbox look abandoned.
  assert.deepEqual(concerns([box({ sessionId: null })], new Set()), []);
});

test("long-lived only counts past the threshold", () => {
  assert.deepEqual(concerns([box({ uptimeMs: ORPHAN_AFTER_MS - 1 })], new Set(["wrun_1"])), []);
  assert.deepEqual(
    concerns([box({ uptimeMs: ORPHAN_AFTER_MS + 1 })], new Set(["wrun_1"])).map((f) => f.kind),
    ["orphaned"],
  );
});

test("a stopped container is never a concern, whatever it looks like", () => {
  // An exited sandbox holds nothing open. It is still LISTED — it is evidence
  // for a wedged session — but it is not something to act on.
  const dead = box({ state: "exited", networkMode: "bridge", uptimeMs: null, sessionId: "wrun_gone" });
  assert.deepEqual(concerns([dead], new Set()), []);
});

test("one container can be flagged more than once", () => {
  const bad = box({ networkMode: "bridge", uptimeMs: ORPHAN_AFTER_MS + 1, sessionId: "wrun_gone" });
  assert.deepEqual(
    concerns([bad], new Set()).map((f) => f.kind).sort(),
    ["networked", "orphaned", "session-gone"],
  );
});

/**
 * CPU comes from two cumulative counters, so the first sample after a container
 * starts has nothing to subtract from. Returning 0 there would render "0%" —
 * reading as idle for a container that may be pinning a core.
 */
test("cpu is null when it cannot yet be known, not zero", () => {
  assert.equal(cpuFraction({}), null);
  assert.equal(
    cpuFraction({
      cpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 0, online_cpus: 4 },
      precpu_stats: { cpu_usage: { total_usage: 0 }, system_cpu_usage: 0 },
    }),
    null,
    "a zero system delta is unknowable, not idle",
  );
});

test("cpu is a fraction of one core, so it can exceed 1 on a busy multicore box", () => {
  const busy = cpuFraction({
    cpu_stats: { cpu_usage: { total_usage: 200 }, system_cpu_usage: 400, online_cpus: 4 },
    precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 200 },
  });
  // 100/200 of the machine, times 4 cores = 2 cores.
  assert.equal(busy, 2);
});

/**
 * The sandbox labels are eve's, not ours.
 *
 * `eve.sandbox`, `eve.sandbox.role`, `eve.sandbox.tag.*` and
 * `eve.sandbox.template-key` are written by `eve/sandbox/docker` upstream — no
 * code in this repo authors them. That makes them a contract in the same
 * category as the `$eve.*` run attributes, and a rename upstream empties the
 * sandboxes page in silence rather than failing.
 *
 * `09-sandbox-backend.contract.mjs` guards the backend INTERFACE shape and
 * asserts nothing about label names, which is the gap this closes. It is a unit
 * test rather than a contract because eve's dist does not carry the label
 * strings as literals — they are assembled — so the strongest available check
 * is that the reader and the page agree on one spelling.
 */
test("every label the page reads is the one the client looks for", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const here = dirname(fileURLToPath(import.meta.url));

  const src = readFileSync(join(here, "..", "lib", "sandboxes.ts"), "utf8");
  const declared = [...src.matchAll(/"(eve\.sandbox[a-z.-]*)"/g)].map((m) => m[1]);

  // Every label string in the module is reachable through SANDBOX_LABELS, so
  // there is exactly one place to change when upstream renames one.
  const viaMap = new Set(Object.values(SANDBOX_LABELS));
  for (const label of declared) {
    assert.ok(viaMap.has(label), `${label} is hard-coded somewhere instead of going through SANDBOX_LABELS`);
  }

  // And the marker is the one the Docker filter uses, or the page lists nothing.
  assert.equal(SANDBOX_LABELS.marker, "eve.sandbox");
  assert.ok(SANDBOX_LABELS.sessionId.startsWith("eve.sandbox.tag."));
});
