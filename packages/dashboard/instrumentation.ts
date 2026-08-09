/**
 * Server startup. The one place in the dashboard that runs without a request.
 *
 * `register` is called once per Next.js server instance and must finish before
 * the server accepts traffic (node_modules/next/dist/docs/01-app/03-api-reference/
 * 03-file-conventions/instrumentation.md). That makes it the right home for the
 * alert delivery loop and the wrong home for anything slow: everything below
 * either returns immediately or is deliberately not awaited.
 *
 * ── Two guards, and neither is optional ──────────────────────────────────────
 *
 * NEXT_RUNTIME. Next calls `register` in every runtime it builds for. The
 * delivery loop needs `pg`, a Docker socket and `setInterval` with `unref`, none
 * of which exist on the edge runtime, so the import is conditional rather than
 * top-level — an unconditional import would be bundled for edge and fail at
 * build time, not at run time.
 *
 * NEXT_PHASE. `next build` sets NEXT_PHASE=phase-production-build
 * (node_modules/next/dist/build/index.js:1212) and spawns static-generation
 * workers that inherit it. Every one of those workers runs `register`. Without
 * this guard a production build with EVESTACK_ALERT_WEBHOOK_URL set would start
 * one delivery loop per worker, evaluate the monitors against whatever database
 * the build machine can see, and post real alerts from a build — the classic
 * shape of "our CI paged the on-call".
 */

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  const { startAlertDelivery } = await import("./lib/alert-delivery");
  const { started, reason } = startAlertDelivery();

  // Say so either way, once, at boot.
  //
  // The silent case is the one that matters: a dashboard that computes nine
  // monitors and delivers none of them looks identical, in every log and on
  // every page, to one that is delivering them fine. This line and the panel on
  // /monitors are the two places that difference is visible.
  console.log(
    started
      ? `[evestack:alerts] delivering transitions — ${reason}`
      : `[evestack:alerts] not delivering — ${reason}`,
  );
}
