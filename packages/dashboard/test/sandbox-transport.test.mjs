import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listSandboxes,
  cpuFraction,
  SANDBOX_INSPECTION_LIMIT,
} from "../lib/sandboxes.ts";
import { evaluateAlerts } from "../lib/alerts.ts";
import { installStubPool, uninstallStubPool } from "./stub-pool.mjs";

test("bounded read-only Docker inspection over a local fixture socket", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "es-d-"));
  const socket =
    process.platform === "win32"
      ? `\\\\.\\pipe\\evestack-test-${randomUUID()}`
      : join(dir, "api.sock");
  const previous = process.env.EVESTACK_DOCKER_SOCKET;
  let mode = "valid",
    active = 0,
    maxActive = 0;
  let calls = [];
  const timers = new Set();
  const inventory = Array.from({ length: 40 }, (_, index) => ({
    Id: (index + 1).toString(16).padStart(64, "0"),
    Names: [`/fixture-${index + 1}`],
    Image: "fixture-only",
    State: "running",
    Created: index + 1,
    Labels: {},
  }));
  const server = createServer((req, res) => {
    calls.push({ method: req.method, url: req.url });
    active++;
    maxActive = Math.max(maxActive, active);
    res.on("close", () => active--);
    res.setHeader("content-type", "application/json");
    if (req.url.startsWith("/containers/json?")) {
      if (mode === "large-header") {
        res.setHeader("content-length", 2 * 1024 * 1024 + 1);
        res.flushHeaders();
        return;
      }
      if (mode === "large-stream") {
        res.write(Buffer.alloc(1024 * 1024, 32));
        res.end(Buffer.alloc(1024 * 1024 + 1, 32));
        return;
      }
      if (mode === "trickle") {
        res.write("[");
        const timer = setInterval(() => res.write(" "), 30);
        timers.add(timer);
        res.on("close", () => {
          clearInterval(timer);
          timers.delete(timer);
        });
        return;
      }
      if (mode === "http-error") {
        res.statusCode = 503;
        res.end("PRIVATE-CREDENTIAL-IN-ERROR");
        return;
      }
      if (mode === "json-error") {
        res.end("PRIVATE-CREDENTIAL-NOT-JSON");
        return;
      }
      if (mode === "shape") {
        res.end('{"unexpected":true}');
        return;
      }
      if (mode === "path") {
        res.end(JSON.stringify([{ Id: "../create?Privileged=true" }]));
        return;
      }
      if (mode === "duplicate") {
        res.end(JSON.stringify([inventory[0], inventory[0]]));
        return;
      }
      res.end(
        JSON.stringify(mode === "partial" ? inventory.slice(0, 1) : inventory),
      );
      return;
    }
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (req.url.endsWith("/json")) {
        if (mode === "partial") {
          res.statusCode = 503;
          res.end("inspection unavailable");
          return;
        }
        res.end(
          JSON.stringify({
            State: { StartedAt: new Date(Date.now() - 30000).toISOString() },
            HostConfig: { NetworkMode: "none" },
          }),
        );
        return;
      }
      // Deliberately lacks a previous CPU sample. Missing metrics stay unknown.
      res.end(
        JSON.stringify({
          cpu_stats: {
            cpu_usage: { total_usage: 100 },
            system_cpu_usage: 1000,
            online_cpus: 4,
          },
          memory_stats: { usage: "wrong-type", limit: -1 },
          networks: { eth0: { rx_bytes: 100 } },
          pids_stats: { current: "unknown" },
        }),
      );
    }, 40);
    timers.add(timer);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, resolve);
  });
  process.env.EVESTACK_DOCKER_SOCKET = socket;
  installStubPool([[/./, new Error("Fixture database unavailable")]]);
  t.after(async () => {
    uninstallStubPool();
    if (previous === undefined) delete process.env.EVESTACK_DOCKER_SOCKET;
    else process.env.EVESTACK_DOCKER_SOCKET = previous;
    for (const timer of timers) clearTimeout(timer);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });
  await t.test(
    "inspection is limited and concurrent requests stay bounded without any mutation verb",
    async () => {
      const result = await listSandboxes();
      assert.equal(result.kind, "ok");
      assert.deepEqual(result.coverage, {
        listed: 40,
        inspected: 24,
        omitted: 16,
        limit: SANDBOX_INSPECTION_LIMIT,
      });
      assert.equal(result.sandboxes.length, 24);
      assert.ok(maxActive <= 12, `observed ${maxActive} concurrent requests`);
      assert.equal(calls.length, 1 + 24 * 2);
      assert.ok(calls.every((call) => call.method === "GET"));
      assert.ok(
        result.sandboxes.every((box) => Number.parseInt(box.id, 16) <= 24),
      );
      for (const box of result.sandboxes) {
        assert.equal(box.stats.cpu, null);
        assert.equal(box.stats.memoryBytes, null);
        assert.equal(box.stats.memoryLimitBytes, null);
        assert.equal(box.stats.pids, null);
        assert.equal(box.stats.networkRxBytes, 100);
        assert.equal(box.stats.networkTxBytes, null);
      }
    },
  );
  await t.test(
    "omitted containers prevent healthy network/lifetime claims in real alert evaluation",
    async () => {
      const alerts = await evaluateAlerts();
      for (const id of ["sandbox_networked", "sandbox_long_lived"]) {
        const alert = alerts.find((item) => item.id === id);
        assert.equal(alert.state, "unknown");
        assert.match(alert.detail, /16 additional containers were omitted/);
      }
    },
  );
  await t.test("failed inspections remain visibly unreadable", async () => {
    mode = "partial";
    const result = await listSandboxes();
    assert.equal(result.kind, "ok");
    assert.equal(result.coverage.omitted, 0);
    assert.equal(result.sandboxes[0].networkMode, null);
    assert.equal(result.sandboxes[0].uptimeMs, null);
  });
  await t.test(
    "declared and streamed oversized responses fail without buffering an unbounded body",
    async () => {
      for (const next of ["large-header", "large-stream"]) {
        mode = next;
        const result = await listSandboxes();
        assert.equal(result.kind, "unreachable");
        assert.match(result.reason, /2 MiB/);
      }
    },
  );
  await t.test(
    "an absolute deadline stops a server that continuously sends bytes",
    { timeout: 8000 },
    async () => {
      mode = "trickle";
      const started = Date.now();
      const result = await listSandboxes();
      assert.equal(result.kind, "unreachable");
      assert.match(result.reason, /3000ms/);
      assert.ok(Date.now() - started < 6000);
    },
  );
  await t.test(
    "bad status, JSON, inventory and IDs never expose response contents or become API paths",
    async () => {
      for (const next of [
        "http-error",
        "json-error",
        "shape",
        "path",
        "duplicate",
      ]) {
        mode = next;
        calls = [];
        const result = await listSandboxes();
        assert.equal(result.kind, "unreachable");
        assert.doesNotMatch(result.reason, /PRIVATE|Privileged/);
        assert.equal(calls.length, 1);
      }
    },
  );
});

test("CPU needs two finite nonnegative samples and a finite result", () => {
  const now = {
    cpu_usage: { total_usage: 10 },
    system_cpu_usage: 100,
    online_cpus: 4,
  };
  assert.equal(cpuFraction({ cpu_stats: now }), null);
  assert.equal(cpuFraction({ cpu_stats: { cpu_usage: { total_usage: 10 }, system_cpu_usage: 100 }, precpu_stats: { cpu_usage: { total_usage: 0 }, system_cpu_usage: 0 } }), null, "a missing core count is unknown");
  assert.equal(
    cpuFraction({
      cpu_stats: now,
      precpu_stats: { cpu_usage: { total_usage: "0" }, system_cpu_usage: 0 },
    }),
    null,
  );
  assert.equal(
    cpuFraction({
      cpu_stats: { ...now, online_cpus: NaN },
      precpu_stats: { cpu_usage: { total_usage: 0 }, system_cpu_usage: 0 },
    }),
    null,
  );
});
