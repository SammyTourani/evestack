import { agentPackFiles } from "@/lib/agent-pack";

/* /agent-pack.json — the pack as a file tree, for `npx evestack skills`.
 *
 * The CLI writes a real skill DIRECTORY (SKILL.md beside references/*.md),
 * because that structure is the mechanism rather than a convention: the
 * description routes and the references stay out of context until the model
 * asks. So it needs the files, not the pasteable concatenation at /agent.md.
 *
 * Fetching this rather than bundling a copy inside the CLI package is a
 * deliberate trade. The alternative is a second copy of the pack living under
 * packages/evestack-cli, synced by a prepack step — and a synced copy that
 * drifts is the failure this repository pays for most often. `npx evestack
 * skills` already required the network to fetch the package it is running, so
 * the requirement is not new; an offline global install gets a clear error
 * naming this URL. */
export const dynamic = "force-static";

export async function GET() {
  const files = await agentPackFiles();
  return new Response(
    JSON.stringify(
      {
        name: "evestack",
        source: "https://github.com/SammyTourani/evestack/tree/main/skills/evestack",
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
