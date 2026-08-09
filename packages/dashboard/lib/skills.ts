import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";

/**
 * The agent's SKILL.md skills, read off disk.
 *
 * eve discovers skills by scanning `agent/skills/` and advertising each one's
 * description next to a framework-owned `load_skill` tool; the model pulls the
 * body into a turn only when it decides the description matches. That means a
 * skill is untyped instruction text that reaches the model's context without a
 * human in the loop — which is exactly why the file next to this one exists.
 *
 * Everything here mirrors eve 0.30.6's own discovery rules, read out of
 * `eve/dist/src/discover/skills.js` and `eve/dist/src/discover/filesystem.js`
 * rather than guessed:
 *
 *   - a subdirectory is a *packaged* skill and must contain `SKILL.md`
 *     (matched case-insensitively); its id is the directory name
 *   - a flat `.md` file is a skill whose id is the filename without `.md`
 *   - a flat `.ts`/`.cts`/`.mts`/`.js`/`.cjs`/`.mjs` file is a `defineSkill`
 *     module; `.d.ts` files are ignored
 *   - packaged frontmatter must carry a string `description`, or eve reports a
 *     discovery error and the skill never loads
 *   - flat markdown may omit it: eve derives one from the first non-empty,
 *     non-fence line with leading `#`, `>`, `*`, `-` stripped, falling back to
 *     "Instructions for the <name> skill."
 *   - only `description`, `license` and a string-valued `metadata` map are read;
 *     every other frontmatter key is accepted and then ignored
 *
 * The dashboard is frequently a container with no view of the agent's source
 * tree, so a missing directory is a normal state to render, never a throw.
 */

/** The one knob. Absolute, or relative to the dashboard's working directory. */
export const SKILLS_DIR_ENV = "EVESTACK_SKILLS_DIR";

/** eve's own default: `<agentRoot>/skills`, and agentRoot is `agent/`. */
const PROJECT_RELATIVE_SKILLS_DIR = join("agent", "skills");

/**
 * The fallback, and the premise it was written on was already wrong.
 *
 * This comment used to begin "The dashboard is cloned from the evestack repo
 * rather than generated into a project (see docs/dashboard.mdx)". That doc says
 * the opposite, and says so in a note that exists specifically to retract the
 * older claim: "This section used to open with 'The dashboard is not part of a
 * create-evestack project — clone the repository for it' … Both halves were
 * wrong: the scaffolder has shipped that compose service for a while". So the
 * justification cited, as its authority, a page that had been corrected to say
 * the reverse.
 *
 * What is actually true is narrower and still supports the fallback. In the
 * PUBLISHED IMAGE the working directory is `/repo/packages/dashboard`, and no
 * compose file this project writes mounts the user's project into it — so
 * `<cwd>/agent/skills` genuinely does not exist there, and never will until
 * someone mounts it. Falling back to the bundled template is what keeps the
 * page from being empty out of the box.
 *
 * THE COST, STATED PLAINLY, because it is a security page: in a container the
 * fallback ALWAYS resolves, so the Skills page always scans the image's own
 * copy of the template's skills and never the agent's. The skill it shows is
 * called `memory-hygiene`, which is also the name of the one the scaffolder
 * writes into a real project — so the page looks like it is reading your agent
 * when it is not. `resolvedBy: "bundled-template"` and the absolute path are
 * both rendered, which is what keeps this honest rather than silent, and
 * app/skills/page.tsx now says what to do about it in that case instead of only
 * in the branch where nothing is found at all.
 *
 * To scan your own: set EVESTACK_SKILLS_DIR and mount the directory into the
 * container. The env var reaches it already — the generated compose gives the
 * dashboard `env_file: .env.local` — so the mount is the missing half.
 */
const BUNDLED_TEMPLATE_SKILLS_DIR = join(
  "..",
  "..",
  "templates",
  "default",
  "agent",
  "skills",
);

const MODULE_SKILL_EXTENSIONS = [".ts", ".cts", ".mts", ".js", ".cjs", ".mjs"];

/** Ships-with-the-skill files are read for scanning, so they need bounds. */
const MAX_FILES_PER_SKILL = 200;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_WALK_DEPTH = 6;

export type SkillKind = "package" | "markdown" | "module";

export type SkillFileKind = "text" | "binary" | "too-large" | "symlink" | "unreadable";

