import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  heartbeatQuietState,
  heartbeatPrompt,
  heartbeatTarget,
  readHeartbeatTasks,
} from "../lib/heartbeat.ts";

const quiet = (at, hours = "22:00-08:00", zone = "America/Toronto") =>
  heartbeatQuietState(
    {
      EVESTACK_HEARTBEAT_QUIET_HOURS: hours,
      EVESTACK_HEARTBEAT_QUIET_TIMEZONE: zone,
    },
    new Date(at),
  ).quiet;

test("quiet hours include the start and exclude the end, across midnight", () => {
  assert.equal(quiet("2026-09-16T01:59:00Z"), false);
  assert.equal(quiet("2026-09-16T02:00:00Z"), true);
  assert.equal(quiet("2026-09-16T11:59:59Z"), true);
  assert.equal(quiet("2026-09-16T12:00:00Z"), false);
  assert.equal(quiet("2026-09-16T12:30:00Z", "12:00-13:00", "UTC"), true);
  assert.equal(quiet("2026-09-16T13:00:00Z", "12:00-13:00", "UTC"), false);
});

test("local quiet hours cover both repeated DST readings, gaps and half-hour offsets", () => {
  for (const at of ["2026-11-01T05:30:00Z", "2026-11-01T06:30:00Z"])
    assert.equal(quiet(at, "01:00-02:00"), true);
  assert.equal(quiet("2026-11-01T07:00:00Z", "01:00-02:00"), false);
  assert.equal(quiet("2026-03-08T06:59:00Z", "01:00-03:00"), true);
  assert.equal(quiet("2026-03-08T07:00:00Z", "01:00-03:00"), false);
  assert.equal(
    quiet("2026-09-15T16:30:00Z", "22:00-08:00", "Asia/Kolkata"),
    true,
  );
  assert.equal(
    quiet("2026-09-15T16:29:00Z", "22:00-08:00", "Asia/Kolkata"),
    false,
  );
});

test("invalid quiet hours refuse dispatch instead of widening the window", () => {
  for (const hours of [
    "22-08",
    "24:00-08:00",
    "22:60-08:00",
    "08:00-08:00",
    "nope",
  ])
    assert.throws(() =>
      heartbeatQuietState({ EVESTACK_HEARTBEAT_QUIET_HOURS: hours }),
    );
  assert.throws(() =>
    heartbeatQuietState({ EVESTACK_HEARTBEAT_QUIET_TIMEZONE: "not/a-zone" }),
  );
  assert.equal(heartbeatQuietState({}).quiet, false);
  assert.throws(() => heartbeatQuietState({}, new Date("bad")));
});

test("tasks are bounded, UTF-8, and commented examples do not cause model work", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "heartbeat-policy-"));
  try {
    assert.equal(await readHeartbeatTasks({}, cwd), null);
    const path = join(cwd, "HEARTBEAT.md");
    writeFileSync(path, "<!-- Example: do expensive work. -->\n  ");
    assert.equal(await readHeartbeatTasks({}, cwd), null);
    writeFileSync(path, "<!-- editing note -->\nCheck saved memories.");
    assert.equal(await readHeartbeatTasks({}, cwd), "Check saved memories.");
    writeFileSync(path, Buffer.alloc(65537));
    await assert.rejects(readHeartbeatTasks({}, cwd), /64 KiB/);
    writeFileSync(path, Buffer.from([255]));
    await assert.rejects(readHeartbeatTasks({}, cwd), /UTF-8/);
    await assert.rejects(
      readHeartbeatTasks({ EVESTACK_HEARTBEAT_FILE: "." }, cwd),
      /regular file/,
    );
    const shipped = readFileSync(
      new URL("../HEARTBEAT.md", import.meta.url),
      "utf8",
    );
    writeFileSync(path, shipped);
    assert.equal(
      await readHeartbeatTasks({}, cwd),
      null,
      "a fresh scaffold has no active checks",
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("target errors are bounded and never echo raw JSON", () => {
  assert.deepEqual(
    heartbeatTarget({ EVESTACK_HEARTBEAT_TARGET: '{"chatId":123}' }),
    { chatId: 123 },
  );
  for (const raw of [
    undefined,
    "[]",
    "null",
    "{sensitive-input",
    "x".repeat(4097),
  ]) {
    assert.throws(
      () => heartbeatTarget({ EVESTACK_HEARTBEAT_TARGET: raw }),
      (error) => !error.message.includes("sensitive-input"),
    );
  }
});

test("the executable preview prints the same prompt, recipients and gate without running work", () => {
  const cwd = mkdtempSync(join(tmpdir(), "heartbeat-preview-"));
  try {
    writeFileSync(join(cwd, "HEARTBEAT.md"), "Check the saved release note.");
    const env = {
      ...process.env,
      EVESTACK_HEARTBEAT_CHANNEL: "telegram",
      EVESTACK_HEARTBEAT_TARGET: '{"chatId":123}',
      EVESTACK_HEARTBEAT_CRON: "0 * * * *",
      EVESTACK_HEARTBEAT_FILE: "HEARTBEAT.md",
      EVESTACK_HEARTBEAT_QUIET_HOURS: "22:00-08:00",
      EVESTACK_HEARTBEAT_QUIET_TIMEZONE: "UTC",
      TZ: "UTC",
    };
    const script = fileURLToPath(
      new URL("../scripts/heartbeat-preview.mjs", import.meta.url),
    );
    const preview = spawnSync(
      process.execPath,
      [script, "--at=2026-09-15T23:00:00Z", "--json"],
      { cwd, env, encoding: "utf8", timeout: 5000 },
    );
    assert.equal(preview.status, 0, preview.stderr);
    const body = JSON.parse(preview.stdout);
    assert.equal(body.wouldDispatchNow, false);
    assert.equal(body.quiet.quiet, true);
    assert.deepEqual(body.target, { chatId: 123 });
    assert.equal(body.prompt, heartbeatPrompt("Check the saved release note."));
    assert.equal(body.next.length, 3);
    assert.ok(body.next.every((item) => item.quiet));
    assert.match(body.note, /No model call/);
    for (const arg of ["--at=", "--at=2026-09-15T23:00:00", "--apply"]) {
      assert.equal(
        spawnSync(process.execPath, [script, arg, "--json"], {
          cwd,
          env,
          timeout: 5000,
        }).status,
        1,
      );
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
