import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * What version of the dashboard is actually running.
 *
 * ── why this exists ──────────────────────────────────────────────────────────
 *
 * The published image sat at `0.1.0` for four days while `packages/dashboard`
 * took 51 commits, and nothing anywhere could tell. `evestack verify` printed
 * `dashboard  answering at http://127.0.0.1:4000, database connected` against
 * both the current image and the four-day-old one, because /api/health said only
 * `{ ok, database }`. The Dockerfile sets OCI labels, and nothing reads them
 * back — a label is visible to `docker inspect`, not to the person running
 * `verify` and being told everything is fine.
 *
 * That is the whole blind spot in one line: every check validated the checkout,
 * and none of them asked the running artifact what it was. So the artifact says.
 *
 * Read from `package.json`, which the Dockerfile copies into the image
 * (Dockerfile:151), by the same walk-up `lib/facts.ts` uses for `sql/facts.sql`
 * — the working directory differs between `next dev`, `next start` and the
 * container, and this is the shape that already survives all three.
 *
 * Cached: the file cannot change under a running process, and /api/health is
 * called by Docker's HEALTHCHECK on an interval.
 */
let cached: string | null = null;

export function dashboardVersion(): string {
  if (cached !== null) return cached;

  let dir = process.cwd();
  for (let up = 0; up < 5; up += 1) {
    try {
      const raw = readFileSync(join(dir, "package.json"), "utf8");
      const { name, version } = JSON.parse(raw) as { name?: string; version?: string };
      // Walking up from a nested cwd can reach the monorepo root before this
      // package. Only @evestack/dashboard's own manifest answers this question;
      // anything else and we keep climbing.
      if (name === "@evestack/dashboard" && typeof version === "string") {
        cached = version;
        return cached;
      }
    } catch {
      /* not here, or not JSON — keep climbing */
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Never throw for this. A health endpoint that 500s because it could not name
  // itself is worse than one that admits it does not know, and the caller's job
  // — "is the running image the one I pinned?" — is answerable as "no idea",
  // which is still not "yes".
  cached = "unknown";
  return cached;
}
