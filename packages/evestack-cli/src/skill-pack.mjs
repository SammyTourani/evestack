import { open, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";

const MAX_BYTES = 1024 * 1024;
export function validateSkillPack(pack, bundledVersion = null) {
  if (
    !Array.isArray(pack?.files) ||
    pack.files.length === 0 ||
    pack.files.length > 50
  )
    throw new Error(
      "The setup pack must contain 1–50 files. Nothing was written.",
    );
  if (
    bundledVersion &&
    (pack.formatVersion !== 1 ||
      pack.name !== "evestack" ||
      pack.version !== bundledVersion)
  )
    throw new Error(
      "The bundled setup pack does not match this CLI. Reinstall the CLI.",
    );
  const names = new Set();
  let bytes = 0;
  for (const file of pack.files) {
    if (
      typeof file?.path !== "string" ||
      !file.path ||
      file.path.length > 300 ||
      /[\x00-\x1f\x7f]/.test(file.path) ||
      typeof file.content !== "string" ||
      Buffer.byteLength(file.content) > 256 * 1024
    )
      throw new Error(
        "The setup pack contains an invalid or oversized file. Nothing was written.",
      );
    const name = file.path.replaceAll("\\", "/").toLowerCase();
    if (names.has(name))
      throw new Error(
        "The setup pack contains duplicate file paths. Nothing was written.",
      );
    names.add(name);
    bytes += Buffer.byteLength(file.content);
    if (bytes > MAX_BYTES)
      throw new Error("The setup pack exceeds 1 MiB. Nothing was written.");
    if (
      bundledVersion &&
      file.sha256 !== createHash("sha256").update(file.content).digest("hex")
    )
      throw new Error(
        "A bundled setup file failed its integrity check. Reinstall the CLI.",
      );
  }
  return pack;
}

async function readBundledPack() {
  const file = await open(
    new URL("../agent-pack.json", import.meta.url),
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES)
      throw new Error("Bundled setup pack is not a regular file within 1 MiB.");
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(
        buffer,
        size,
        buffer.length - size,
        size,
      );
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_BYTES) throw new Error("Bundled setup pack exceeds 1 MiB.");
    const manifest = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    );
    return validateSkillPack(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          buffer.subarray(0, size),
        ),
      ),
      manifest.version,
    );
  } finally {
    await file.close();
  }
}

export async function loadSkillPack() {
  const custom = process.env.EVESTACK_PACK_URL?.trim();
  if (!custom) {
    try {
      return await readBundledPack();
    } catch (error) {
      throw new Error(
        `Could not load the setup pack bundled with this CLI: ${error.message}. Reinstall it, or run scripts/sync-skill-pack.mjs in a source checkout. No network fallback was attempted.`,
      );
    }
  }
  let url;
  try {
    url = new URL(custom);
  } catch {
    throw new Error("EVESTACK_PACK_URL must be an absolute HTTP(S) URL.");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
  )
    throw new Error(
      "A custom setup pack requires HTTPS, or HTTP on loopback, and no URL credentials.",
    );
  const label = url.origin + url.pathname;
  let response;
  try {
    response = await fetch(url, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new Error(
      `Could not reach ${label}. Check the custom pack, unset EVESTACK_PACK_URL to use the bundled files, or read /agent.md.`,
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      `The custom setup pack answered ${response.status}. Nothing was written.`,
    );
  }
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_BYTES) {
    await response.body?.cancel();
    throw new Error("The setup pack exceeds 1 MiB. Nothing was written.");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("The custom setup pack has no body.");
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES)
        throw new Error("The setup pack exceeds 1 MiB. Nothing was written.");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  let decoded;
  try {
    decoded = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
  } catch {
    throw new Error(
      "The custom setup pack is not valid UTF-8 JSON. Nothing was written.",
    );
  }
  const pack = validateSkillPack(decoded);
  // A remote pack is explicitly unversioned for this installation, even if its
  // payload claims the same version as the CLI.
  return { ...pack, source: "custom", version: null };
}