export interface SkillFile {
  /** Slash-separated, relative to the skill's root. */
  path: string;
  kind: SkillFileKind;
  bytes: number;
  /** Present only for `kind === "text"`. */
  text?: string;
  /** Set when the entry is a symlink: where it points, verbatim. */
  linkTarget?: string;
}

export interface Skill {
  /** The id `load_skill` takes. */
  name: string;
  kind: SkillKind;
  description: string;
  /** How the description the model routes on was arrived at. */
  descriptionSource: "frontmatter" | "derived" | "fallback" | "unavailable";
  license?: string;
  metadata?: Record<string, string>;
  /** The markdown body, frontmatter stripped. Empty for module skills. */
  markdown: string;
  /** Absolute path of SKILL.md / <name>.md / <name>.ts. */
  entryPath: string;
  /** Absolute path of the skill's root — the package dir, or the file itself. */
  rootPath: string;
  /** Frontmatter keys eve parses but ignores. Sometimes load-bearing to a reader. */
  ignoredFrontmatterKeys: string[];
  /** Entry first, then package siblings. Empty for module skills. */
  files: SkillFile[];
  totalBytes: number;
  modifiedAt: string;
  /**
   * Reasons this skill is broken or partly unreadable. A non-empty list on a
   * packaged skill usually means eve will not load it at all.
   */
  problems: string[];
}

export interface SkillsDirectory {
  /** Absolute, even when it does not exist — the reader needs to know where we looked. */
  path: string;
  exists: boolean;
  resolvedBy: "env" | "project" | "bundled-template" | "none";
  /** Every absolute path tried, in order, when nothing was found. */
  searched: string[];
  /** Present when `exists` is false, or when the path is not a directory. */
  problem?: string;
}

export interface SkillsSnapshot {
  directory: SkillsDirectory;
  skills: Skill[];
}

function candidatePaths(): string[] {
  const cwd = process.cwd();
  const configured = process.env[SKILLS_DIR_ENV]?.trim();
  if (configured) return [isAbsolute(configured) ? configured : resolve(cwd, configured)];
  return [
    resolve(cwd, PROJECT_RELATIVE_SKILLS_DIR),
    resolve(cwd, BUNDLED_TEMPLATE_SKILLS_DIR),
  ];
}

async function directoryState(path: string): Promise<"directory" | "not-a-directory" | "missing"> {
  try {
    return (await stat(path)).isDirectory() ? "directory" : "not-a-directory";
  } catch {
    return "missing";
  }
}

async function resolveSkillsDirectory(): Promise<SkillsDirectory> {
  const fromEnv = Boolean(process.env[SKILLS_DIR_ENV]?.trim());
  const searched = candidatePaths();

  for (const [index, path] of searched.entries()) {
    const state = await directoryState(path);
    if (state === "directory") {
      return {
        path,
        exists: true,
        resolvedBy: fromEnv ? "env" : index === 0 ? "project" : "bundled-template",
        searched,
      };
    }
    if (state === "not-a-directory") {
      return {
        path,
        exists: false,
        resolvedBy: fromEnv ? "env" : index === 0 ? "project" : "bundled-template",
        searched,
        problem: `${path} exists but is not a directory. eve expects a directory of authored skills here.`,
      };
    }
  }

  return {
    path: searched[searched.length - 1] ?? resolve(process.cwd(), PROJECT_RELATIVE_SKILLS_DIR),
    exists: false,
    resolvedBy: "none",
    searched,
    problem: fromEnv
      ? `${SKILLS_DIR_ENV} points at ${searched[0]}, which does not exist.`
      : "No skills directory found. Set " +
        SKILLS_DIR_ENV +
        " to your agent's agent/skills path — the dashboard often runs in a container that cannot see the agent's source tree.",
  };
}

/* ------------------------------------------------------------------------- *
 * Frontmatter
 * ------------------------------------------------------------------------- */

interface ParsedMarkdown {
  hasFrontmatter: boolean;
  /** Only scalars and one level of string maps; see parseFrontmatter. */
  frontmatter: Map<string, string | Record<string, string> | null>;
  body: string;
  /** Frontmatter that opened but never closed — eve treats this as an error. */
  unterminated: boolean;
}

const FRONTMATTER_OPEN = /^---\r?\n/;

