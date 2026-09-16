import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  symlink,
  mkdir,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { loadSkillPack, validateSkillPack } from "../src/skill-pack.mjs";
import { skills } from "../src/skills.mjs";
const sink = () => ({
  value: "",
  write(text) {
    this.value += text;
  },
});

test("the default setup pack is tied to this CLI and installs with no network", async () => {
  const previous = process.env.EVESTACK_PACK_URL;
  delete process.env.EVESTACK_PACK_URL;
  const fetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("Network must not be used");
  };
  const dir = await mkdtemp(join(tmpdir(), "evestack-bundled-pack-"));
  try {
    const pack = await loadSkillPack();
    const manifest = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    );
    assert.equal(pack.version, manifest.version);
    assert.equal(pack.source, "bundled");
    assert.equal(pack.files.length, 5);
    assert.match(
      pack.files[0].content,
      new RegExp(pack.runtime.workflowPostgres.replaceAll(".", "\\.")),
    );
    const out = sink(),
      err = sink();
    assert.equal(
      await skills([`--dir=${dir}`, "--json"], { stdout: out, stderr: err }),
      0,
      err.value,
    );
    assert.equal(JSON.parse(out.value).version, manifest.version);
    for (const file of pack.files)
      assert.equal(await readFile(join(dir, file.path), "utf8"), file.content);
    assert.throws(
      () => validateSkillPack({ ...pack, version: "0.0.0" }, manifest.version),
      /does not match/,
    );
    assert.throws(
      () =>
        validateSkillPack(
          { ...pack, files: [{ ...pack.files[0], content: "altered" }] },
          manifest.version,
        ),
      /integrity/,
    );
  } finally {
    globalThis.fetch = fetch;
    if (previous === undefined) delete process.env.EVESTACK_PACK_URL;
    else process.env.EVESTACK_PACK_URL = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("custom setup data is bounded, redirects are refused, and malformed body content stays private", async (t) => {
  let mode = "good",
    redirectCalls = 0;
  const server = createServer((req, res) => {
    if (req.url === "/redirect-target") redirectCalls++;
    if (mode === "redirect") {
      res.writeHead(302, { location: "/redirect-target" }).end();
      return;
    }
    if (mode === "large") {
      res.writeHead(200, { "content-length": 2 * 1024 * 1024 }).end();
      return;
    }
    if (mode === "chunked") {
      res.writeHead(200);
      res.write("x".repeat(700000));
      res.end("x".repeat(700000));
      return;
    }
    if (mode === "malformed") {
      res.end("PRIVATE_RESPONSE_CONTENT");
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        version: "0.7.0",
        files: [{ path: "SKILL.md", content: "Custom instructions." }],
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const previous = process.env.EVESTACK_PACK_URL;
  process.env.EVESTACK_PACK_URL = `http://127.0.0.1:${server.address().port}/pack`;
  try {
    const good = await loadSkillPack();
    assert.equal(good.source, "custom");
    assert.equal(good.version, null);
    for (const next of ["redirect", "large", "chunked", "malformed"])
      await t.test(next, async () => {
        mode = next;
        await assert.rejects(
          loadSkillPack(),
          (error) =>
            !error.message.includes("PRIVATE_RESPONSE_CONTENT") &&
            /Could not reach|1 MiB|not valid/.test(error.message),
        );
      });
    assert.equal(redirectCalls, 0);
    for (const value of [
      "http://example.invalid/pack",
      "https://secret:credential@example.invalid/pack",
      "file:///tmp/pack",
    ]) {
      process.env.EVESTACK_PACK_URL = value;
      await assert.rejects(loadSkillPack(), /HTTPS/);
    }
  } finally {
    if (previous === undefined) delete process.env.EVESTACK_PACK_URL;
    else process.env.EVESTACK_PACK_URL = previous;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("invalid file lists are rejected before installation", () => {
  for (const files of [
    [],
    Array(51).fill({ path: "x", content: "" }),
    [{ path: "x", content: 1 }],
    [{ path: "x", content: "x".repeat(262145) }],
    [
      { path: "X.md", content: "" },
      { path: "x.md", content: "" },
    ],
    [{ path: "x\0", content: "" }],
  ])
    assert.throws(() => validateSkillPack({ files }));
});

test(
  "a linked reference directory is refused before any file is written",
  { skip: process.platform === "win32" },
  async () => {
    const previous = process.env.EVESTACK_PACK_URL;
    delete process.env.EVESTACK_PACK_URL;
    const root = await mkdtemp(join(tmpdir(), "evestack-pack-link-"));
    const target = join(root, "target"),
      outside = join(root, "outside");
    try {
      await mkdir(target);
      await mkdir(outside);
      await writeFile(join(outside, "cli.md"), "keep me");
      await symlink(outside, join(target, "references"), "dir");
      const out = sink(),
        err = sink();
      assert.equal(
        await skills([`--dir=${target}`, "--force"], {
          stdout: out,
          stderr: err,
        }),
        1,
      );
      assert.match(err.value, /symlink/);
      await assert.rejects(readFile(join(target, "SKILL.md")), {
        code: "ENOENT",
      });
      assert.equal(await readFile(join(outside, "cli.md"), "utf8"), "keep me");
    } finally {
      if (previous === undefined) delete process.env.EVESTACK_PACK_URL;
      else process.env.EVESTACK_PACK_URL = previous;
      await rm(root, { recursive: true, force: true });
    }
  },
);
