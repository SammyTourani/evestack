#!/usr/bin/env node
/**
 * The deterministic half of the upgrade workflow: bump eve's version across
 * every manifest that pins it, and pull the CHANGELOG entries between two
 * versions out of the installed package.
 *
 * Both jobs are pure text manipulation with a knowable right answer, which is
 * exactly the kind of work that should never be handed to a model. The model,
 * if one is wired up at all, gets the job that has no right answer — reading a
 * changelog and guessing what a maintainer should look at first — and it gets
 * to write a comment, not a commit. See docs/upgrading.mdx.
 *
 * Usage:
 *   node contract/upgrade.mjs bump --to 0.31.0
 *   node contract/upgrade.mjs changelog --from 0.30.2 --to 0.31.0
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./lib/repo.mjs";

/* -------------------------------------------------------------------------- */
/* bump                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Only caret pins move. A peer range like `>=0.30.0 <1.0.0` is a deliberate
 * statement about which eve versions a published package supports, and
 * widening it automatically would publish a compatibility promise nobody
 * tested. If a new eve falls outside one, the version contract fails and a
 * human decides — which is the whole point of not auto-merging.
 */
const CARET_PIN = /^\^\d+\.\d+\.\d+$/;

function manifestPaths() {
  const paths = ["package.json", join("templates", "default", "package.json")];
  for (const entry of readdirSync(join(REPO_ROOT, "packages"), { withFileTypes: true })) {
    if (entry.isDirectory()) paths.push(join("packages", entry.name, "package.json"));
  }
  return paths;
}

function bump(target) {
  if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(target)) {
    process.stderr.write(`"${target}" is not a version.\n`);
    process.exit(2);
  }

  const changes = [];
  for (const relative of manifestPaths()) {
    const absolute = join(REPO_ROOT, relative);
    let raw;
    try {
      raw = readFileSync(absolute, "utf8");
    } catch {
      continue;
    }

    const manifest = JSON.parse(raw);
    let touched = false;
    for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      const current = manifest[field]?.eve;
      if (typeof current !== "string") continue;
      if (!CARET_PIN.test(current)) {
        changes.push({ file: relative, field, from: current, to: current, skipped: true });
        continue;
      }
      if (current === `^${target}`) continue;
      manifest[field].eve = `^${target}`;
      changes.push({ file: relative, field, from: current, to: `^${target}` });
      touched = true;
    }

    if (touched) {
      // Preserve the file's own trailing-newline convention rather than
      // reformatting a manifest the bump did not otherwise touch.
      writeFileSync(absolute, `${JSON.stringify(manifest, null, 2)}${raw.endsWith("\n") ? "\n" : ""}`);
    }
  }

  const moved = changes.filter((c) => !c.skipped);
  process.stdout.write(`${JSON.stringify({ target, changed: moved, skipped: changes.filter((c) => c.skipped) }, null, 2)}\n`);
  if (moved.length === 0) process.exit(1);
}

/* -------------------------------------------------------------------------- */
/* changelog                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Words that, appearing in a changelog entry, mean a contract in this suite has
 * an opinion about the change. Not a safety mechanism — the contracts are the
 * safety mechanism — but it puts the three lines a reviewer needs at the top of
 * a release note that is routinely a hundred lines long.
 */
const CONTRACT_KEYWORDS = [
  ["localDev", "auth/local-dev-must-not-trust-the-request"],
  ["Host", "auth/local-dev-must-not-trust-the-request"],
  ["auth", "auth/*"],
  ["principal", "auth/*"],
  ["approval", "tools/approval-is-the-gating-field"],
  ["defineTool", "tools/*"],
  ["defineDynamic", "tools/dynamic-sentinel-and-events"],
  ["dynamic tool", "tools/dynamic-sentinel-and-events"],
  ["$eve.", "attributes/*"],
  ["attribute", "attributes/*"],
  ["route", "protocol/http-surface-the-dashboard-drives"],
  ["/eve/v1", "protocol/http-surface-the-dashboard-drives"],
  ["cancel", "protocol/http-surface-the-dashboard-drives"],
  ["stream", "protocol/http-surface-the-dashboard-drives"],
  ["hook", "hooks/observe-only-and-event-names"],
  ["sandbox", "sandbox/backend-interface-is-structurally-stable"],
  ["backend", "sandbox/backend-interface-is-structurally-stable"],
  ["rename", "modules/*"],
  ["remove", "modules/*"],
  ["breaking", "*"],
];

