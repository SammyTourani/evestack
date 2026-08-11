import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { siteUrl } from "@/lib/site-url";

/* /llms-full.txt — every documentation page, concatenated.

   The companion half of the llms.txt convention. /llms.txt is an INDEX: a
   summary plus links out to raw.githubusercontent.com. That is the right shape
   for an agent with a fetch tool and useless to one without — which includes
   every local model somebody runs precisely because this project is about not
   sending your data anywhere.

   This route is the other half: no fetching, no links to follow, the whole
   corpus in one response. It is large (~200 KB) and deliberately so; the pack
   at /agent.md is the small one meant for a chat window.

   Page ORDER comes from docs/meta.json rather than the filesystem, so this
   reads in the same sequence as the rendered docs instead of alphabetically —
   introduction before troubleshooting, not alerts before architecture. A page
   present on disk but absent from meta.json is still emitted, at the end,
   because silently dropping a page from the agent-readable copy is exactly the
   kind of divergence nobody notices. */
export const dynamic = "force-static";

const docsRoot = path.join(process.cwd(), "..", "..", "docs");

interface Meta {
  pages?: string[];
}

/** meta.json entries that are separators (`---Title---`) or external links. */
function isPageEntry(entry: string): boolean {
  return !entry.startsWith("---") && !entry.startsWith("external:");
}

/** Ordered slugs from a meta.json, recursing into directories that have one. */
async function orderedSlugs(dir: string, prefix = ""): Promise<string[]> {
  let meta: Meta = {};
  try {
    meta = JSON.parse(await readFile(path.join(dir, "meta.json"), "utf8")) as Meta;
  } catch {
    /* a directory without a meta.json falls through to the disk sweep below */
  }

  const out: string[] = [];
  for (const entry of (meta.pages ?? []).filter(isPageEntry)) {
    const asFile = path.join(dir, `${entry}.mdx`);
    const asDir = path.join(dir, entry);
    try {
      await readFile(asFile, "utf8");
      out.push(prefix + entry);
      continue;
    } catch {
      /* not a page — try it as a section directory */
    }
    out.push(...(await orderedSlugs(asDir, `${prefix}${entry}/`)));
  }
  return out;
}

/** Everything on disk, so a page missing from meta.json still ships. */
async function allSlugs(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (entry.isDirectory()) {
      out.push(...(await allSlugs(path.join(dir, entry.name), `${prefix}${entry.name}/`)));
    } else if (entry.name.endsWith(".mdx")) {
      out.push(prefix + entry.name.replace(/\.mdx$/, ""));
    }
  }
  return out;
}

/** Frontmatter `title`/`description` become the page's heading and standfirst. */
function readPage(source: string): { title?: string; description?: string; body: string } {
  if (!/^---\r?\n/.test(source)) return { body: source };
  const lines = source.split(/\r?\n/);
  const closing = lines.findIndex((line, i) => i > 0 && line.trimEnd() === "---");
  if (closing === -1) return { body: source };

  const front = lines.slice(1, closing);
  const scalar = (key: string) => {
    const line = front.find((l) => l.startsWith(`${key}:`));
    if (!line) return undefined;
    const value = line.slice(key.length + 1).trim();
    return value.replace(/^["'](.*)["']$/, "$1") || undefined;
  };

  return {
    title: scalar("title"),
    description: scalar("description"),
    body: lines.slice(closing + 1).join("\n").replace(/^\r?\n/, "").trimEnd(),
  };
}

export async function GET() {
  const ordered = await orderedSlugs(docsRoot);
  const everything = await allSlugs(docsRoot);
  const slugs = [...ordered, ...everything.filter((s) => !ordered.includes(s))];

  const sections = await Promise.all(
    slugs.map(async (slug) => {
      const { title, description, body } = readPage(
        await readFile(path.join(docsRoot, `${slug}.mdx`), "utf8"),
      );
      const heading = `# ${title ?? slug}`;
      const standfirst = description ? `\n> ${description}\n` : "";
      return `${heading}\n\n<!-- ${siteUrl}/docs/${slug} -->\n${standfirst}\n${body}\n`;
    }),
  );

  const header = `# evestack, complete documentation

> Every page of ${siteUrl}/docs, concatenated, in reading order.
> Generated at build time from the repository's docs/ directory.
>
> Looking for something smaller? ${siteUrl}/agent.md is a paste-sized setup pack,
> and ${siteUrl}/llms.txt is the linked index.

`;

  return new Response(header + sections.join("\n---\n\n"), {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=0, must-revalidate",
    },
  });
}
