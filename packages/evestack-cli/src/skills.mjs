/** Install the setup pack shipped with this CLI. EVESTACK_PACK_URL is an explicit
 * override for a custom server; it is not assumed to match this installed version. */
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { loadSkillPack } from "./skill-pack.mjs";
import { constants, existsSync } from "node:fs";
import nodePath, { dirname, isAbsolute, join, resolve } from "node:path";

import {
  c,
  fixLine,
  forStream,
  g,
  headingLine,
  rowLine,
} from "create-evestack/ui";

export const SKILLS_USAGE = `evestack skills — teach your coding agent this project

  evestack skills [--dir=PATH] [--print] [--force]

Writes the evestack skill pack — SKILL.md plus four reference files — where your
agent will find it. Claude Code, Cursor, an eve agent, or anything that reads
markdown from a skills directory. The default pack is bundled with this CLI and works
offline. EVESTACK_PACK_URL explicitly selects a custom pack, which may differ in version.

Options
  --dir=PATH   where to write it. Default: agent/skills/evestack inside an eve
               project, otherwise .claude/skills/evestack
  --print      write the pack to stdout and touch no files
  --force      overwrite files that already exist
  --json       report what was written, as JSON
  -h, --help   this

Exit codes
  0  installed, or printed
  1  could not load the pack, or refused to overwrite
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
    return {
      dir: join(cwd, "agent", "skills", "evestack"),
      reason: "eve project",
    };
  }
  return {
    dir: join(cwd, ".claude", "skills", "evestack"),
    reason: "Claude Code",
  };
}

export function parseSkillsArgs(argv) {
  const options = {
    print: false,
    force: false,
    json: false,
    help: false,
    dir: null,
  };
  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") options.help = true;
    else if (arg === "--print") options.print = true;
    else if (arg === "--force") options.force = true;
    else if (arg === "--json") options.json = true;
    else if (arg.startsWith("--dir=")) options.dir = arg.slice("--dir=".length);
    else if (arg === "--dir") {
      // Refused rather than guessed, the same way doctor refuses `--limit 50`.
      throw new Error(`--dir needs a value, as --dir=PATH\n\n${SKILLS_USAGE}`);
    } else
      throw new Error(
        `Unknown option ${JSON.stringify(arg)}\n\n${SKILLS_USAGE}`,
      );
  }
  return options;
}

/**
 * Never let a served path escape the target directory.
 *
 * THE PREVIOUS VERSION WAS A STRING COMPARISON, and it was wrong twice.
 *
 *   `full.startsWith(root + "/")` — a hardcoded forward slash against a path
 *   that `resolve()` had just built with the PLATFORM separator. On Windows
 *   `resolve("C:\u\.claude\skills\evestack", "SKILL.md")` is
 *   `C:\u\.claude\skills\evestack\SKILL.md`, which does not start with
 *   `C:\u\.claude\skills\evestack/`. So every file was refused, for every
 *   path, and `evestack skills` could not write anything at all on native
 *   Windows — a total failure of the command reported as a security refusal,
 *   which is the message least likely to make anyone suspect a bug.
 *
 *   And `--dir=/tmp/x/` — a trailing slash, which is what tab completion
 *   produces. `root + "/"` becomes `/tmp/x//`, nothing starts with that, and the
 *   same false refusal appears on POSIX too.
 *
 * `relative()` answers the real question instead of approximating it: it
 * normalises both sides, uses the platform separator, and returns the path FROM
 * root TO the resolved file. That path is inside root exactly when it neither
 * climbs (`..` as a whole first segment) nor restarts from a root of its own.
 *
 * Both checks are needed, and the second is not theoretical. On Windows a
 * served path of `D:\evil.md` under a root on `C:` gives a relative of
 * `D:\evil.md` — absolute, no `..` anywhere in it, and outside the target.
 * `isAbsolute` is the only thing that catches a different drive.
 *
 * The `..` test is on SEGMENTS rather than a `startsWith("..")`, which would
 * also reject a legitimate `..config.md`. Split on both separators because a
 * pack may serve `a/b` and Windows `relative()` returns `a\b`; accepting either
 * costs nothing and assuming one is how the bug above happened.
 *
 * `path` is a parameter defaulting to the platform's own module, so the Windows
 * behaviour is testable with `path.win32` from a machine that is not Windows.
 * That is the only reason it exists — no caller passes it.
 */
export function safeJoin(root, relative, path = nodePath) {
  const full = path.resolve(root, relative);
  const inside = path.relative(path.resolve(root), full);
  const climbs = inside.split(/[\\/]/).includes("..");
  if (climbs || path.isAbsolute(inside)) {
    throw new Error(
      `Refusing to write outside the target directory: ${relative}`,
    );
  }
  return full;
}

