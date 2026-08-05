#!/usr/bin/env node
/**
 * Records a contract-suite run into contract/history/, keyed by eve version.
 *
 * The public compatibility page (contract/render-compat.mjs) is only worth as
 * much as its inputs, so its inputs are committed JSON produced by this script
 * and by nothing else. Nobody hand-edits a green cell into existence: every row
 * on that page is a real run of `contract/run.mjs` against a real eve tarball,
 * with the tarball's integrity hash recorded beside the verdict.
 *
 * Usage:
 *   node contract/record.mjs                       record the installed eve
 *   node contract/record.mjs --npm=0.30.6,0.29.5   fetch those releases, record each
 *   node contract/record.mjs --npm=latest          fetch whatever npm calls latest
 *   node contract/record.mjs --eve-dir=path/to/eve record an eve unpacked elsewhere
 *   node contract/record.mjs --dry-run             print the verdicts, write nothing
 *   node contract/record.mjs --cache=dir           where tarballs are unpacked
 *
 * `--npm` unpacks into a cache directory OUTSIDE this repo and never writes
 * node_modules. Certifying an old release must not disturb the install the rest
 * of the repo is built against — that is the whole reason this is a separate
 * script and not `pnpm add eve@0.29.5`.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { REPO_ROOT } from "./lib/repo.mjs";

const HISTORY_DIR = join(REPO_ROOT, "contract", "history");
const RUNNER = join(REPO_ROOT, "contract", "run.mjs");
const SCHEMA_VERSION = 1;

/* -------------------------------------------------------------------------- */
/* argv                                                                        */
/* -------------------------------------------------------------------------- */

const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;

const dryRun = args.includes("--dry-run");
const eveDirFlag = flag("eve-dir");
const npmFlag = flag("npm");
const cacheDir = resolve(flag("cache") ?? join(tmpdir(), "evestack-compat-cache"));

const unknown = args.filter((a) => !/^--(dry-run|eve-dir=|npm=|cache=)/.test(a));
if (unknown.length > 0) {
  process.stderr.write(`Unknown argument(s): ${unknown.join(" ")}\nSee the header of contract/record.mjs.\n`);
  process.exit(2);
}
if (eveDirFlag !== null && npmFlag !== null) {
  process.stderr.write("Use --eve-dir or --npm, not both.\n");
  process.exit(2);
}

/* -------------------------------------------------------------------------- */
/* npm registry facts (best effort — the suite itself never needs a network)    */
/* -------------------------------------------------------------------------- */

