/**
 * `evestack skills` — install the evestack skill pack into the agent you
 * already work in.
 *
 * The same pack the landing page's "Set up your agent" button copies, written
 * to disk instead of to a clipboard. Pasting puts it in one conversation;
 * installing puts it in every conversation that agent ever has about this
 * project, and costs nothing after the first run.
 *
 * WHERE THE BYTES COME FROM, and why not from this package. The pack is
 * authored once at the repository root (`/skills/evestack`) and served from
 * the site. Vendoring a copy under packages/evestack-cli and syncing it at
 * pack time is the obvious alternative and it is the one this repo keeps
 * paying for: a synced second copy drifts, silently, and then a stranger's
 * agent is confidently repeating something that was true a release ago.
 *
 * The cost is a network call. It is not a NEW cost — `npx evestack skills`
 * already had to reach the registry to run this file at all — and the one case
 * it genuinely constrains, an offline global install, gets a sentence naming
 * the URL rather than a stack trace.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { c, forStream, g, heading, row, fix, blank } from "create-evestack/ui";

const DEFAULT_PACK_URL = "https://evestack.vercel.app/agent-pack.json";

/**
 * Resolved per call, not at module load.
 *
 * Read once into a module constant, the override only takes effect when it is
 * already in the environment before this file is imported. That is the normal
 * CLI case and it hid the flaw: anything that imports the module first and sets
 * the variable second — a test, a wrapper script, a REPL — silently talked to
 * production instead. Caught by a test that got a 404 from the real site.
 */
function packUrl() {
  return process.env.EVESTACK_PACK_URL?.trim() || DEFAULT_PACK_URL;
}

export const SKILLS_USAGE = `evestack skills — teach your coding agent this project

  evestack skills [--dir=PATH] [--print] [--force]

Writes the evestack skill pack — SKILL.md plus four reference files — where your
agent will find it. Claude Code, Cursor, an eve agent, or anything that reads
markdown from a skills directory.

Options
  --dir=PATH   where to write it. Default: agent/skills/evestack inside an eve
               project, otherwise .claude/skills/evestack
  --print      write the pack to stdout and touch no files
  --force      overwrite files that already exist
  --json       report what was written, as JSON
  -h, --help   this

Exit codes
  0  installed, or printed
  1  could not fetch the pack, or refused to overwrite
  2  bad arguments
`;

/**
 * Where the pack goes when nobody said.
 *
 * `agent/skills` first and only when it already exists: inside a scaffolded
 * project that directory is a real runtime location — eve scans it and hands
 * the model a `load_skill` tool — so a pack written there is loadable by the
 * agent being built, not just readable by the agent building it. Everywhere
 * else `.claude/skills` is the honest default, and it is created rather than
 * required, because the common case is someone who has never made one.
 */
export function defaultTarget(cwd = process.cwd()) {
  if (existsSync(join(cwd, "agent", "skills"))) {
    return { dir: join(cwd, "agent", "skills", "evestack"), reason: "eve project" };
  }
  return { dir: join(cwd, ".claude", "skills", "evestack"), reason: "Claude Code" };
}

export function parseSkillsArgs(argv) {
  const options = { print: false, force: false, json: false, help: false, dir: null };
  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") options.help = true;
    else if (arg === "--print") options.print = true;
    else if (arg === "--force") options.force = true;
    else if (arg === "--json") options.json = true;
    else if (arg.startsWith("--dir=")) options.dir = arg.slice("--dir=".length);
    else if (arg === "--dir") {
      // Refused rather than guessed, the same way doctor refuses `--limit 50`.
      throw new Error(`--dir needs a value, as --dir=PATH\n\n${SKILLS_USAGE}`);
    } else throw new Error(`Unknown option ${JSON.stringify(arg)}\n\n${SKILLS_USAGE}`);
  }
  return options;
}

async function fetchPack() {
  const url = packUrl();
  let response;
  try {
    response = await fetch(url, { headers: { accept: "application/json" } });
  } catch (error) {
    throw new Error(
      `Could not reach ${url} — ${error?.message ?? error}\n` +
        "  The pack is fetched rather than bundled so it cannot go stale.\n" +
        "  Offline? Open the URL on any machine and save the files by hand, or\n" +
        "  copy the pack from https://evestack.vercel.app/agent.md",
    );
  }
  if (!response.ok) {
    throw new Error(`${url} answered ${response.status}. Try again, or read /agent.md.`);
  }
  const pack = await response.json();
  if (!Array.isArray(pack?.files) || pack.files.length === 0) {
    throw new Error(`${url} returned no files. Nothing was written.`);
  }
  return pack;
}

/** Never let a served path escape the target directory. */
function safeJoin(root, relative) {
  const full = resolve(root, relative);
  if (full !== root && !full.startsWith(root + "/")) {
    throw new Error(`Refusing to write outside the target directory: ${relative}`);
  }
  return full;
}

export async function skills(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  let options;
  try {
    options = parseSkillsArgs(argv);
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return 2;
  }

  if (options.help) {
    stdout.write(SKILLS_USAGE);
    return 0;
  }

  let pack;
  try {
    pack = await fetchPack();
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return 1;
  }

  /* --print writes the pack to stdout and nothing else, so it can be piped or
     pasted. Each file is announced with its path first — the destination
     matters as much as the content, and a bare concatenation loses it. */
  if (options.print) {
    for (const file of pack.files) {
      stdout.write(`===== ${file.path} =====\n${file.content}\n`);
    }
    return 0;
  }

  const target = options.dir
    ? { dir: isAbsolute(options.dir) ? options.dir : resolve(process.cwd(), options.dir), reason: "--dir" }
    : defaultTarget();

  /* Resolve every path BEFORE touching the disk, and inside the guard.
     safeJoin throws, and this loop used to run outside any try — so a served
     path like `../../x` escaped as an uncaught rejection instead of the exit-1
     sentence it is supposed to produce. Resolving up front also means a
     malicious entry anywhere in the list stops the whole install rather than
     the ones before it having already been written. */
  let resolved;
  try {
    resolved = pack.files.map((file) => ({ ...file, full: safeJoin(target.dir, file.path) }));
  } catch (error) {
    stderr.write(`${error?.message ?? error}\n`);
    return 1;
  }

  const existing = resolved.filter((file) => existsSync(file.full)).map((file) => file.path);
  if (existing.length > 0 && !options.force) {
    stderr.write(
      `${target.dir} already has ${existing.length} of these files:\n` +
        existing.map((p) => `    ${p}\n`).join("") +
        "\n  Nothing was written. Re-run with --force to overwrite.\n",
    );
    return 1;
  }

  const written = [];
  try {
    for (const file of resolved) {
      await mkdir(dirname(file.full), { recursive: true });
      await writeFile(file.full, file.content, "utf8");
      written.push(file.full);
    }
  } catch (error) {
    stderr.write(`Could not write to ${target.dir}: ${error?.message ?? error}\n`);
    return 1;
  }

  if (options.json) {
    stdout.write(`${JSON.stringify({ dir: target.dir, files: written }, null, 2)}\n`);
    return 0;
  }

  const out = (text) => stdout.write(`${forStream(stdout, text)}\n`);
  heading("Skill installed", "your agent now knows evestack");
  for (const file of pack.files) {
    row(g.ok, file.path, "", "", { labelWidth: 22 });
  }
  blank();
  out(`  ${c.dim("in")} ${target.dir}`);
  blank();
  out(`  ${c.dim("Ask your agent to set evestack up, or run:")}`);
  fix("npx evestack create");
  blank();
  return 0;
}
