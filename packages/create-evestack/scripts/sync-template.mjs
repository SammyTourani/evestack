#!/usr/bin/env node
/**
 * Copies templates/default into this package before publish.
 *
 * The CLI must carry the template with it — a scaffolder that downloads its own
 * files at run time breaks offline, breaks behind proxies, and silently version
 * skews when the repo moves ahead of the published CLI. Copying at pack time
 * pins the template to the CLI version that was tested with it.
 */
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { isTemplateFile } from "../create.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..");
const source = join(pkg, "..", "..", "templates", "default");
const dest = join(pkg, "template");

if (!existsSync(source)) {
  console.error(`Template not found at ${source}. Run this from the evestack monorepo.`);
  process.exit(1);
}

/**
 * The filter is create.mjs's, imported rather than re-written.
 *
 * This was a bare substring regex against the ABSOLUTE source path — the same
 * npx bug create.mjs had already been fixed for, one step earlier in the
 * pipeline. Any checkout whose own path contains one of the excluded words
 * matched every file under it and copied NOTHING: `~/dist/evestack`,
 * `~/Projects/distro/evestack` ("dist" is a substring of "distro"),
 * `~/work/distributed-systems/evestack`, or any user whose home directory
 * contains ".eve" — `/Users/steve.everett/evestack` does. And because the copy is
 * preceded by the rmSync above, the manifest read below then failed on a raw
 * ENOENT naming a generated path the reader had never heard of.
 *
 * Sharing the function is the fix that stays fixed: two copies of a path filter
 * are two chances to get the segment matching wrong, and only one of them has a
 * test.
 */
rmSync(dest, { recursive: true, force: true });
cpSync(source, dest, {
  recursive: true,
  filter: (src) => isTemplateFile(source, src),
});

// `workspace:*` resolves only inside this monorepo. A scaffolded project is
// standalone, so npm would fail on an unknown protocol — rewrite those ranges to
// the real published versions.
const manifestPath = join(dest, "package.json");
// Checked rather than left to throw. The destination has just been deleted and
// re-copied, so if the filter excluded everything this is where it surfaces —
// and it surfaced as `ENOENT: no such file or directory, open
// '.../template/package.json'`, which names a generated path and explains
// nothing. The filter above is the only thing that can cause it.
if (!existsSync(manifestPath)) {
  console.error(
    `The template copy produced no package.json at ${manifestPath}.\n` +
      `  Source: ${source}\n` +
      "  Nothing was copied, which means the filter in this script excluded everything.",
  );
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
let rewritten = 0;
for (const field of ["dependencies", "devDependencies"]) {
  for (const [name, range] of Object.entries(manifest[field] ?? {})) {
    if (typeof range === "string" && range.startsWith("workspace:")) {
      const version = JSON.parse(
        readFileSync(join(pkg, "..", name.replace(/^@evestack\//, "evestack-"), "package.json"), "utf8"),
      ).version;
      manifest[field][name] = `^${version}`;
      rewritten += 1;
    }
  }
}
if (rewritten > 0) {
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}
console.log(`✓ synced template -> ${dest}${rewritten ? ` (${rewritten} workspace range(s) pinned)` : ""}`);