function npmJson(spec) {
  try {
    return JSON.parse(execFileSync("npm", ["view", "eve", spec, "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  } catch {
    return null;
  }
}

// Fetched once and reused: `npm view` is a network round trip per call, and
// recording eight versions should not mean sixteen of them.
const registry = {
  times: null,
  latest: null,
  load() {
    if (this.times === null) this.times = npmJson("time") ?? {};
    if (this.latest === null) this.latest = npmJson("dist-tags.latest") ?? null;
  },
  releasedAt(version) {
    this.load();
    return this.times?.[version] ?? null;
  },
  latestTag() {
    this.load();
    return this.latest;
  },
};

/* -------------------------------------------------------------------------- */
/* fetching a release                                                          */
/* -------------------------------------------------------------------------- */

/**
 * An npm tarball ships eve's compiled output and no node_modules, so eve's own
 * runtime imports (`ai`, `nitro`, `undici`, `@opentelemetry/api`) do not
 * resolve from a bare unpack — five contracts crash on `Cannot find package
 * 'ai'` and report a red that says nothing whatsoever about eve.
 *
 * Borrowing the installed release's dependency tree fixes that and, more
 * importantly, holds it constant: every version on the compat page is measured
 * against the same dependencies, so the only thing varying between rows is eve.
 * Symlinks, so nothing is copied and nothing is installed.
 */
function provisionDependencies(root) {
  let installedEve;
  try {
    const hostManifest = join(REPO_ROOT, "templates", "default", "package.json");
    installedEve = dirname(createRequire(hostManifest).resolve("eve/package.json"));
  } catch {
    process.stderr.write(
      "warning: no installed eve to borrow dependencies from, so unpacked tarballs will crash\n" +
        "         several contracts on unresolved imports. Run `pnpm install` first.\n",
    );
    return;
  }

  const depsDir = dirname(installedEve);
  const farm = join(root, "node_modules");
  rmSync(farm, { recursive: true, force: true });
  mkdirSync(farm, { recursive: true });

  for (const entry of readdirSync(depsDir, { withFileTypes: true })) {
    // eve itself is deliberately absent: the package under test is the unpacked
    // tarball, reached by Node's package self-reference, and a sibling `eve`
    // here would let a stray bare import silently read the installed one.
    if (entry.name === "eve" || entry.name === ".bin") continue;
    if (entry.name.startsWith("@")) {
      mkdirSync(join(farm, entry.name), { recursive: true });
      for (const scoped of readdirSync(join(depsDir, entry.name))) {
        symlinkSync(join(depsDir, entry.name, scoped), join(farm, entry.name, scoped));
      }
    } else {
      symlinkSync(join(depsDir, entry.name), join(farm, entry.name));
    }
  }
}

/** Downloads and unpacks eve@version into the cache. Returns `{ root, source }`. */
function fetchRelease(version) {
  mkdirSync(cacheDir, { recursive: true });
  const packed = JSON.parse(
    execFileSync("npm", ["pack", `eve@${version}`, "--pack-destination", cacheDir, "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
      maxBuffer: 64 * 1024 * 1024,
    }),
  )[0];

  const root = join(cacheDir, `eve-${packed.version}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  execFileSync("tar", ["-xzf", join(cacheDir, packed.filename), "-C", root, "--strip-components=1"]);

  return {
    root,
    source: {
      kind: "npm-tarball",
      spec: `eve@${packed.version}`,
      tarball: packed.filename,
      integrity: packed.integrity,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* running                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Runs the suite in a child process rather than importing it: run.mjs calls
 * process.exit, which is correct for a CLI and fatal for a caller that wants to
 * record more than one version in a single invocation.
 */
function runSuite(eveDir) {
  const result = spawnSync(process.execPath, [RUNNER, "--format=json"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: eveDir === null ? process.env : { ...process.env, EVESTACK_CONTRACT_EVE_DIR: eveDir },
  });

  // 0 = all green, 1 = contracts failed — both are results worth recording.
  // 2 is the runner refusing to start (no eve found), which is not a verdict.
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`contract/run.mjs exited ${result.status}:\n${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout);
}

function evestackCommit() {
  try {
    return execFileSync("git", ["-C", REPO_ROOT, "rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function record(report, source) {
  const version = report.eve.version;
  return {
    schemaVersion: SCHEMA_VERSION,
    eveVersion: version,
    eveReleasedAt: registry.releasedAt(version),
    eveLatestTagAtCertification: registry.latestTag(),
    certifiedAt: new Date().toISOString(),
    evestackCommit: evestackCommit(),
    // What templates/default pinned when this ran. A row certified under an
    // older pin is still a real run; this is how a reader can tell which.
    evestackPin: report.eve.pin,
    source,
    ok: report.ok,
    counts: report.counts,
    // Verbatim from the runner. `report.eve.path` is the one field deliberately
    // dropped: it is an absolute path on whoever's machine ran this, so it is
    // noise in a committed file and would make every re-record a diff.
    contracts: report.contracts,
  };
}

function write(entry) {
  const file = join(HISTORY_DIR, `eve-${entry.eveVersion}.json`);
  const previous = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;

  // Same eve, different verdict, means *we* changed — a contract was added,
  // tightened, or a pin moved. Worth saying out loud, because the compat page
  // will start telling a different story about a version that never moved.
  if (previous !== null && previous.ok !== entry.ok) {
    process.stdout.write(
      `  ! verdict for eve ${entry.eveVersion} changed since ${previous.certifiedAt}: ` +
        `${previous.ok ? "green" : "red"} → ${entry.ok ? "green" : "red"}. eve did not move; evestack did.\n`,
    );
  }

  if (dryRun) return file;
  mkdirSync(HISTORY_DIR, { recursive: true });
  writeFileSync(file, `${JSON.stringify(entry, null, 2)}\n`);
  return file;
}

/* -------------------------------------------------------------------------- */
/* main                                                                        */
/* -------------------------------------------------------------------------- */

const targets = [];
if (npmFlag !== null) {
  for (const version of npmFlag.split(",").map((v) => v.trim()).filter(Boolean)) targets.push({ npm: version });
} else if (eveDirFlag !== null) {
  targets.push({ dir: resolve(REPO_ROOT, eveDirFlag) });
} else {
  targets.push({ installed: true });
}

let failures = 0;
for (const target of targets) {
  let root = null;
  let source;

  if (target.npm !== undefined) {
    process.stdout.write(`fetching eve@${target.npm}…\n`);
    ({ root, source } = fetchRelease(target.npm));
    provisionDependencies(cacheDir);
  } else if (target.dir !== undefined) {
    root = target.dir;
    source = { kind: "directory", spec: target.dir };
  } else {
    source = { kind: "installed", spec: "templates/default" };
  }

  const report = runSuite(root);
  const entry = record(report, source);
  const file = write(entry);

  const { contracts, failedContracts, assertions, failedAssertions } = entry.counts;
  process.stdout.write(
    `  ${entry.ok ? "green" : "RED  "} eve ${entry.eveVersion.padEnd(7)} ` +
      `${entry.ok ? `${contracts} contracts, ${assertions} assertions` : `${failedContracts}/${contracts} contracts, ${failedAssertions}/${assertions} assertions failed`}` +
      `${dryRun ? "  (dry run, not written)" : `  → ${file.slice(REPO_ROOT.length + 1)}`}\n`,
  );
  if (!entry.ok) failures += 1;
}

// Exit 0 even when a recorded version is red: recording a red is a successful
// recording. The compat page exists precisely to publish the reds.
process.stdout.write(
  `\n${targets.length} version(s) recorded, ${failures} red. Regenerate the page with:\n` +
    `  node contract/render-compat.mjs\n`,
);