/** Splits eve's changesets-style CHANGELOG into `## <version>` sections. */
function parseChangelog(text) {
  const sections = [];
  let current = null;
  for (const line of text.split("\n")) {
    const heading = /^##\s+(\d+\.\d+\.\d+(?:-[\w.]+)?)\s*$/.exec(line);
    if (heading) {
      if (current) sections.push(current);
      current = { version: heading[1], lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) sections.push(current);
  return sections;
}

function compareVersions(a, b) {
  const pa = a.split(/[.-]/).map((n) => (Number.isNaN(Number(n)) ? n : Number(n)));
  const pb = b.split(/[.-]/).map((n) => (Number.isNaN(Number(n)) ? n : Number(n)));
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function changelog(from, to) {
  // Read from the installed package: it is the changelog for the exact tarball
  // that was just installed, with no network call and no chance of reading
  // release notes for a version other than the one under test.
  let text;
  try {
    text = readFileSync(join(REPO_ROOT, "templates", "default", "node_modules", "eve", "CHANGELOG.md"), "utf8");
  } catch {
    process.stdout.write("_eve ships no CHANGELOG.md in this release, or it is not installed yet._\n");
    return;
  }

  const sections = parseChangelog(text).filter(
    (s) => compareVersions(s.version, from) > 0 && compareVersions(s.version, to) <= 0,
  );

  if (sections.length === 0) {
    process.stdout.write(`_No CHANGELOG entries found between ${from} and ${to}._\n`);
    return;
  }

  const out = [];
  const flagged = [];
  for (const section of sections) {
    for (const line of section.lines) {
      const entry = /^-\s+(?:[0-9a-f]{7,}:\s*)?(.+)$/.exec(line.trim());
      if (entry === null) continue;
      const hits = new Set(
        CONTRACT_KEYWORDS.filter(([word]) => entry[1].toLowerCase().includes(word.toLowerCase())).map(([, id]) => id),
      );
      if (hits.size > 0) flagged.push({ version: section.version, text: entry[1], contracts: [...hits] });
    }
  }

  if (flagged.length > 0) {
    out.push(`#### Changelog entries that touch something this suite pins`);
    out.push("");
    out.push("_Keyword match, not a verdict — the contract results above are the verdict._");
    out.push("");
    for (const item of flagged) {
      out.push(`- **${item.version}** — ${item.text}`);
      out.push(`  <br>relevant contracts: ${item.contracts.map((c) => `\`${c}\``).join(", ")}`);
    }
    out.push("");
  }

  out.push(`<details><summary>Full eve changelog, ${from} → ${to} (${sections.length} releases)</summary>`);
  out.push("");
  for (const section of sections) {
    out.push(`## ${section.version}`);
    out.push(...section.lines);
  }
  out.push("");
  out.push("</details>");
  out.push("");
  process.stdout.write(`${out.join("\n")}\n`);
}

/* -------------------------------------------------------------------------- */

const [command, ...rest] = process.argv.slice(2);
const flag = (name) => {
  const index = rest.indexOf(`--${name}`);
  return index === -1 ? null : rest[index + 1];
};

if (command === "bump") {
  bump(flag("to") ?? "");
} else if (command === "changelog") {
  changelog(flag("from") ?? "0.0.0", flag("to") ?? "999.999.999");
} else {
  process.stderr.write("Usage: upgrade.mjs bump --to <version> | changelog --from <version> --to <version>\n");
  process.exit(2);
}