/**
 * A deliberately small YAML subset, not a YAML parser.
 *
 * eve parses frontmatter with gray-matter and then reads exactly three keys:
 * `description`, `license`, and a flat string-valued `metadata` map. Pulling a
 * YAML library into the dashboard to re-derive three strings would add a
 * dependency to a package that has four, so this handles the forms those keys
 * actually take — plain scalars, quoted scalars, `>`/`|` block scalars, and an
 * indented one-level map — and records anything else as an ignored key rather
 * than pretending to understand it.
 *
 * Where this parser and gray-matter could disagree, the disagreement shows up
 * as an ignored key or a missing description, both of which the UI reports. It
 * is never allowed to silently invent a value eve would not have seen.
 */
function parseFrontmatter(source: string): ParsedMarkdown {
  const empty: ParsedMarkdown = {
    hasFrontmatter: false,
    frontmatter: new Map(),
    body: source,
    unterminated: false,
  };
  if (!FRONTMATTER_OPEN.test(source)) return empty;

  const lines = source.split(/\r?\n/u);
  const closing = lines.findIndex((line, index) => index > 0 && line.trimEnd() === "---");
  if (closing === -1) return { ...empty, hasFrontmatter: true, unterminated: true };

  const frontmatter = new Map<string, string | Record<string, string> | null>();
  const block = lines.slice(1, closing);

  for (let index = 0; index < block.length; index += 1) {
    const line = block[index] ?? "";
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    // Only top-level keys start a new entry; indented lines belong to whatever
    // came before and are consumed by the branches below.
    if (/^\s/u.test(line)) continue;

    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const rest = line.slice(separator + 1).trim();
    if (key === "") continue;

    if (rest === "" || rest === ">" || rest === ">-" || rest === "|" || rest === "|-") {
      const indented: string[] = [];
      let cursor = index + 1;
      while (cursor < block.length) {
        const next = block[cursor] ?? "";
        if (next.trim() !== "" && !/^\s/u.test(next)) break;
        indented.push(next);
        cursor += 1;
      }
      index = cursor - 1;

      if (rest === "") {
        const nested = readNestedStringMap(indented);
        frontmatter.set(key, nested ?? null);
      } else {
        const folded = rest.startsWith(">");
        const text = indented.map((entry) => entry.trim()).filter((entry) => entry !== "");
        frontmatter.set(key, folded ? text.join(" ") : text.join("\n"));
      }
      continue;
    }

    frontmatter.set(key, unquote(rest));
  }

  return {
    hasFrontmatter: true,
    frontmatter,
    body: lines.slice(closing + 1).join("\n").replace(/^\r?\n/u, ""),
    unterminated: false,
  };
}

