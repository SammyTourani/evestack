import { defineEval } from "eve/evals";

/**
 * Denying a tool approval must not kill the session.
 *
 * Promoted from a real production session by the evestack dashboard's
 * "Promote to eval" button, then kept — this file is the regression test for
 * the worst bug we have shipped a fix for. Before the `surviveDeniedToolResults`
 * middleware in `agent/agent.ts`, answering "no" to a gated tool call ended the
 * durable session permanently: eve records the denial with an output type the
 * AI SDK cannot serialize, the provider 400s on the next turn, and the session
 * dies. Approving was always fine; only denial poisoned the transcript.
 *
 * Needs a running agent: `eve eval deny-survives --url http://127.0.0.1:2000/`.
 * Like the other evals here it drives a real model, so it is a local gate and
 * not part of CI.
 *
 * EXPECT THE OCCASIONAL RERUN. Measured about 3 passes in 4 on gpt-5-mini. The
 * only failure mode seen is `parked (0%): it ended "waiting" with no pending
 * requests` — the model answered in prose instead of calling the gated tool, so
 * there was no approval to deny and the test never reached its subject. That is
 * a vacuous run, not a regression; a real regression fails on `session.failed`.
 * A stronger model (`EVESTACK_MODEL=gpt-5`) complies more reliably.
 */
export default defineEval({
  description: "Use your forget tool to delete memory id 999999 with reason: promote-to-eval demo.",
  async test(t) {
    // Worded to make the tool call as close to certain as a real model allows.
    // The promoted original said "use your forget tool to…", and the model
    // answered in prose often enough to fail this eval outright. `mockModel()`
    // would remove the nondeterminism and also remove the test: the bug lives in
    // how a denied result is serialized into the NEXT real provider request, so
    // a mocked model cannot reproduce it.
    const turn1 = await t.send(
      "Call the forget tool now. id: 999999, reason: deny-path regression test. " +
        "Do not ask me anything first and do not call any other tool.",
    );

    // This turn parked for human approval and the human said no. Replaying the
    // denial is the point: before the model middleware in agent/agent.ts, a
    // denied tool result killed the whole durable session on the next turn.
    turn1.parked();
    await t.respondAll("deny");

    // Survival, not success, is the invariant. Whether the agent answers or asks
    // a follow-up after being denied is up to the model — asserting
    // `succeeded()` here failed roughly one run in two, because a follow-up
    // question parks the turn again and a parked turn is not a completed one.
    // What the bug actually did was end the session, so that is what this
    // guards.
    t.notEvent("session.failed");
    t.notEvent("turn.failed");
    t.calledTool("forget", { status: "rejected" });
  },
});
