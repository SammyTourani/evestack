import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { upgradePlan, upgrade } from "../src/upgrade.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "evestack-upgrade-")),
    project = join(root, "project"),
    candidate = join(root, "candidate");
  mkdirSync(project);
  mkdirSync(candidate);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (base, path, value) => {
    writeFileSync(
      join(base, path),
      typeof value === "string" ? value : JSON.stringify(value),
    );
  };
  put(project, "package.json", {
    name: "my-agent",
    dependencies: {
      eve: "^0.40.0",
      "@evestack/budget":
        "https://user:PRIVATE-SECRET@example.test/package.tgz",
    },
  });
  put(candidate, "package.json", {
    name: "template",
    dependencies: { eve: "^0.54.3", "@evestack/budget": "^0.4.0" },
  });
  put(project, ".env.local", "PRIVATE_AUTH=KEEP-ME-PRIVATE");
  put(candidate, ".env.local", "PACKAGED-SECRET-MUST-NOT-APPEAR");
  put(candidate, "evestack-release.json", {
    packages: { evestack: "0.7.0", "create-evestack": "0.13.0" },
  });
  put(project, "HEARTBEAT.md", "User's custom checks.");
  put(candidate, "HEARTBEAT.md", "New default.");
  put(project, "extra-user-file.txt", "Never remove this.");
  put(project, "README.md", "Same.");
  put(candidate, "README.md", "Same.");
  put(candidate, "gitignore", ".env*\n");
  return { root, project, candidate, put };
}

test("upgrade compares hashes and declared dependencies without exposing secrets or changing user files", (t) => {
  const f = fixture(t),
    before = readFileSync(join(f.project, "package.json"));
  const result = upgradePlan(f.project, f.candidate);
  assert.equal(result.recordedCombination, null);
  assert.equal(result.candidateCombination.evestack, "0.7.0");
  const by = new Map(result.files.map((file) => [file.path, file]));
  assert.equal(by.get("HEARTBEAT.md").status, "review");
  assert.equal(by.get("README.md").status, "same");
  assert.equal(by.get(".gitignore").status, "missing");
  assert.ok(!by.has("gitignore"));
  assert.ok(!by.has(".env.local"));
  assert.ok(!by.has("extra-user-file.txt"));
  assert.doesNotMatch(
    JSON.stringify(result),
    /PRIVATE|PACKAGED-SECRET|User's custom checks/,
  );
  assert.equal(
    result.dependencies.find((dep) => dep.name === "@evestack/budget").current,
    "custom specifier (inspect locally)",
  );
  assert.deepEqual(readFileSync(join(f.project, "package.json")), before);
  assert.equal(
    readFileSync(join(f.project, ".env.local"), "utf8"),
    "PRIVATE_AUTH=KEEP-ME-PRIVATE",
  );
  assert.equal(
    readFileSync(join(f.project, "extra-user-file.txt"), "utf8"),
    "Never remove this.",
  );
  assert.match(result.note, /manual merging/);
});

test("linked directories are flagged without reading their target", (t) => {
  const f = fixture(t);
  const outside = join(f.root, "outside");
  mkdirSync(outside);
  f.put(outside, "agent.ts", "PRIVATE-LINKED-CONTENT");
  mkdirSync(join(f.candidate, "agent"));
  f.put(f.candidate, "agent/agent.ts", "candidate");
  symlinkSync(
    outside,
    join(f.project, "agent"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const plan = upgradePlan(f.project, f.candidate);
  assert.equal(
    plan.files.find((file) => file.path === "agent/agent.ts").status,
    "blocked",
  );
  assert.doesNotMatch(JSON.stringify(plan), /PRIVATE-LINKED-CONTENT/);
});

test("oversized files and malformed release records fail without dumping contents", (t) => {
  const f = fixture(t);
  writeFileSync(
    join(f.project, "HEARTBEAT.md"),
    Buffer.alloc(2 * 1024 * 1024 + 1),
  );
  assert.equal(
    upgradePlan(f.project, f.candidate).files.find(
      (file) => file.path === "HEARTBEAT.md",
    ).status,
    "blocked",
  );
  f.put(f.project, "evestack-release.json", "PRIVATE-BROKEN-JSON");
  assert.throws(
    () => upgradePlan(f.project, f.candidate),
    (error) =>
      /JSON object/.test(error.message) &&
      !error.message.includes("PRIVATE-BROKEN"),
  );
});

test("a template nested in an installed CLI can be inspected but comparing a directory with itself is refused", (t) => {
  const f = fixture(t);
  const nested = join(f.project, "node_modules", "create-evestack", "template");
  mkdirSync(nested, { recursive: true });
  f.put(nested, "package.json", { dependencies: { eve: "^0.54.3" } });
  assert.ok(upgradePlan(f.project, nested).files.length);
  assert.throws(
    () => upgradePlan(f.candidate, f.candidate),
    /different directories/,
  );
});

test("top-level upgrade routing reaches a real bundled-template preview and refuses apply", async (t) => {
  const f = fixture(t);
  const binary = fileURLToPath(new URL("../bin/evestack.mjs", import.meta.url));
  const result = spawnSync(
    process.execPath,
    [binary, "upgrade", "--json", "--changed-only"],
    { cwd: f.project, encoding: "utf8", timeout: 15000 },
  );
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.ok(plan.files.length > 10);
  assert.ok(plan.files.every((file) => file.status !== "same"));
  assert.ok(plan.candidateCombination["create-evestack"]);
  let error = "";
  assert.equal(
    await upgrade(["--apply"], {
      cwd: f.project,
      stderr: {
        write(text) {
          error += text;
        },
      },
    }),
    1,
  );
  assert.match(error, /no apply flag/);
  let help = "";
  assert.equal(
    await upgrade(["--help"], {
      cwd: tmpdir(),
      stdout: {
        write(text) {
          help += text;
        },
      },
    }),
    0,
  );
  assert.match(help, /Writes nothing/);
});
