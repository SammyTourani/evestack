import { readFile } from "node:fs/promises";
import path from "node:path";

/* llms.txt is a site-root convention — agents fetch https://<host>/llms.txt —
   but the file lives at the repo root, where it is also the copy humans read
   on GitHub. Serving it from there at build time keeps one source of truth
   instead of a public/ duplicate that silently goes stale. Same build-time
   readRepoFile idiom as lib/code-samples.ts: if the file ever moves, the build
   fails loudly rather than shipping a 404. */
export const dynamic = "force-static";

export async function GET() {
  const body = await readFile(
    path.join(process.cwd(), "..", "..", "llms.txt"),
    "utf8",
  );
  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=0, must-revalidate",
    },
  });
}
