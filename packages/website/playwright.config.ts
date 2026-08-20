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
  /* Retries in CI only, and this is a MITIGATION rather than a fix — recorded as
   * such so nobody later reads a green board as evidence the problem was solved.
   *
   * `agent-pack.spec.ts` "its menu opens upward" failed 5 of the 12 CI runs after
   * it was introduced — 42%, on its very first run, and on pull requests touching
   * nothing in this package, so it blocked unrelated work. The menu simply never
   * opens: data-open is still absent after the assertion polls for the full 2s.
   *
   * What has been ruled out, by evidence rather than argument: the pointer being
   * parked on the control already (a fix for that landed and the test failed
   * twice more with it in place); suppressRef, which only Escape or click-outside
   * sets and that test does neither; canHover, which would break the sibling test
   * that performs the identical hover and has never failed. The data-drop="down"
   * in the failure is the untouched initial value of the component's `dropUp`,
   * recomputed only in a layout effect gated on `open` — it means never-measured,
   * not measured-and-wrong, so it is not evidence of a real flip bug.
   *
   * The cause is genuinely not known. Retrying is the honest response to that:
   * it keeps an unrelated PR from going red 2 runs in 5 while explicitly not
   * claiming the underlying non-determinism is gone. A test that needs a retry to
   * be green is still a defect; this is a note that one is outstanding.
   *
   * Zero locally, so the flake stays visible to whoever is actually working on it.
   */
  retries: process.env.CI ? 2 : 0,
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
