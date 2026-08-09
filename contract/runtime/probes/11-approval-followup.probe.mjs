/**
 * An approval decision travelling eve's real follow-up route.
 *
 * eve has no approve/deny endpoint. It has one pause-and-resume protocol shared
 * by tool approvals, `ask_question` and session limits: the turn parks at
 * `session.waiting`, publishes its outstanding requests in `input.requested`,
 * and resumes when the follow-up route receives
 * `inputResponses: [{requestId, optionId?, text?}]`. `/approve` is a projection
 * of that, and until now nothing had run it against a live agent.
 *
 * ── What this probe can and cannot reach ─────────────────────────────────────
 *
 * A pending approval requires a model to call a gated tool, and CI runs without
 * a provider key on purpose. So the HAPPY PATH — approve a real parked tool call
 * and watch the turn resume — is NOT tested here and is not claimed to be. It
 * belongs to `eve eval`, which is gated on a key.
 *
 * What IS reachable is the half that has actually gone wrong in this codebase,
 * and it is the more dangerous half. Every assertion below is a REFUSAL: a
 * request that must not be absorbed. An approve endpoint whose failure mode is
 * "200, and nothing happened" is worse than one that is missing, because the
 * operator believes a gated shell command was authorised by a person when the
 * audit row was never written — and the route's own header records that
 * `GET` used to answer `ok: true` for a session id that does not exist while
 * `message` returned 404 for the same id.
 *
 * The refusals are also the only part that a caller can reach without a model,
 * which means they are exactly what an attacker or a buggy UI reaches first.
 */

const DASHBOARD = process.env.EVESTACK_PROBE_DASHBOARD_URL?.replace(/\/$/, "") ?? null;
const USER = process.env.EVESTACK_PROBE_DASHBOARD_USER ?? null;
const PASSWORD = process.env.EVESTACK_PROBE_DASHBOARD_PASSWORD ?? null;

