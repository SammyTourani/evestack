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

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..");
const source = join(pkg, "..", "..", "templates", "default");
const dest = join(pkg, "template");

if (!existsSync(source)) {
  console.error(`Template not found at ${source}. Run this from the evestack monorepo.`);
  process.exit(1);
}

rmSync(dest, { recursive: true, force: true });
cpSync(source, dest, {
  recursive: true,
  filter: (src) =>
    !/(node_modules|\.eve|\.output|\.env\.local|\.next|dist|tsconfig\.tsbuildinfo)/.test(src),
});

// `workspace:*` resolves only inside this monorepo. A scaffolded project is
// standalone, so npm would fail on an unknown protocol — rewrite those ranges to
// the real published versions.
const manifestPath = join(dest, "package.json");
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
