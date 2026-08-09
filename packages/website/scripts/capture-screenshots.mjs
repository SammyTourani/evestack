/* Captures REAL dashboard UI for the landing page — dark + light via
   prefers-color-scheme emulation, 2x. Outputs raw PNGs to
   assets/screenshots-raw/; optimize-images.mjs bakes AVIF/WebP.

   ── Three things this got wrong, all of them silently ─────────────────────

   AUTHENTICATION. This script predates lib/auth.ts. Every route except the
   liveness one now redirects an unauthenticated GET to /signin, so a run
   without credentials captures the sign-in form, at 1440x900, twice, and
   reports "captured dark / captured light / done". The HTTP Basic pair now goes
   on every request as a header — see the note on `authHeader` for why
   Playwright's own `httpCredentials` cannot work against this dashboard.

   THE PAGE IT CAPTURED. It screenshotted `/` and wrote it to `sessions-*.png`.
   That was right when `/` WAS the session list. Dashboard v2 made `/` an
   overview of charts and monitors and moved the list to `/sessions`, and
   packages/website/lib/copy.ts now names `app/sessions/page.tsx` as the file
   that renders this shot — so the caption, the alt text and the source path all
   described a page the image did not show. Fixing the path in copy.ts without
   fixing this file would have left the claim pointing at the wrong picture.

   NETWORKIDLE. `waitUntil: "networkidle"` returns when the network is quiet,
   which on the overview is BEFORE the streamed Suspense boundaries have
   resolved — the fleet banner talks to the agent and the alerts panel to the
   Docker socket. The captures below wait for a selector that only exists once
   the content is really there.

   Run against a seeded dashboard:

     DASHBOARD_URL=http://localhost:4000 \
     EVESTACK_AUTH_USER=... EVESTACK_AUTH_PASSWORD=... \
     node scripts/capture-screenshots.mjs
*/
import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const outDir = new URL("../assets/screenshots-raw/", import.meta.url).pathname;
await mkdir(outDir, { recursive: true });

const dashboardUrl = (process.env.DASHBOARD_URL ?? "http://localhost:4000").replace(/\/$/, "");
const username = process.env.EVESTACK_AUTH_USER;
const password = process.env.EVESTACK_AUTH_PASSWORD;

if (!username || !password) {
  // Loud, not a warning. The failure this prevents is a successful-looking run
  // that produces four screenshots of a login form.
  console.error(
    "EVESTACK_AUTH_USER and EVESTACK_AUTH_PASSWORD must be set — every dashboard route " +
      "except /api/health redirects an unauthenticated GET to /signin, so without them this " +
      "script captures the sign-in page and reports success.",
  );
  process.exit(1);
}

/**
 * The credential goes on EVERY request as a header, not through Playwright's
 * `httpCredentials`.
 *
 * `httpCredentials` implements the browser side of HTTP Basic: it waits for a
 * 401 carrying `WWW-Authenticate` and only then retries with the header. The
 * dashboard never sends that challenge — proxy.ts omits it deliberately, because
 * it would make the browser raise its own credential dialog on every background
 * fetch from the chat page — and for an HTML navigation it answers 303 to
 * /signin rather than 401 at all. So there is no challenge to respond to:
 * `httpCredentials` sends nothing, the capture follows the redirect, and the
 * screenshot is of the sign-in form.
 *
 * Setting the header outright is what `curl -u` does, which lib/auth.ts names as
 * the supported path for scripts.
 */
const authHeader = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;

/**
 * Which session to open for the detail shot: the one with the most turns, so
 * the run tree in the picture is actually a tree.
 *
 * `/api/health/detail`, not `/api/health`. The liveness route is the one Docker's
 * HEALTHCHECK hits and it deliberately answers `{ok, database}` and nothing
 * else — this script used to read `recentSessions` off it, which has been
 * `undefined` since that route was narrowed, so `sessionId` was null and the
 * detail capture was skipped entirely without the script noticing.
 */
async function pickSession() {
  const response = await fetch(`${dashboardUrl}/api/health/detail`, {
    headers: { authorization: authHeader },
  });
  const health = await response.json();
  const sessions = health.recentSessions ?? [];
  if (sessions.length === 0) return null;
  // Most turns wins. A one-turn session renders a run tree with a single row,
  // which is a picture of the feature not working.
  return [...sessions].sort((a, b) => (b.turns ?? 0) - (a.turns ?? 0))[0].id;
}

const sessionId = await pickSession();
console.log("session for detail capture:", sessionId ?? "(none found)");
if (!sessionId) {
  console.error("no session in /api/health/detail — seed the database before capturing");
  process.exit(1);
}

const browser = await chromium.launch();

const shots = [
  // The session LIST, which is what copy.ts's `sessions` shot claims to show.
  { name: "sessions", path: "/sessions", ready: "table" },
  { name: "session-detail", path: `/sessions/${sessionId}`, ready: "h1" },
];

for (const scheme of ["dark", "light"]) {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: scheme,
    extraHTTPHeaders: { authorization: authHeader },
  });

  for (const shot of shots) {
    await page.goto(`${dashboardUrl}${shot.path}`, { waitUntil: "networkidle" });

    // The real readiness signal. If the page redirected to /signin this throws
    // rather than producing a screenshot of the login form.
    await page.waitForSelector(shot.ready, { timeout: 15_000 });
    if (new URL(page.url()).pathname === "/signin") {
      throw new Error(`captured /signin instead of ${shot.path} — credentials were refused`);
    }

    // Suspense boundaries stream in after networkidle; this is the settle.
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${outDir}/${shot.name}-${scheme}.png` });
    console.log(`captured ${shot.name}-${scheme} from ${shot.path}`);
  }

  await page.close();
}

await browser.close();
console.log("done");