async function checkTargets(root, files) {
  const base = resolve(root);
  const names = new Set();
  for (const file of files) {
    if (file.full === base || names.has(file.full.toLowerCase()))
      throw new Error(
        "The setup pack resolves duplicate or empty file paths. Nothing was written.",
      );
    names.add(file.full.toLowerCase());
    const parts = nodePath.relative(base, file.full).split(nodePath.sep);
    for (let i = 0; i <= parts.length; i++) {
      const target = join(base, ...parts.slice(0, i));
      try {
        const info = await lstat(target);
        if (info.isSymbolicLink())
          throw new Error(
            `Refusing a symlink in the setup destination: ${target}. Nothing was written.`,
          );
        if (i < parts.length ? !info.isDirectory() : !info.isFile())
          throw new Error(
            `Unexpected file type in the setup destination: ${target}. Nothing was written.`,
          );
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
}

export async function skills(
  argv,
  { stdout = process.stdout, stderr = process.stderr } = {},
) {
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
    pack = await loadSkillPack();
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
    ? {
        dir: isAbsolute(options.dir)
          ? options.dir
          : resolve(process.cwd(), options.dir),
        reason: "--dir",
      }
    : defaultTarget();

  /* Resolve every path BEFORE touching the disk, and inside the guard.
     safeJoin throws, and this loop used to run outside any try — so a served
     path like `../../x` escaped as an uncaught rejection instead of the exit-1
     sentence it is supposed to produce. Resolving up front also means a
     malicious entry anywhere in the list stops the whole install rather than
     the ones before it having already been written. */
  let resolved;
  try {
    resolved = pack.files.map((file) => ({
      ...file,
      full: safeJoin(target.dir, file.path),
    }));
    await checkTargets(target.dir, resolved);
  } catch (error) {
    stderr.write(`${error?.message ?? error}\n`);
    return 1;
  }

  const existing = resolved
    .filter((file) => existsSync(file.full))
    .map((file) => file.path);
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
      await writeFile(file.full, file.content, {
        encoding: "utf8",
        flag:
          constants.O_WRONLY |
          constants.O_CREAT |
          (options.force ? constants.O_TRUNC : constants.O_EXCL) |
          (constants.O_NOFOLLOW ?? 0),
      });
      written.push(file.full);
    }
  } catch (error) {
    stderr.write(
      `Could not write to ${target.dir}: ${error?.message ?? error}\n`,
    );
    return 1;
  }

  if (options.json) {
    stdout.write(
      `${JSON.stringify({ dir: target.dir, files: written, source: pack.source, version: pack.version }, null, 2)}\n`,
    );
    return 0;
  }

  /*
   * Built as lines and written once, to the stdout this function was handed.
   *
   * THE BUG: this block used `heading()`, `row()`, `fix()` and `blank()` from
   * create-evestack/ui, and every one of those is the PRINTING form — it calls
   * `say()`, which writes to the real `process.stdout` (ui.mjs:256). Only the
   * two `out(...)` lines ever reached the `stdout` this function accepts. So on
   * the success path the parameter was a lie for most of the banner: a caller
   * that passed a stream got the two dim lines and nothing else, while the
   * heading, the per-file rows and the fix line went past it to the terminal.
   * In test/skills.test.mjs every install case passes `sink()`, so the banner
   * was unassertable — and worse, when the two streams differ the output is not
   * even in order, because the interleaved writes land in two places.
   *
   * ui.mjs:259-269 documents this hazard by name and gives the shape out of it:
   * "`xLine(...)` returns the string and `x(...)` prints it" — the string forms
   * exist precisely so a command that takes a stream can honour it. status.mjs
   * (see status.mjs:442-446, which carries the same note after the same fix) is
   * the corrected version of this pattern; this is now the same shape.
   *
   * Byte-identical for a human at a terminal. `forStream` returns its input
   * untouched when the stream is a TTY, and when the real stdout is not a TTY
   * ui.mjs's module-level `color` is already false, so nothing was coloured in
   * the first place. The only behaviour that changes is the one that was broken:
   * output aimed at a non-TTY stream the caller supplied now arrives there,
   * uncoloured, whole and in order.
   */
  const lines = [
    headingLine(
      "Skill installed",
      pack.source === "bundled"
        ? `setup files for evestack ${pack.version}`
        : "custom setup files; version match unverified",
    ),
    // `g.ok` — the bare glyph, not the pre-coloured `g.OK`. Kept exactly as it
    // was: this is a rendering change, not a restyle.
    ...pack.files.map((file) =>
      rowLine(g.ok, file.path, "", "", { labelWidth: 22 }),
    ),
    "",
    `  ${c.dim("in")} ${target.dir}`,
    "",
    `  ${c.dim("Ask your agent to set evestack up, or run:")}`,
    fixLine("npx evestack create"),
    "",
  ];
  stdout.write(`${forStream(stdout, lines.join("\n"))}\n`);
  return 0;
}
