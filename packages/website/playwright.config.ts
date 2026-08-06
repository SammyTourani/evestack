import { defineConfig } from "@playwright/test";

/* Two things here exist because of a real incident, not a preference.
 *
 * `webServer` at all: this suite used to require that someone had already
 * started a server, so `pnpm test` was unrunnable from a clean checkout — which
 * is why the root `test` script was never wired into CI and this whole suite had
 * never run there. Playwright now starts and stops its own server, so the suite
 * is self-contained wherever it runs.
 *
 * `reuseExistingServer: false`, always: a leftover `next-server` sat on :3000
 * and silently served a day-old build to every run for an hour, turning the
 * suite into a check that passed against code nobody had written that day. The
 * default reuses whatever is listening, which is exactly that failure. Starting
 * a fresh server every time costs a build and removes an entire class of
 * false green.
 *
 * BASE_URL still wins, for pointing the suite at a deployed preview.
 */
const external = process.env.BASE_URL;

export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  // The webServer build below can exceed the per-test timeout on a cold runner.
  globalTimeout: 10 * 60_000,
  ...(external
    ? {}
    : {
        webServer: {
          // Build then serve, rather than assuming a build exists: a stale or
          // absent .next means the suite tests whatever was compiled last, not
          // what is in the tree.
          command: "pnpm build && pnpm preview",
          url: "http://localhost:3000",
          reuseExistingServer: false,
          timeout: 300_000,
          stdout: "pipe",
          stderr: "pipe",
        },
      }),
  use: {
    baseURL: external ?? "http://localhost:3000",
    viewport: { width: 1440, height: 900 },
    colorScheme: "dark",
    launchOptions: {
      args: ["--enable-gpu", "--use-angle=metal", "--ignore-gpu-blocklist"],
    },
  },
});
