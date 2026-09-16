import { agentPackFiles } from "@/lib/agent-pack";

/* The deployed website's pack as a file tree. CLI releases bundle their matching
   setup files by default; this endpoint remains available for explicit custom
   pack URLs and programmatic consumers of the website version. */
export const dynamic = "force-static";

export async function GET() {
  const files = await agentPackFiles();
  return new Response(
    JSON.stringify(
      {
        name: "evestack",
        source:
          "https://github.com/SammyTourani/evestack/tree/main/skills/evestack",
        files,
      },
      null,
      2,
    ),
    {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "public, max-age=0, must-revalidate",
      },
    },
  );
}
