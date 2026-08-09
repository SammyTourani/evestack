/* Captures REAL dashboard UI for the landing page — dark + light via
   prefers-color-scheme emulation, 2x. Outputs raw PNGs to
   assets/screenshots-raw/; optimize-images.mjs bakes AVIF/WebP.

   ── Three things this got wrong, all of them silently ─────────────────────

   AUTHENTICATION. This script predates lib/auth.ts. Every route except the
   liveness one now redirects an unauthenticated GET to /signin, so a run
   without credentials captures the sign-in form, at 1440x900, twice, and
   reports "captured dark / captured light / done". Playwright's
   `httpCredentials` sends the same HTTP Basic pair `curl -u` uses, which is
   the path lib/auth.ts documents for scripts.

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

const credentials = { username, password };

/** Which session to open for the detail shot: the one with the most turns, so
 *  the run tree in the picture is actually a tree. */
async function pickSession() {
  const response = await fetch(`${dashboardUrl}/api/health`, {
    headers: { authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` },
  });
  const health = await response.json();
  return health.recentSessions?.[0]?.id ?? null;
}

const sessionId = await pickSession();
console.log("session for detail capture:", sessionId ?? "(none found)");
if (!sessionId) {
  console.error("no session in /api/health — seed the database before capturing");
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
    httpCredentials: credentials,
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
