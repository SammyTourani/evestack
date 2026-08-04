#!/usr/bin/env node
/**
 * Copies templates/default into this package before publish.
 *
 * The CLI must carry the template with it — a scaffolder that downloads its own
 * files at run time breaks offline, breaks behind proxies, and silently version
 * skews when the repo moves ahead of the published CLI. Copying at pack time
 * pins the template to the CLI version that was tested with it.
 */
import { cpSync, existsSync, rmSync } from "node:fs";
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
console.log(`✓ synced template -> ${dest}`);
