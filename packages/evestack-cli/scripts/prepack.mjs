#!/usr/bin/env node
/**
 * Refuse to pack this package with an unresolved `workspace:` range in it.
 *
 * This is the only package in the repo that depends on another one at publish
 * time (`create-evestack`, which owns the scaffolder both bins share — see
 * packages/create-evestack/create.mjs). `workspace:^` is how pnpm links the
 * local copy during development, and `pnpm publish` / `pnpm pack` rewrite it to
 * the real version in the tarball. `npm publish` does NOT: npm has never
 * implemented the protocol, so it would ship a manifest whose install ends at
 *
 *   npm error Unsupported URL Type "workspace:": workspace:^
 *
 * for every single user, and nothing about the publish would have looked wrong.
 * RELEASING.md documents `npm publish ./packages/<dir>` for the other packages,
 * which is exactly the habit that would produce that tarball.
 *
 * So this checks rather than rewrites. Rewriting means editing a tracked
 * package.json during publish and restoring it afterwards, and a publish that
 * fails in the middle then leaves the repo holding a manifest nobody wrote.
 * A hard stop with the correct command in it costs one retry.
 */
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const offenders = [];
for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
  for (const [name, range] of Object.entries(manifest[field] ?? {})) {
    if (typeof range === "string" && range.startsWith("workspace:")) offenders.push(`${name}@${range}`);
  }
}

// pnpm resolves the protocol as it packs; anything else ships it verbatim.
const agent = process.env.npm_config_user_agent ?? "";
const packerIsPnpm = agent.startsWith("pnpm");

if (offenders.length > 0 && !packerIsPnpm) {
  process.stderr.write(
    `\nevestack: refusing to pack — ${offenders.join(", ")} would ship as a literal ` +
      "`workspace:` range that npm cannot install.\n\n" +
      "  Publish this package with pnpm, which resolves it:\n\n" +
      "    pnpm --filter evestack publish --access public\n\n" +
      `  (packer reported by npm_config_user_agent: ${agent || "none"})\n\n`,
  );
  process.exit(1);
}

process.stdout.write(
  offenders.length > 0
    ? `✓ ${offenders.length} workspace range(s) will be resolved by pnpm at pack time\n`
    : "✓ no workspace ranges to resolve\n",
);
