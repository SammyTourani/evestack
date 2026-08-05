import { readFile } from "node:fs/promises";
import path from "node:path";

/* Code shown on the site is read AT BUILD TIME from the real shipped files —
   the page can never drift from the code, and a moved file fails the build
   loudly. Never paste code samples inline. */

const repoRoot = path.join(process.cwd(), "..", "..");

async function readRepoFile(rel: string): Promise<string> {
  const raw = await readFile(path.join(repoRoot, rel), "utf8");
  return raw.trimEnd();
}

/* Each card must show its whole excerpt inside the visible box — no
   scrolling, no prose. The helpers below curate the real lines into that
   shape: comments stripped, overlong declarations re-wrapped (never
   rewritten), and a build-time width check so an excerpt that outgrows the
   box fails loudly instead of quietly clipping.

   Excerpts are anchored to the CODE, not to line numbers — the templates
   are living files (they drifted within an hour of the first line-pinned
   version), so each anchor finds its line by pattern and only fails the
   build if the anchored code genuinely disappears. */

/** Mono columns that fit the card without horizontal scroll (mobile-bound). */
const MAX_COLS = 45;

/** Drop full-line comments (`//`, `#`, block-comment lines) and collapse the
    blank runs they leave behind to at most one blank line. */
function stripComments(text: string): string {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (/^(\/\/|\/\*|\*|#)/.test(t)) continue;
    if (t === "" && (out.length === 0 || out[out.length - 1].trim() === "")) continue;
    out.push(line);
  }
  while (out.length > 0 && out[out.length - 1].trim() === "") out.pop();
  return out.join("\n");
}

/** `count` lines starting at the FIRST line matching `re`. A template edit
    that removes the anchored code fails the build instead of rendering a
    stale or mangled excerpt. */
function linesFrom(text: string, re: RegExp, count = 1): string {
  const lines = text.split("\n");
  const i = lines.findIndex((l) => re.test(l));
  if (i === -1) throw new Error(`code-samples: no line matches ${re}`);
  return lines.slice(i, i + count).join("\n").trimEnd();
}

/** `const x = <long expr>` → head on its own line, expression and any
    continuation lines indented one stop further. */
function breakAssign(block: string): string {
  const [head, ...rest] = block.split("\n");
  const eq = head.indexOf(" = ");
  if (eq === -1) throw new Error(`breakAssign: no assignment in "${head}"`);
  return [
    head.slice(0, eq + 2),
    `  ${head.slice(eq + 3)}`,
    ...rest.map((line) => `  ${line}`),
  ].join("\n");
}

const IMPORT_RE = /^import \{ (.+) \} from ("[^"]+");$/;

/** One-line named import → one specifier per line. */
function wrapImport(line: string): string {
  const m = IMPORT_RE.exec(line);
  if (!m) throw new Error(`wrapImport: not a named import: "${line}"`);
  return [
    "import {",
    ...m[1].split(", ").map((name) => `  ${name},`),
    `} from ${m[2]};`,
  ].join("\n");
}

/** Narrow a one-line named import to a single specifier. */
function pickImport(line: string, name: string): string {
  const m = IMPORT_RE.exec(line);
  if (!m || !m[1].split(", ").includes(name))
    throw new Error(`pickImport: "${name}" not in "${line}"`);
  return `import { ${name} } from ${m[2]};`;
}

/** Match against a real line; a source edit that breaks the match fails the
    build instead of rendering a stale or mangled excerpt. */
function extract(re: RegExp, line: string): RegExpExecArray {
  const m = re.exec(line);
  if (!m) throw new Error(`code-samples: ${re} no longer matches "${line}"`);
  return m;
}

function assertFits(code: string, filename: string): string {
  for (const line of code.split("\n"))
    if (line.length > MAX_COLS)
      throw new Error(`${filename}: "${line}" exceeds ${MAX_COLS} columns`);
  return code;
}

export interface CodeSample {
  filename: string;
  lang: "typescript" | "yaml" | "bash";
  code: string;
  note: string;
}

export async function getCodeSamples(): Promise<CodeSample[]> {
  const [compose, agent, instrumentation] = await Promise.all([
    readRepoFile("docker-compose.yml"),
    readRepoFile("templates/default/agent/agent.ts"),
    readRepoFile("templates/default/agent/instrumentation.ts"),
  ]);

  /* agent.ts's provider ternary and workflow spread are wider than the card;
     show the default branch each one resolves to, taken from the same lines.
     Same for instrumentation.ts's one-line exporter property. */
  const modelBranch = extract(/: openai\((.+)\);?$/, linesFrom(agent, /: openai\(/));
  const experimentalProp = extract(
    /\? \{ (.+) \} : \{\}/,
    linesFrom(agent, /experimental: \{ workflow \}/),
  );
  const exporterProp = extract(
    /^(\s*)traceExporter: (new \S+)\(\{ (.+) \}\),$/,
    linesFrom(instrumentation, /traceExporter:/),
  );
  const pad = exporterProp[1];

  return [
    {
      filename: "docker-compose.yml",
      lang: "yaml",
      // postgres — pgvector image, env, host port — plus the dashboard
      // waiting on its healthcheck.
      code: assertFits(
        stripComments(
          [
            linesFrom(compose, /^name: /),
            "",
            linesFrom(compose, /^services:/),
            linesFrom(compose, /^ {2}postgres:/),
            linesFrom(compose, /image: pgvector/),
            linesFrom(compose, /^\s+environment:/),
            linesFrom(compose, /POSTGRES_DB:/),
            linesFrom(compose, /^\s+ports:/),
            linesFrom(compose, /POSTGRES_PORT/),
            "",
            linesFrom(compose, /^ {2}dashboard:/),
            linesFrom(compose, /^\s+build:/),
            linesFrom(compose, /context: \.\/packages\/dashboard/),
            linesFrom(compose, /^\s+depends_on:/, 3),
          ].join("\n"),
        ),
        "docker-compose.yml",
      ),
      note: "The whole stack is a compose file",
    },
    {
      filename: "agent/agent.ts",
      lang: "typescript",
      // Imports, durable-session wiring, model selection, and the export
      // that ties them together.
      code: assertFits(
        stripComments(
          [
            linesFrom(agent, /^import \{ openai \}/),
            linesFrom(agent, /^import \{ defineAgent \}/),
            "",
            breakAssign(linesFrom(agent, /^const workflow = /, 3)),
            "",
            `const model = openai(\n  ${modelBranch[1]},\n);`,
            "",
            linesFrom(agent, /^export default defineAgent\(\{/, 2),
            `  ${experimentalProp[1]},`,
            "});",
          ].join("\n"),
        ),
        "agent/agent.ts",
      ),
      note: "Durable Postgres sessions, direct provider — no gateway",
    },
    {
      filename: "agent/instrumentation.ts",
      lang: "typescript",
      // The working exporter: registerOTel inside eve's instrumentation hook.
      code: assertFits(
        stripComments(
          [
            pickImport(linesFrom(instrumentation, /^import .+@vercel\/otel/), "registerOTel"),
            wrapImport(linesFrom(instrumentation, /^import .+eve\/instrumentation/)),
            "",
            linesFrom(instrumentation, /^export default defineInstrumentation\(\{/, 2),
            linesFrom(instrumentation, /^\s+registerOTel\(\{/, 2),
            [
              `${pad}traceExporter:`,
              `${pad}  ${exporterProp[2]}({`,
              `${pad}    ${exporterProp[3]},`,
              `${pad}  }),`,
            ].join("\n"),
            linesFrom(instrumentation, /^\s+\}\);$/, 2),
            "});",
          ].join("\n"),
        ),
        "agent/instrumentation.ts",
      ),
      note: "Ten lines of OTLP and the dashboard sees everything",
    },
  ];
}