function readNestedStringMap(lines: string[]): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const line of lines) {
    if (line.trim() === "") continue;
    const separator = line.indexOf(":");
    if (separator === -1) return null;
    const key = line.slice(0, separator).trim();
    const value = unquote(line.slice(separator + 1).trim());
    if (key === "" || value === "") return null;
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  // A trailing `# comment` on a scalar is YAML, but `#` inside a sentence is
  // not — only strip it when whitespace precedes the hash.
  return trimmed.replace(/\s+#.*$/u, "").trim();
}

function readString(
  frontmatter: ParsedMarkdown["frontmatter"],
  key: string,
): string | undefined {
  const value = frontmatter.get(key);
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** eve's own fallback for flat markdown skills, reimplemented line for line. */
function deriveFlatDescription(body: string, slug: string): string {
  const line = body
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .find((entry) => entry !== "" && !entry.startsWith("```"));
  if (line === undefined) return `Instructions for the ${slug} skill.`;
  return line.replace(/^[#>*\-\s]+/u, "").trim() || `Instructions for the ${slug} skill.`;
}

/* ------------------------------------------------------------------------- *
 * Reading skills off disk
 * ------------------------------------------------------------------------- */

function moduleBaseName(fileName: string): string | null {
  if (/\.d\.(?:cts|mts|ts)$/u.test(fileName)) return null;
  for (const extension of MODULE_SKILL_EXTENSIONS) {
    if (fileName.endsWith(extension) && fileName.length > extension.length) {
      return fileName.slice(0, -extension.length);
    }
  }
  return null;
}

function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8192).includes(0);
}

async function readOneFile(absolutePath: string, relativePath: string): Promise<SkillFile> {
  try {
    const info = await stat(absolutePath);
    if (info.size > MAX_FILE_BYTES) {
      return { path: relativePath, kind: "too-large", bytes: info.size };
    }
    const buffer = await readFile(absolutePath);
    if (looksBinary(buffer)) {
      return { path: relativePath, kind: "binary", bytes: buffer.byteLength };
    }
    return { path: relativePath, kind: "text", bytes: buffer.byteLength, text: buffer.toString("utf8") };
  } catch {
    return { path: relativePath, kind: "unreadable", bytes: 0 };
  }
}

/**
 * Walks a skill package. Symlinks are recorded but never followed: following
 * one is how a skill package points at `~/.ssh` and gets its contents read by
 * whatever tries to be helpful about "supporting files".
 */
async function walkPackage(root: string): Promise<{ files: SkillFile[]; problems: string[] }> {
  const files: SkillFile[] = [];
  const problems: string[] = [];

  async function descend(directory: string, prefix: string, depth: number): Promise<void> {
    if (depth > MAX_WALK_DEPTH) {
      problems.push(`Stopped walking below ${prefix || "."}: deeper than ${MAX_WALK_DEPTH} levels.`);
      return;
    }
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      problems.push(`Could not read ${prefix || "."}: ${(error as Error).message}`);
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length >= MAX_FILES_PER_SKILL) {
        problems.push(`Only the first ${MAX_FILES_PER_SKILL} files were read; the rest were not scanned.`);
        return;
      }
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = join(directory, entry.name);

      if (entry.isSymbolicLink()) {
        let linkTarget = "";
        try {
          const { readlink } = await import("node:fs/promises");
          linkTarget = await readlink(absolutePath);
        } catch {
          linkTarget = "(unreadable)";
        }
        files.push({ path: relativePath, kind: "symlink", bytes: 0, linkTarget });
        continue;
      }
      if (entry.isDirectory()) {
        await descend(absolutePath, relativePath, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      files.push(await readOneFile(absolutePath, relativePath));
    }
  }

  await descend(root, "", 0);
  return { files, problems };
}

async function modifiedAt(path: string): Promise<string> {
  try {
    return (await stat(path)).mtime.toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

function ignoredKeys(frontmatter: ParsedMarkdown["frontmatter"]): string[] {
  const read = new Set(["description", "license", "metadata"]);
  return [...frontmatter.keys()].filter((key) => !read.has(key)).sort();
}

async function readPackagedSkill(root: string, name: string): Promise<Skill> {
  const problems: string[] = [];
  const { files, problems: walkProblems } = await walkPackage(root);
  problems.push(...walkProblems);

  // eve matches SKILL.md case-insensitively; anything else in the package is a
  // resource, not an entry point.
  const entry = files.find((file) => file.path.toLowerCase() === "skill.md");
  const entryPath = join(root, entry?.path ?? "SKILL.md");
  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);

  if (!entry || entry.kind !== "text" || entry.text === undefined) {
    problems.push(
      entry
        ? `SKILL.md is ${entry.kind}, so eve cannot parse it. The skill will not load.`
        : "No SKILL.md in this directory. eve reports a discovery error and the skill never loads.",
    );
    return {
      name,
      kind: "package",
      description: "",
      descriptionSource: "unavailable",
      markdown: "",
      entryPath,
      rootPath: root,
      ignoredFrontmatterKeys: [],
      files,
      totalBytes,
      modifiedAt: await modifiedAt(root),
      problems,
    };
  }

  const parsed = parseFrontmatter(entry.text);
  if (parsed.unterminated) {
    problems.push("Frontmatter opens with `---` but never closes. eve fails discovery on this.");
  }
  const description = readString(parsed.frontmatter, "description");
  if (!parsed.hasFrontmatter) {
    problems.push("No YAML frontmatter. A packaged skill must declare `description` or eve will not load it.");
  } else if (!description) {
    problems.push("Frontmatter has no string `description`. eve refuses to load the skill without one.");
  }

  const license = readString(parsed.frontmatter, "license");
  const metadataValue = parsed.frontmatter.get("metadata");
  const metadata = metadataValue && typeof metadataValue === "object" ? metadataValue : undefined;

  const skill: Skill = {
    name,
    kind: "package",
    description: description ?? "",
    descriptionSource: description ? "frontmatter" : "unavailable",
    markdown: parsed.body,
    entryPath,
    rootPath: root,
    ignoredFrontmatterKeys: ignoredKeys(parsed.frontmatter),
    files,
    totalBytes,
    modifiedAt: await modifiedAt(entryPath),
    problems,
  };
  if (license) skill.license = license;
  if (metadata) skill.metadata = metadata;
  return skill;
}

async function readFlatMarkdownSkill(path: string, name: string): Promise<Skill> {
  const problems: string[] = [];
  const file = await readOneFile(path, `${name}.md`);
  if (file.kind !== "text" || file.text === undefined) {
    problems.push(`Could not read this skill as text (${file.kind}).`);
    return {
      name,
      kind: "markdown",
      description: "",
      descriptionSource: "unavailable",
      markdown: "",
      entryPath: path,
      rootPath: path,
      ignoredFrontmatterKeys: [],
      files: [file],
      totalBytes: file.bytes,
      modifiedAt: await modifiedAt(path),
      problems,
    };
  }

  const parsed = parseFrontmatter(file.text);
  if (parsed.unterminated) {
    problems.push("Frontmatter opens with `---` but never closes. eve fails discovery on this.");
  }
  const declared = readString(parsed.frontmatter, "description");
  const derived = deriveFlatDescription(parsed.body, name);
  const isFallback = !declared && derived === `Instructions for the ${name} skill.`;
  if (isFallback) {
    problems.push(
      "No description and nothing to derive one from, so eve advertises a placeholder. The model has almost no reason to ever load this.",
    );
  }

  const license = readString(parsed.frontmatter, "license");
  const metadataValue = parsed.frontmatter.get("metadata");
  const metadata = metadataValue && typeof metadataValue === "object" ? metadataValue : undefined;

  const skill: Skill = {
    name,
    kind: "markdown",
    description: declared ?? derived,
    descriptionSource: declared ? "frontmatter" : isFallback ? "fallback" : "derived",
    markdown: parsed.body,
    entryPath: path,
    rootPath: path,
    ignoredFrontmatterKeys: ignoredKeys(parsed.frontmatter),
    files: [file],
    totalBytes: file.bytes,
    modifiedAt: await modifiedAt(path),
    problems,
  };
  if (license) skill.license = license;
  if (metadata) skill.metadata = metadata;
  return skill;
}

async function readModuleSkill(path: string, name: string): Promise<Skill> {
  const file = await readOneFile(path, path.split(sep).pop() ?? name);
  return {
    name,
    kind: "module",
    description: "",
    // A defineSkill module's description is a value in TypeScript, not text on
    // disk. Executing the module to find out is precisely what this page must
    // not do, so it is reported as unknown rather than parsed out with a regex
    // that would be wrong the first time someone builds a template literal.
    descriptionSource: "unavailable",
    markdown: "",
    entryPath: path,
    rootPath: path,
    ignoredFrontmatterKeys: [],
    files: [file],
    totalBytes: file.bytes,
    modifiedAt: await modifiedAt(path),
    problems: [
      "TypeScript skill: eve resolves its description and files by running the module at build time. This page reads files, so the description is unknown and only the source text is scanned.",
    ],
  };
}

/** Everything on disk right now. Never throws for a missing directory. */
export async function listSkills(): Promise<SkillsSnapshot> {
  const directory = await resolveSkillsDirectory();
  if (!directory.exists) return { directory, skills: [] };

  let entries;
  try {
    entries = await readdir(directory.path, { withFileTypes: true });
  } catch (error) {
    return {
      directory: { ...directory, exists: false, problem: `Could not read ${directory.path}: ${(error as Error).message}` },
      skills: [],
    };
  }

  const skills: Skill[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolutePath = join(directory.path, entry.name);
    if (entry.isDirectory()) {
      skills.push(await readPackagedSkill(absolutePath, entry.name));
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name.toLowerCase().endsWith(".md")) {
      skills.push(await readFlatMarkdownSkill(absolutePath, entry.name.slice(0, -3)));
      continue;
    }
    const base = moduleBaseName(entry.name);
    if (base !== null) skills.push(await readModuleSkill(absolutePath, base));
  }

  return { directory, skills };
}

/**
 * One skill by the id `load_skill` takes.
 *
 * Resolved by listing and matching rather than by joining the caller's string
 * onto a path: the name arrives from an HTTP route, and `../../etc/passwd` is
 * not a skill.
 */
export async function getSkill(name: string): Promise<Skill | null> {
  const { skills } = await listSkills();
  return skills.find((skill) => skill.name === name) ?? null;
}

/** The bundled malicious fixture, for proving the scanner is armed. See fixtures/README.md. */
export async function readFixtureSkill(name: string): Promise<Skill | null> {
  const root = resolve(process.cwd(), "fixtures", "skills", name);
  if ((await directoryState(root)) !== "directory") return null;
  return readPackagedSkill(root, name);
}
