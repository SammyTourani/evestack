import { scanSkill, verdictSummary, SCANNER_LIMITS } from "@/lib/skill-scan";
import { getSkill, SKILLS_DIR_ENV } from "@/lib/skills";
import { handleRouteError, jsonError, jsonOk } from "../../control/_http";

export const dynamic = "force-dynamic";

/**
 * GET /api/skills/:name — one skill, including the markdown the model would be
 * handed, plus the scan.
 *
 * The name is the id `load_skill` takes. `getSkill` resolves it by listing the
 * directory and matching, never by joining the string onto a path, so a name
 * like `../../etc` finds nothing instead of finding something.
 *
 * The body is included because reading it is the only thing that actually
 * clears a skill. Everything else on this page narrows down what to read.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ name: string }> },
): Promise<Response> {
  try {
    const { name } = await context.params;
    const skill = await getSkill(decodeURIComponent(name));
    if (!skill) {
      return jsonError(
        `No skill "${name}" in the configured skills directory. Set ${SKILLS_DIR_ENV} if the dashboard is looking in the wrong place.`,
        404,
        "not_found",
      );
    }

    const scan = scanSkill(skill);
    return jsonOk({
      skill: {
        ...skill,
        // File bodies are dropped: they are already scanned, some are large,
        // and a route that returns arbitrary file contents from disk is a
        // different and more dangerous thing than one that returns a skill.
        files: skill.files.map((file) => ({
          path: file.path,
          kind: file.kind,
          bytes: file.bytes,
          ...(file.linkTarget ? { linkTarget: file.linkTarget } : {}),
        })),
      },
      scan: { ...scan, summary: verdictSummary(scan) },
      scannerLimits: SCANNER_LIMITS,
    });
  } catch (error) {
    return handleRouteError(error, request);
  }
}