async function call(path, init = {}) {
  return fetch(`${DASHBOARD}${path}`, {
    ...init,
    headers: {
      authorization: `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString("base64")}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

const json = async (response) => {
  try {
    return await response.json();
  } catch {
    return {};
  }
};

/** eve indexes a session's stream the moment it starts; a brand new id can be
 *  asked about before its first event lands, which is a 404 this probe would
 *  otherwise read as a bug. */
async function waitForSession(id, budgetMs = 10_000) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const response = await call(`/api/control/sessions/${encodeURIComponent(id)}/approve`);
    if (response.ok) return await json(response);
    if (Date.now() > deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

export default {
  id: "seam/approval-decisions-are-refused-not-absorbed",
  title: "an approval for nothing pending is refused by the live agent's follow-up route",
  needs: ["dashboard", "agent"],
  why:
    "This route resumes a parked turn that may be holding a gated shell command. Its dangerous " +
    "failure is not an error — it is a 200 for a decision that did nothing, because the operator " +
    "then believes a human authorised something no audit row records. eve answers an unknown " +
    "session with an empty stream rather than a 404, so every 'does this session exist' check " +
    "here is a judgement the dashboard makes on eve's behalf, and this route already shipped one " +
    "of them wrong. None of it is reachable without a live agent: the snapshot these refusals " +
    "turn on is fetched from eve on every request.",

  async available() {
    const missing = [];
    if (!DASHBOARD) missing.push("EVESTACK_PROBE_DASHBOARD_URL is not set");
    if (!USER || !PASSWORD) missing.push("EVESTACK_PROBE_DASHBOARD_{USER,PASSWORD} are not set");
    if (missing.length > 0) return missing;
    try {
      const response = await fetch(`${DASHBOARD}/api/health`, { signal: AbortSignal.timeout(5_000) });
      return response.ok ? [] : [`dashboard health answered ${response.status}`];
    } catch (error) {
      return [`cannot reach the dashboard: ${error.message}`];
    }
  },

  async run(t) {
    /* ── an id the agent has never seen ────────────────────────────────────── */

    const ghost = "wrun_probe_approval_no_such_session";

    const readGhost = await call(`/api/control/sessions/${ghost}/approve`);
    t.ok(
      readGhost.status === 404,
      "reading the approval state of a session that does not exist is a 404, not an ok:true with an empty list",
      readGhost.status === 404
        ? {}
        : {
            expected: 404,
            actual: `${readGhost.status} — eve returns an empty stream for an unknown id, and reporting that as a healthy session with nothing pending is how a UI ends up unable to tell a typo from a quiet turn`,
          },
    );

    const decideGhost = await call(`/api/control/sessions/${ghost}/approve`, {
      method: "POST",
      body: JSON.stringify({ decision: "approve" }),
    });
    t.ok(
      decideGhost.status === 404,
      "and approving one is refused rather than accepted into the void",
      decideGhost.status === 404
        ? {}
        : { expected: 404, actual: `${decideGhost.status} ${JSON.stringify(await json(decideGhost)).slice(0, 160)}` },
    );

    /* ── a real session, with nothing pending ──────────────────────────────── */

    const created = await call("/api/control/sessions", {
      method: "POST",
      body: JSON.stringify({ message: "probe: approval refusal path, no model call expected" }),
    });
    const body = await json(created);

    t.ok(
      created.status === 202 && typeof body.sessionId === "string",
      "a real durable session is created on the live agent to refuse against",
      created.status === 202 && typeof body.sessionId === "string"
        ? {}
        : { expected: "202 with a sessionId", actual: `${created.status} ${JSON.stringify(body).slice(0, 200)}` },
    );

    if (typeof body.sessionId !== "string") {
      t.ok(false, "no session was created, so the refusals below were not exercised", {
        expected: "a session to approve against",
        actual: "none — every remaining assertion in this probe would pass by not running",
      });
      return;
    }

    const id = body.sessionId;
    const snapshot = await waitForSession(id);

    // ANTI-VACUITY. Every refusal below is about a REAL session that exists and
    // has nothing pending. If the snapshot never arrived, the assertions would
    // be re-testing the unknown-session 404 above under a different name.
    t.ok(
      snapshot !== null,
      "the live agent published a snapshot for the new session, so what follows is about a session that really exists",
      snapshot !== null
        ? {}
        : {
            expected: "an approval snapshot within 10s",
            actual: "none — without it the refusals below would be indistinguishable from the unknown-session case already asserted",
          },
    );

    if (snapshot === null) return;

    t.note(
      `snapshot: waiting=${snapshot.waiting} terminal=${snapshot.terminal} pending=${snapshot.pendingRequests?.length ?? 0} tailIndex=${snapshot.tailIndex}`,
    );

    t.ok(
      Array.isArray(snapshot.pendingRequests),
      "the snapshot names its outstanding requests as a list, which is what the UI renders",
      Array.isArray(snapshot.pendingRequests)
        ? {}
        : { expected: "pendingRequests to be an array", actual: typeof snapshot.pendingRequests },
    );

    t.ok(
      typeof snapshot.tailIndex === "number" && snapshot.tailIndex >= 0,
      "and a tail index at or above zero, which is how this route knows the session is real",
      typeof snapshot.tailIndex === "number" && snapshot.tailIndex >= 0
        ? {}
        : { expected: ">= 0", actual: String(snapshot.tailIndex) },
    );

    // Without a model key the turn cannot park on an approval, so pending is
    // expected to be empty. Said out loud rather than assumed: if a future CI
    // gains a key, this probe's refusals stop being about "nothing pending" and
    // the note is what makes that visible in the log.
    const nothingPending = (snapshot.pendingRequests?.length ?? 0) === 0;
    t.note(
      nothingPending
        ? "nothing is pending, as expected with no provider key — the refusals below are the no_pending_input path"
        : "something IS pending, so this run exercised a different branch than usual",
    );

    /* ── the refusals that matter ──────────────────────────────────────────── */

    if (nothingPending) {
      const decided = await call(`/api/control/sessions/${encodeURIComponent(id)}/approve`, {
        method: "POST",
        body: JSON.stringify({ decision: "approve" }),
      });
      const decidedBody = await json(decided);
      const refused = decided.status === 409 || decided.status === 404;
      t.ok(
        refused && decidedBody.ok !== true,
        "approving a session that is not waiting on anyone is refused, never answered ok",
        refused && decidedBody.ok !== true
          ? {}
          : {
              expected: "409 no_pending_input (or 404 if the session already ended)",
              actual: `${decided.status} ${JSON.stringify(decidedBody).slice(0, 200)} — a 200 here means an operator can believe a gated tool call was authorised when no audit row was ever written`,
            },
      );
      t.note(`refusal code: ${decidedBody.code ?? "(none)"}`);

      const named = await call(`/api/control/sessions/${encodeURIComponent(id)}/approve`, {
        method: "POST",
        body: JSON.stringify({ decision: "deny", requestId: "req_probe_not_a_real_request" }),
      });
      const namedBody = await json(named);
      t.ok(
        (named.status === 409 || named.status === 404) && namedBody.ok !== true,
        "and naming a requestId that is not outstanding is refused rather than matched loosely",
        (named.status === 409 || named.status === 404) && namedBody.ok !== true
          ? {}
          : {
              expected: "409 unknown_request / no_pending_input",
              actual: `${named.status} ${JSON.stringify(namedBody).slice(0, 200)}`,
            },
      );
    }

    /* ── malformed decisions never reach the agent ─────────────────────────── */

    // Validated before the snapshot is fetched, so these are refused whatever
    // the session's state — which is why they are asserted outside the
    // nothingPending branch.
    const bogus = await call(`/api/control/sessions/${encodeURIComponent(id)}/approve`, {
      method: "POST",
      body: JSON.stringify({ decision: "maybe" }),
    });
    t.ok(
      bogus.status === 400,
      "a decision that is neither approve nor deny is a 400 before anything is resumed",
      bogus.status === 400
        ? {}
        : {
            expected: 400,
            actual: `${bogus.status} — an unrecognised decision reaching answerInput() would resume the turn carrying nothing the tool can read`,
          },
    );

    const notJson = await call(`/api/control/sessions/${encodeURIComponent(id)}/approve`, {
      method: "POST",
      body: "this is not json",
    });
    t.ok(
      notJson.status === 400,
      "an unparseable body is a 400, not a 500",
      notJson.status === 400 ? {} : { expected: 400, actual: notJson.status },
    );

    /* ── the write path is guarded the same way every other one is ─────────── */

    // proxy.ts refuses a cross-site write on every non-GET. An approve endpoint
    // is the single worst place for that to have been forgotten: it is a
    // one-request authorisation of whatever the turn parked on.
    const crossSite = await fetch(`${DASHBOARD}/api/control/sessions/${encodeURIComponent(id)}/approve`, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString("base64")}`,
        "content-type": "application/json",
        origin: "https://evil.example.com",
        "sec-fetch-site": "cross-site",
      },
      body: JSON.stringify({ decision: "approve" }),
    });
    t.ok(
      crossSite.status === 403,
      "a cross-site POST carrying a valid credential is still refused",
      crossSite.status === 403
        ? {}
        : {
            expected: 403,
            actual: `${crossSite.status} — a page on another origin could otherwise ride the operator's cookie into an approval`,
          },
    );

    /* ── and an unauthenticated one never gets that far ────────────────────── */

    const anonymous = await fetch(`${DASHBOARD}/api/control/sessions/${encodeURIComponent(id)}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve" }),
    });
    t.ok(
      anonymous.status === 401,
      "and an unauthenticated one is 401 before the route is reached at all",
      anonymous.status === 401 ? {} : { expected: 401, actual: anonymous.status },
    );
  },
};
