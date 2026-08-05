/**
 * Reads evestack's own source to discover what it assumes about eve.
 *
 * The contracts could hard-code the list of `eve/*` subpaths and `$eve.*`
 * attributes we depend on, but a hard-coded list rots: someone adds an import,
 * forgets the list, and the suite goes green while the new assumption is
 * unpinned. Deriving the list from source means every new dependency on eve
 * becomes a contract the moment it is written.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Directories that either are not our source or are generated copies of it.
 *
 * `.eve` holds dev-runtime snapshots — verbatim copies of agent files from
 * every past `eve dev` run, so scanning it reports imports that were deleted
 * months ago. `packages/create-evestack/template` is regenerated from
 * templates/default at pack time and is gitignored.
 */
const SKIP_DIRS = new Set([
  ".git",
  ".eve",
  ".next",
  ".nitro",
  ".output",
  ".pnpm-store",
  ".firecrawl",
  "blob-report",
  "dist",
  "node_modules",
  "out",
  "playwright-report",
  "qa-shots",
  "test-results",
]);

const SKIP_PATHS = new Set([join("packages", "create-evestack", "template")]);

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".mjs", ".js", ".sql"];

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (SKIP_PATHS.has(relative(REPO_ROOT, full))) continue;
      walk(full, out);
    } else if (entry.isFile() && SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

let sourceFilesCache;

/** Every first-party source file in the repo, absolute paths. */
export function sourceFiles() {
  if (sourceFilesCache === undefined) {
    sourceFilesCache = [];
    for (const top of ["packages", "templates", "registry"]) {
      walk(join(REPO_ROOT, top), sourceFilesCache);
    }
  }
  return sourceFilesCache;
}

/**
 * Matches `import ... from "eve/whatever"`. The subpath group requires the
 * character after `eve` to be `/` or the closing quote so that unrelated bare
 * specifiers beginning with the same three letters (`events`, `eventsource`)
 * do not masquerade as eve imports.
 */
const IMPORT_RE = /import\s+(?<clause>[^;]*?)\s*from\s*["'](?<spec>eve(?:\/[^"']+)?)["']/g;

/**
 * Value imports only. A `import type { X }` binding is erased at compile time,
 * so asserting the runtime module exports `X` would fail for a perfectly
 * healthy type-only dependency.
 */
function parseImportedValueNames(clause) {
  const trimmed = clause.trim();
  if (trimmed.startsWith("type ")) return [];

  const names = [];
  const braces = /\{([^}]*)\}/.exec(trimmed);
  if (braces) {
    for (const raw of braces[1].split(",")) {
      const specifier = raw.trim();
      if (specifier === "" || specifier.startsWith("type ")) continue;
      // `foo as bar` — the export we must assert on is `foo`.
      names.push(specifier.split(/\s+as\s+/)[0].trim());
    }
  }

  const beforeBraces = braces ? trimmed.slice(0, braces.index) : trimmed;
  const defaultBinding = /^([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(beforeBraces.trim());
  if (defaultBinding) names.push("default");

  const namespaceBinding = /\*\s+as\s+[A-Za-z_$][\w$]*/.test(beforeBraces);
  if (namespaceBinding) names.push("*");

  return names;
}

function collectImportsFromText(text, origin, out) {
  for (const match of text.matchAll(IMPORT_RE)) {
    const { clause, spec } = match.groups;
    const entry = out.get(spec) ?? { spec, names: new Set(), origins: new Set() };
    for (const name of parseImportedValueNames(clause)) entry.names.add(name);
    entry.origins.add(origin);
    out.set(spec, entry);
  }
}

let eveImportsCache;

/**
 * Every `eve/*` specifier evestack imports, with the value bindings it takes
 * from each and the files that do so.
 *
 * Registry items are scanned too: `registry/r/*.json` inlines agent source as
 * strings, which means it is shipped to users but never touched by `tsc`. A
 * renamed eve export would break every `eve add @evestack/...` install with no
 * other signal in this repo.
 */
export function eveImports() {
  if (eveImportsCache !== undefined) return eveImportsCache;

  const found = new Map();
  for (const file of sourceFiles()) {
    if (file.endsWith(".sql")) continue;
    collectImportsFromText(readFileSync(file, "utf8"), relative(REPO_ROOT, file), found);
  }

  const registryDir = join(REPO_ROOT, "registry", "r");
  let registryEntries = [];
  try {
    registryEntries = readdirSync(registryDir).filter((f) => f.endsWith(".json") && f !== "registry.json");
  } catch {
    registryEntries = [];
  }
  for (const name of registryEntries) {
    const item = JSON.parse(readFileSync(join(registryDir, name), "utf8"));
    for (const file of item.files ?? []) {
      collectImportsFromText(file.content ?? "", `registry/r/${name} → ${file.target}`, found);
    }
  }

  eveImportsCache = [...found.values()]
    .map((entry) => ({
      spec: entry.spec,
      names: [...entry.names].sort(),
      origins: [...entry.origins].sort(),
    }))
    .sort((a, b) => a.spec.localeCompare(b.spec));
  return eveImportsCache;
}

let eveAttributesCache;

/**
 * Every `$eve.*` run attribute evestack reads, with the files that read it.
 * These are framework-owned keys in `workflow.workflow_runs.attributes`; the
 * dashboard's entire read path is built on them.
 */
export function eveAttributes() {
  if (eveAttributesCache !== undefined) return eveAttributesCache;

  const found = new Map();
  for (const file of sourceFiles()) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/\$eve\.[a-z_]+/g)) {
      const entry = found.get(match[0]) ?? new Set();
      entry.add(relative(REPO_ROOT, file));
      found.set(match[0], entry);
    }
  }

  eveAttributesCache = [...found.entries()]
    .map(([name, origins]) => ({ name, origins: [...origins].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return eveAttributesCache;
}

/** Every package.json in the repo that declares a dependency on eve. */
export function eveVersionRanges() {
  const ranges = [];
  const manifests = [
    "package.json",
    join("templates", "default", "package.json"),
    ...readdirSync(join(REPO_ROOT, "packages"), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join("packages", e.name, "package.json")),
  ];

  for (const rel of manifests) {
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(REPO_ROOT, rel), "utf8"));
    } catch {
      continue;
    }
    for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      const range = manifest[field]?.eve;
      if (typeof range === "string") ranges.push({ file: rel, field, range });
    }
  }
  return ranges;
}
