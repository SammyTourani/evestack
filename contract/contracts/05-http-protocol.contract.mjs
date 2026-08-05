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
    t.equal(
      routes.EVE_CREATE_SESSION_ROUTE_PATH,
      "/eve/v1/session",
      "session creation is still POST /eve/v1/session",
    );
    t.equal(
      routes.EVE_CONTINUE_SESSION_ROUTE_PATTERN,
      "/eve/v1/session/:sessionId",
      "follow-up messages and HITL answers still go to POST /eve/v1/session/:sessionId",
    );
    t.equal(
      routes.EVE_CANCEL_TURN_ROUTE_PATTERN,
      "/eve/v1/session/:sessionId/cancel",
      "cancellation is still POST /eve/v1/session/:sessionId/cancel",
    );
    t.equal(
      routes.EVE_MESSAGE_STREAM_ROUTE_PATTERN,
      "/eve/v1/session/:sessionId/stream",
      "the durable event stream is still GET /eve/v1/session/:sessionId/stream",
    );

    // The dashboard builds these paths itself; eve's builders are the reference.
    t.equal(
      routes.createEveCancelTurnRoutePath("s_1"),
      "/eve/v1/session/s_1/cancel",
      "eve's own cancel path builder agrees with the pattern the dashboard interpolates",
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
