import { buildAgentPack } from "@/lib/agent-pack";

/* /agent.md — the pack, as one pasteable document.

   Served as text/plain rather than text/markdown deliberately: the point of
   this URL is that a person can open it, select all, and paste. Browsers
   render text/markdown as a download prompt, which is the opposite of that.
   Agents that fetch it do not care either way.

   Same force-static treatment as /llms.txt: the source files are in the repo,
   so this is decided at build time and served from the edge. */
export const dynamic = "force-static";

export async function GET() {
  const body = await buildAgentPack();
  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=0, must-revalidate",
    },
  });
}
