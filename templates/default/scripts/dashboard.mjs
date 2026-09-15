/**
 * `npm run dashboard` — the control plane, in your browser, signed in.
 *
 * WHY THIS IS A SCRIPT AND NOT `npx evestack dashboard`. The two do the same
 * thing, and the CLI is the better answer from a cold terminal. This exists for
 * the other case: someone already inside the project, reading package.json,
 * about to type `npm run dev`. The dashboard is the thing that makes the rest of
 * the stack legible, and a project whose scripts list `dev`, `build`, `start`,
 * `verify` and nothing that shows you the dashboard is a project that hides its
 * best part behind a command you have to have read the README to know.
 *
 * It is also the offline answer. `npx evestack` fetches a package; this is a
 * file that is already on disk, so it works on a plane and in a locked-down
 * network, and it runs the version that shipped with this project rather than
 * whatever npm serves today.
 *
 * Reuses `dashboardTarget` from scripts/checks.mjs rather than re-deriving the
 * URL: the port is chosen per project by the scaffolder, and a second copy of
 * that logic is a second thing to get wrong. That function already handles the
 * `localhost:4000/...` typo which `URL.parse` accepts as a scheme.
 */
import { spawn } from "node:child_process";
import process from "node:process";

import { dashboardTarget } from "./checks.mjs";
import { blank, c, g, headingLine, fixLine, say } from "./ui.mjs";

const HEALTH_TIMEOUT_MS = 2500;

/** Open a URL with the platform's own handler; never fail the command over it. */
function launchBrowser(url) {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    spawn(command, args, { stdio: "ignore", detached: true }).unref();
    return true;
  } catch {
    return false;
  }
}

async function healthy(url) {
  try {
    const response = await fetch(new URL("/api/health", url), {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

const noOpen = process.argv.slice(2).includes("--no-open");
const { url } = dashboardTarget(process.env.EVESTACK_DASHBOARD_URL);
const user = process.env.EVESTACK_AUTH_USER?.trim() || "evestack";
const password = process.env.EVESTACK_AUTH_PASSWORD;
const up = await healthy(url);

blank();
say(headingLine("dashboard", up ? "" : "not running yet"));
blank();
say(`      ${c.brandBold(url)}`);
if (password) {
  say(`      ${c.dim("sign in")}  ${c.bold(user)} ${c.dim("/")} ${c.bold(password)}`);
} else {
  // Same posture the dashboard itself takes: with no password configured every
  // route answers 503 and /signin renders no form, so "it is running" would be
  // a misleading thing to print on its own.
  say(`      ${c.yellow("EVESTACK_AUTH_PASSWORD is not set")}${c.dim(", so the dashboard 503s")}`);
}
blank();

if (!up) {
  say(`  ${c.dim(`${g.arrow} `)}${c.bold("docker compose --profile dashboard up -d")}`);
  blank();
  say(`  ${c.dim("Then run this again. `npm run verify` says what else is down.")}`);
  blank();
  process.exit(1);
}

if (noOpen) {
  say(`  ${c.dim("Not opening a browser: --no-open.")}`);
  blank();
} else if (launchBrowser(url)) {
  say(`  ${c.dim("Opened in your browser.")}`);
  blank();
} else {
  say(`  ${c.dim("Could not launch a browser — open the URL above yourself.")}`);
  blank();
}
