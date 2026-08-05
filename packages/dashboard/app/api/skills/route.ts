import { scanSkill, verdictSummary, SCANNER_LIMITS, type ScanResult } from "@/lib/skill-scan";
import { listSkills, readFixtureSkill, SKILLS_DIR_ENV, type Skill } from "@/lib/skills";
import { handleRouteError, jsonError, jsonOk } from "../control/_http";

export const dynamic = "force-dynamic";

/** The fixture the canary scans. See fixtures/README.md. */
const CANARY_SKILL = "malicious-fixture";

/**
 * The list view drops the markdown body and the file contents. A JSON blob of
 * every skill's full text is a different resource with different costs, and
 * `/api/skills/:name` is where to get it.
 */
function summarize(skill: Skill, scan: ScanResult): Record<string, unknown> {
  return {
    name: skill.name,
    kind: skill.kind,
    description: skill.description,
    descriptionSource: skill.descriptionSource,
    ...(skill.license ? { license: skill.license } : {}),
    ...(skill.metadata ? { metadata: skill.metadata } : {}),
    entryPath: skill.entryPath,
    files: skill.files.map((file) => ({ path: file.path, kind: file.kind, bytes: file.bytes })),
    totalBytes: skill.totalBytes,
    modifiedAt: skill.modifiedAt,
    ignoredFrontmatterKeys: skill.ignoredFrontmatterKeys,
    problems: skill.problems,
    scan: { ...scan, summary: verdictSummary(scan) },
  };
}

/**
 * GET /api/skills — what the agent can load, and what the firewall makes of it.
 *
 * The /skills page reads the same functions server-side and does not need this.
 * The route exists so the verdicts are consumable by something other than a
 * human with a browser: @evestack/mcp turns it into a tool, and CI can fail a
 * build on `.summary.critical > 0` without importing any of this package.
 *
 * `?selftest=1` answers with the canary instead: the bundled malicious fixture,
 * scanned. A scanner that has quietly stopped matching anything reports every
 * skill clean, which looks exactly like good news — the canary is how you tell
 * the two apart. Its verdict must be "critical"; anything else is a broken
 * firewall, and the response says so in `armed`.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);

    if (url.searchParams.get("selftest") !== null) {
      const fixture = await readFixtureSkill(CANARY_SKILL);
      if (!fixture) {
        // The production image copies only .next, public and the manifest, so
        // the fixture genuinely is not there. Say that rather than pass.
        return jsonOk({
          armed: null,
          canary: null,
          reason:
            `The ${CANARY_SKILL} fixture is not present in this deployment, so the firewall cannot be self-tested here. ` +
            "It ships in the source tree under packages/dashboard/fixtures, not in the runtime image.",
        });
      }
      const scan = scanSkill(fixture);
      return jsonOk({
        armed: scan.verdict === "critical",
        canary: { ...scan, summary: verdictSummary(scan) },
        expectation: "verdict must be 'critical'; anything else means the scanner has stopped detecting things it used to.",
      });
    }

    const { directory, skills } = await listSkills();
    const scanned = skills.map((skill) => ({ skill, scan: scanSkill(skill) }));

    return jsonOk({
      directory: { ...directory, envVar: SKILLS_DIR_ENV },
      count: skills.length,
      summary: {
        critical: scanned.filter((entry) => entry.scan.verdict === "critical").length,
        warning: scanned.filter((entry) => entry.scan.verdict === "warning").length,
        clean: scanned.filter((entry) => entry.scan.verdict === "clean").length,
      },
      // Shipped with the data on purpose: a verdict quoted without its limits
      // is how a smoke alarm gets read as a safety certificate.
      scannerLimits: SCANNER_LIMITS,
      skills: scanned.map((entry) => summarize(entry.skill, entry.scan)),
    });
  } catch (error) {
    if (error instanceof Error && !request.signal.aborted) {
      return jsonError(`Could not read the skills directory: ${error.message}`, 500, "internal_error");
    }
    return handleRouteError(error, request);
  }
}
