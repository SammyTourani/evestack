/**
 * The HTTP wire contract between packages/dashboard and a running agent.
 *
 * The dashboard reads state straight from Postgres but writes through eve's
 * HTTP routes, and those route strings, headers and status literals were read
 * out of eve's compiled protocol modules rather than guessed. Nothing in this
 * repo typechecks a URL template. If eve renames a route, the dashboard
 * compiles, deploys, and 404s at the user.
 */

export default {
  id: "protocol/http-surface-the-dashboard-drives",
  title: "eve's session routes, stream headers and cancel statuses are unchanged",
  assumption:
    "eve serves POST /eve/v1/session, POST /eve/v1/session/:sessionId(/cancel), GET .../stream as NDJSON, " +
    'and cancellation answers with status "accepted" or "no_active_turn".',
  evestackUse:
    "packages/dashboard/lib/agent-client.ts is the dashboard's entire write path: creating sessions, " +
    "sending follow-up messages, delivering human approve/deny answers as `inputResponses`, cancelling a " +
    "turn, and tailing the durable event stream. Those routes and header names are string literals in that " +
    "file. Nothing typechecks them against eve, so a rename ships green and fails as a 404 in the browser — " +
    "and the two stream headers are how the client resumes a stream after a reconnect, so losing them turns " +
    "into silently duplicated or dropped events rather than an error.",

  async check(eve, t) {
    const routes = await eve.loadInternal("dist/src/protocol/routes.js");

    t.equal(routes.EVE_ROUTE_PREFIX, "/eve/v1", "the route prefix is still /eve/v1");

    /*
     * BY VALUE, NOT BY CONSTANT NAME — and the difference is the whole point of
     * this contract.
     *
     * These were `routes.EVE_CREATE_SESSION_ROUTE_PATH === "/eve/v1/session"`
     * and three more like it. eve 0.31.3 renamed every one of those constants
     * without touching a single route:
     *
     *   EVE_CREATE_SESSION_ROUTE_PATH      -> EVE_SESSION_ROUTE_PATH
     *   EVE_CONTINUE_SESSION_ROUTE_PATTERN -> EVE_SESSION_ROUTE_PATTERN
     *   EVE_CANCEL_TURN_ROUTE_PATTERN      -> EVE_SESSION_CANCEL_ROUTE_PATTERN
     *   EVE_MESSAGE_STREAM_ROUTE_PATTERN   -> EVE_SESSION_STREAM_ROUTE_PATTERN
     *   createEveCancelTurnRoutePath       -> createEveSessionCancelRoutePath
     *
     * so eve-watch opened a PR headed "CONTRACTS BROKEN" with five assertions
     * failing `actual: undefined`, about an HTTP surface that had not moved. The
     * dashboard and the CLI hardcode the PATH STRINGS — checked, all five are
     * byte-identical in 0.31.3 — so nothing was broken except the detector.
     *
     * A false alarm from a watcher is not a harmless false alarm. This one says
     * "the protocol the dashboard drives has changed", which is the loudest
     * signal this repository has, and spending it on a rename is how the next
     * real one gets waved through.
     *
     * So the assertion is now what the file's own header always claimed to be
     * checking: "if eve renames a ROUTE, the dashboard 404s at the user". Some
     * exported constant must carry each path. Which one is eve's business.
     */
    const byValue = new Map(
      Object.entries(routes)
        .filter(([, value]) => typeof value === "string")
        .map(([name, value]) => [value, name]),
    );

    for (const [path, what] of [
      ["/eve/v1/session", "session creation is still POST /eve/v1/session"],
      [
        "/eve/v1/session/:sessionId",
        "follow-up messages and HITL answers still go to POST /eve/v1/session/:sessionId",
      ],
      ["/eve/v1/session/:sessionId/cancel", "cancellation is still POST /eve/v1/session/:sessionId/cancel"],
      [
        "/eve/v1/session/:sessionId/stream",
        "the durable event stream is still GET /eve/v1/session/:sessionId/stream",
      ],
    ]) {
      t.ok(byValue.has(path), what, {
        ...(byValue.has(path)
          ? { actual: `exported as ${byValue.get(path)}` }
          : {
              expected: `some exported constant equal to ${JSON.stringify(path)}`,
              actual:
                "no export carries that path — this is a real route change, not a rename, and " +
                "lib/agent-client.ts will 404 at the user",
            }),
      });
    }

    // ANTI-VACUITY: an empty or string-less module would satisfy nothing above
    // by having no values to match, and `byValue.has` would simply be false —
    // which reads as four route changes rather than as a module that failed to
    // load. This says which it is.
    t.ok(
      byValue.size >= 10,
      `protocol/routes.js exports ${byValue.size} string route constants`,
      {
        expected: ">= 10 — eve declares well over a dozen",
        actual: `${byValue.size}; the module did not load as expected and the checks above are looking at nothing`,
      },
    );

    // The dashboard builds these paths itself; eve's builders are the reference.
    // Found by behaviour rather than by name, for the same reason as above: the
    // builder was `createEveCancelTurnRoutePath` in 0.30.8 and
    // `createEveSessionCancelRoutePath` in 0.31.3, and it builds the same path.
    const builders = Object.entries(routes).filter(([, v]) => typeof v === "function");
    const cancelBuilder = builders.find(([, build]) => {
      try {
        return build("s_1") === "/eve/v1/session/s_1/cancel";
      } catch {
        return false;
      }
    });
    t.ok(
      cancelBuilder !== undefined,
      "eve still exports a builder that agrees with the cancel path the dashboard interpolates",
      {
        ...(cancelBuilder
          ? { actual: `${cancelBuilder[0]}("s_1")` }
          : {
              expected: '/eve/v1/session/s_1/cancel from one of eve\'s own path builders',
              actual: `none of the ${builders.length} exported functions produced it`,
            }),
      },
    );

    const message = await eve.loadInternal("dist/src/protocol/message.js");
    t.equal(
      message.EVE_MESSAGE_STREAM_CONTENT_TYPE,
      "application/x-ndjson; charset=utf-8",
      "the event stream is still newline-delimited JSON, not text/event-stream",
    );
    t.equal(message.EVE_SESSION_ID_HEADER, "x-eve-session-id", "the session id header is still x-eve-session-id");
    t.equal(
      message.EVE_STREAM_TAIL_INDEX_HEADER,
      "x-eve-stream-tail-index",
      "the stream resume cursor header is still x-eve-stream-tail-index",
    );

    // Cancellation is cooperative: 202 with a status telling you whether there
    // was anything to cancel. The dashboard renders both outcomes differently.
    const cancelTypes = eve.readFile("dist/src/protocol/cancel-turn.d.ts");
    t.contains(cancelTypes, '"accepted"', "CancelTurnStatus still includes `accepted`");
    t.contains(cancelTypes, '"no_active_turn"', "CancelTurnStatus still includes `no_active_turn`");

    // There is no approve/deny route — approvals ride the follow-up route.
    // agent-client.ts documents this; if eve ever adds a dedicated route the
    // comment is wrong and the workaround should be revisited.
    const patterns = Object.entries(routes)
      .filter(([, value]) => typeof value === "string" && value.startsWith("/eve/v1"))
      .map(([, value]) => value);
    t.ok(
      !patterns.some((p) => /approv/i.test(p)),
      "eve still has no dedicated approval route — HITL answers ride POST /eve/v1/session/:sessionId",
      patterns.some((p) => /approv/i.test(p))
        ? { actual: patterns.filter((p) => /approv/i.test(p)).join(", "), expected: "no approval route" }
        : {},
    );
  },
};
