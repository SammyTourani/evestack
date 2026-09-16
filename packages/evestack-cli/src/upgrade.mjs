import { createHash } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findProjectEnv, notAProject, wantsHelp } from "./project.mjs";

const LIMIT = 2 * 1024 * 1024;
const EXCLUDED = new Set([
  "node_modules",
  ".git",
  ".eve",
  ".next",
  "dist",
  "coverage",
  ".DS_Store",
  ".npmrc",
]);
const safeName = (name) =>
  name !== ".." && name !== "." && !/[\x00-\x1f\x7f\\]/.test(name);
const allowed = (path) =>
  path
    .split("/")
    .every(
      (part) =>
        safeName(part) &&
        !EXCLUDED.has(part) &&
        (!part.startsWith(".env") || part === ".env.example"),
    );
const printable = (value) => String(value).replace(/[\x00-\x1f\x7f]/g, " ");
const publicVersion = (value) =>
  typeof value === "string" &&
  /^(?:workspace:\*|[~^]?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.test(value)
    ? value
    : value === undefined
      ? null
      : "custom specifier (inspect locally)";

function readInside(root, path, limit = LIMIT) {
  if (
    !allowed(path) ||
    path.startsWith("/") ||
    path.split("/").some((part) => !part)
  )
    throw new Error("Unsupported template path.");
  let current = root;
  for (const [index, part] of path.split("/").entries()) {
    current = join(current, part);
    let info;
    try {
      info = lstatSync(current);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw new Error("The file could not be inspected.");
    }
    if (info.isSymbolicLink())
      throw new Error(
        "A symlink needs manual review; its contents were not read.",
      );
    if (index < path.split("/").length - 1 && !info.isDirectory())
      throw new Error("A parent path is not a directory.");
  }
  let fd;
  try {
    fd = openSync(current, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > limit)
      throw new Error(
        "Not a regular file within the remaining comparison limit (at most 2 MiB per file).",
      );
    const buffer = Buffer.alloc(limit + 1);
    let used = 0;
    while (used < buffer.length) {
      const size = readSync(fd, buffer, used, buffer.length - used, null);
      if (!size) break;
      used += size;
    }
    if (used > limit)
      throw new Error("The file grew beyond the comparison limit.");
    return buffer.subarray(0, used);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function candidateFiles(root, dir = "", paths = [], visited = { count: 0 }) {
  if (dir.split("/").length > 32)
    throw new Error("The template exceeds the directory depth limit.");
  for (const entry of readdirSync(join(root, dir), {
    withFileTypes: true,
  }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (++visited.count > 5000)
      throw new Error("The template exceeds the directory entry limit.");
    const path = dir ? `${dir}/${entry.name}` : entry.name;
    if (!allowed(path)) continue;
    if (entry.isSymbolicLink())
      throw new Error(
        "The bundled template contains a symlink; reinstall the CLI before comparing.",
      );
    if (entry.isDirectory()) candidateFiles(root, path, paths, visited);
    else if (entry.isFile()) paths.push(path);
    else
      throw new Error(
        "The bundled template contains an unsupported file type.",
      );
    if (paths.length > 1000)
      throw new Error("The template exceeds the 1,000-file comparison limit.");
  }
  return paths;
}

function jsonInside(root, path, required = false) {
  const bytes = readInside(root, path);
  if (bytes === null) {
    if (required)
      throw new Error(`Missing ${path}; cannot compare this project.`);
    return null;
  }
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error();
    return value;
  } catch {
    throw new Error(
      `${path} is not a JSON object. Its contents were not printed.`,
    );
  }
}

export function upgradePlan(
  projectRoot,
  candidateRoot = join(
    dirname(fileURLToPath(import.meta.resolve("create-evestack/package.json"))),
    "template",
  ),
) {
  const project = realpathSync(projectRoot),
    candidate = realpathSync(candidateRoot);
  if (project === candidate)
    throw new Error("The candidate and project must be different directories.");
  const installed = jsonInside(project, "package.json", true);
  const proposed = jsonInside(candidate, "package.json", true);
  const recorded = jsonInside(project, "evestack-release.json");
  const combination = jsonInside(candidate, "evestack-release.json");
  const files = [];
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  let remainingBytes = 64 * 1024 * 1024;
  for (const source of candidateFiles(candidate)) {
    const path = source === "gitignore" ? ".gitignore" : source;
    try {
      const wanted = readInside(
        candidate,
        source,
        Math.min(LIMIT, remainingBytes),
      );
      if (wanted === null)
        throw new Error(
          "The candidate changed during comparison; rerun the preview.",
        );
      remainingBytes -= wanted.length;
      const current = readInside(
        project,
        path,
        Math.min(LIMIT, remainingBytes),
      );
      remainingBytes -= current?.length ?? 0;
      files.push({
        path,
        status:
          current === null
            ? "missing"
            : wanted.equals(current)
              ? "same"
              : "review",
        currentHash: current === null ? null : hash(current),
        candidateHash: hash(wanted),
      });
    } catch (error) {
      files.push({
        path,
        status: "blocked",
        reason:
          error instanceof Error ? error.message : "Could not inspect file.",
      });
    }
  }
  const dependencies = Object.entries(proposed.dependencies ?? {}).map(
    ([name, value]) => ({
      name,
      current: publicVersion(
        installed.dependencies?.[name] ?? installed.devDependencies?.[name],
      ),
      candidate: publicVersion(value),
    }),
  );
  const versions = (value) =>
    Object.fromEntries(
      Object.entries(value?.packages ?? {})
        .filter(([name]) => /^[a-z0-9@/._-]{1,100}$/.test(name))
        .map(([name, version]) => [name, publicVersion(version)]),
    );
  return {
    formatVersion: 1,
    project,
    candidate,
    recordedCombination: recorded ? versions(recorded) : null,
    candidateCombination: combination ? versions(combination) : null,
    dependencies,
    files,
    counts: Object.fromEntries(
      ["same", "review", "missing", "blocked"].map((state) => [
        state,
        files.filter((file) => file.status === state).length,
      ]),
    ),
    note: "Read-only preview of the template bundled with this CLI. No files, dependencies, secrets, services or database state were changed. Different files require manual merging; without an original template baseline this cannot distinguish local edits from old defaults. Project-specific package/agent/compose choices must be retained. Extra project files are not removal candidates. Declared dependency ranges and a recorded release manifest do not verify installed packages or running services.",
    nextSteps: [
      "Back up and verify a restore of Postgres, and privately back up environment configuration before changing anything.",
      "Compare the listed candidate files locally and merge only the changes you need. Keep project-specific settings, plugins, dependencies and lockfile choices; never copy over .env or .env.local.",
      "Review the component release manifest, migration guards and release notes. Confirm the exact package versions and dashboard image are published before installation.",
      "After a reviewed upgrade, rebuild/restart the affected services, run evestack verify, then inspect a real task and any required channel or scheduled receipt.",
    ],
  };
}

export const UPGRADE_USAGE = `evestack upgrade — preview changes from this CLI's bundled template

  evestack upgrade [--json] [--changed-only]

Reads template/code hashes and declared dependency versions. Writes nothing and
does not download, install, restart or migrate anything. Different files require
manual merging; an older project usually has no original-template baseline.
Environment secrets, caches and extra project files are excluded. Symlinks and
oversized files need manual review. A preview is not a backup or a release check.

Use the desired CLI version to choose a candidate; this does not fetch 'latest'.
Exit 0: preview complete (manual changes may remain); 1: cannot fully compare;
2: no project found. --help needs no project and changes nothing.
`;

export async function upgrade(
  argv,
  {
    cwd = process.cwd(),
    stdout = process.stdout,
    stderr = process.stderr,
  } = {},
) {
  if (wantsHelp(argv)) {
    stdout.write(UPGRADE_USAGE);
    return 0;
  }
  try {
    if (argv.some((arg) => !["--json", "--changed-only"].includes(arg)))
      throw new Error(
        "Use --json, --changed-only or --help. Upgrade only previews; there is no apply flag.",
      );
    const found = findProjectEnv(cwd);
    if (!found) return notAProject(stderr);
    const plan = upgradePlan(found.dir);
    if (argv.includes("--changed-only"))
      plan.files = plan.files.filter((file) => file.status !== "same");
    if (argv.includes("--json"))
      stdout.write(JSON.stringify(plan, null, 2) + "\n");
    else {
      stdout.write(
        `Upgrade preview\nCandidate: ${printable(plan.candidate)}\n\n${plan.note}\n\n`,
      );
      for (const item of plan.dependencies)
        if (item.current !== item.candidate)
          stdout.write(
            `${printable(item.name)}: ${item.current ?? "absent"} → ${item.candidate}\n`,
          );
      stdout.write("\n");
      for (const file of plan.files)
        stdout.write(
          `${file.status.padEnd(8)} ${printable(file.path)}${file.reason ? " — " + printable(file.reason) : ""}\n`,
        );
      stdout.write(
        `\n${Object.entries(plan.counts)
          .map(([name, count]) => `${count} ${name}`)
          .join(", ")}\n\n`,
      );
      plan.nextSteps.forEach((step, index) =>
        stdout.write(`${index + 1}. ${step}\n`),
      );
    }
    return plan.counts.blocked ? 1 : 0;
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Could not compare this project.";
    if (argv.includes("--json"))
      stdout.write(JSON.stringify({ ok: false, error: message }) + "\n");
    else stderr.write(printable(message) + "\n");
    return 1;
  }
}
