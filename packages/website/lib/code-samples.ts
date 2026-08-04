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

/** Keep lines [start, end) — 0-indexed, end exclusive. */
function slice(text: string, start: number, end?: number): string {
  return text.split("\n").slice(start, end).join("\n").trimEnd();
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

  return [
    {
      filename: "docker-compose.yml",
      lang: "yaml",
      // Header comment + postgres service — the "$0, nothing phones home" block.
      code: slice(compose, 0, 28),
      note: "The whole stack is a compose file",
    },
    {
      filename: "agent/agent.ts",
      lang: "typescript",
      code: agent,
      note: "Durable Postgres sessions, direct provider — no gateway",
    },
    {
      filename: "agent/instrumentation.ts",
      lang: "typescript",
      // Skip the long doc comment; show the working exporter.
      code: slice(instrumentation, 0, 2) + "\n\n" + slice(instrumentation, 22),
      note: "Ten lines of OTLP and the dashboard sees everything",
    },
  ];
}
