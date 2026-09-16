import { defineTool } from "eve/tools";
import type { ApprovalContext, ApprovalStatus } from "eve/tools/approval";
import { z } from "zod";
// Relative for the same reason as remember.ts and recall.ts: this file ships as
// part of the `@evestack/memory` registry item and must resolve in a stock eve
// project, which has no `#lib/*` mapping.
import {
  callerPrincipal,
  deletionLabel,
  describeForDeletion,
  forget,
  recent,
} from "../../lib/memory";

/**
 * Deleting a memory is the one memory operation that cannot be undone, so it is
 * the one that asks first.
 *
 * The gate parks the turn and waits for a human decision every single time. The
 * agent cannot talk its way past it — approval is resolved out of band, by
 * whoever is watching the session, not by the model. That is the whole point of
 * a gate: it holds even when the model is confidently wrong.
 *
 * This is also the template's worked example of human-in-the-loop. Anything
 * with real consequences — sending mail, moving money, touching production —
 * should carry the same guard.
 *
 * ── why this is no longer a bare `always()` ──────────────────────────────────
 *
 * `always()` from `eve/tools/approval` is a policy that returns "user-approval"
 * and nothing else, and for a long time that was the whole gate. It asked a
 * human a question the human could not answer, because of what the approval
 * card actually contains: eve builds it from the tool call, with the fixed
 * prompt "Approve tool call: forget" plus the arguments the model produced
 * (`harness/input-extraction.js`; rendered verbatim by the dashboard's chat, see
 * `packages/dashboard/app/chat/chat-client.tsx`). The arguments were `{id,
 * reason}`. So the operator was shown a number and a sentence the model wrote,
 * and asked to approve permanent deletion of a row whose contents nothing in
 * the flow had ever displayed.
 *
 * eve offers no way for a tool to attach its own preview to an approval
 * request, so the memory's text can only reach the card as an argument — and an
 * argument is the model's claim about the row, not the row. The policy below
 * closes that: `recall` hands out a server-generated `deleteWith` line for every
 * memory it returns, this tool asks for it back, and the policy regenerates it
 * from the row and compares. A model that invents or paraphrases one is refused
 * before a human is troubled, so a card that does appear carries text this
 * process read out of the database.
 *
 * Two behaviours are deliberately preserved rather than tightened, because
 * things in this repo depend on them and neither is a hole:
 *
 *   1. AN ID THAT DOES NOT EXIST STILL PARKS. `scripts/approval-demo.mjs` says
 *      so in its own comments — with no memories yet, `id 1` parks, because the
 *      gate is evaluated BEFORE execute and a missing row changes what
 *      approving DOES, not whether it asks — and `evals/deny-survives.eval.ts`
 *      drives the human-denial regression test through id 999999. Nothing is at
 *      risk: approving a deletion of nothing deletes nothing, and `execute`
 *      says so plainly.
 *   2. A ROW OWNED BY SOMEONE ELSE IS TREATED AS A ROW THAT DOES NOT EXIST —
 *      it parks, and then deletes nothing. Denying it with "that belongs to
 *      another user" would turn this tool into a lookup service for other
 *      people's memories, one guessed id at a time.
 *
 * Only the case where there IS something to show and the model did not show it
 * is refused. The refusal carries the exact line to send, so the model's next
 * call is right.
 */

const forgetInput = z.object({
  id: z
    .number()
    .int()
    .positive()
    .describe("The memory id to delete, as returned by the recall tool."),
  deleteWith: z
    .string()
    .min(1)
    .max(300)
    .optional()
    .describe(
      "The memory's `deleteWith` line exactly as the recall tool printed it, e.g. " +
        '`memory 12 (yours): Sam deploys the billing service on Fridays`. This is what the ' +
        "human approving the deletion is shown, so it must be copied, not written from memory " +
        "or summarised. Call recall first if you do not have it.",
    ),
  reason: z
    .string()
    .min(1)
    .describe("Why this memory should be deleted. Shown to the human deciding whether to approve."),
});

type ForgetInput = z.infer<typeof forgetInput>;

async function approveDeletion(ctx: ApprovalContext<ForgetInput>): Promise<ApprovalStatus> {
  // `toolInput` is whatever the model produced, handed over as an object with
  // no promise about its fields — eve only checks that it IS an object before
  // calling a policy (`harness/tools.js`, `buildApprovalFn`). So nothing here
  // assumes the schema already ran.
  const input = ctx.toolInput as Partial<ForgetInput> | undefined;
  const id = typeof input?.id === "number" ? input.id : null;
  if (id === null) return "user-approval";

  let target: { id: number; deleteWith: string } | null;
  try {
    target = await describeForDeletion(id, { principalId: callerPrincipal(ctx.session) });
  } catch (error) {
    // Park, never refuse, when the lookup itself fails. A Postgres that is
    // still starting — the ordinary state a few seconds into `docker compose
    // up`, and after every laptop resume — must not turn into "the agent
    // refuses to delete anything", and it cannot turn into a silent deletion
    // either: the human gate still stands, and `forget` re-checks ownership in
    // the database when the turn resumes. This is the one branch where being
    // wrong in the safe direction means asking a person.
    console.warn(
      `[evestack] could not read memory ${id} for its approval card, asking anyway: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return "user-approval";
  }

  if (target === null) return "user-approval";

  const claimed = input?.deleteWith?.trim();
  if (claimed === target.deleteWith) return "user-approval";

  return {
    type: "denied",
    reason:
      (claimed === undefined || claimed === ""
        ? "Nobody can approve a deletion they cannot see, so this tool needs the memory's own " +
          "`deleteWith` line before it will ask. "
        : `The deleteWith line you sent does not match memory ${id}. `) +
      `Call forget again with deleteWith set to exactly: ${target.deleteWith}`,
  };
}

export default defineTool({
  description:
    "Permanently delete a memory by its id. Destructive and irreversible: the fact is gone " +
    "from long-term memory. Use `recall` first to find the id and to copy the memory's " +
    "`deleteWith` line, which is what the approving human is shown. You can only delete " +
    "memories belonging to the person you are talking to. A human must approve every deletion.",
  approval: approveDeletion,
  inputSchema: forgetInput,
  async execute({ id, reason }, ctx) {
    // The same principal the gate above checked, resolved the same way. Passing
    // it is what makes the DELETE scoped; without it the statement would go back
    // to deleting by primary key alone, which is how one user could erase
    // another's memories.
    const principalId = callerPrincipal(ctx.session);
    const deleted = await forget(id, { principalId });
    if (!deleted) {
      // A missing id is far more likely to be a hallucinated number than a race,
      // so say what actually exists instead of reporting a bare failure.
      // `recent`, not `recall("")`. An empty query has to be embedded, and an
      // empty embedding is an error on every provider — measured locally as
      // "Empty embeddings array returned", and a 400 from OpenAI. This branch
      // exists to explain a bad id and it was the one branch that threw.
      //
      // The sample is the caller's own memories, and each entry carries the
      // `deleteWith` line the next attempt needs, so a model that guessed an id
      // can correct itself in one step instead of guessing again.
      const remaining = await recent(5, { principalId });
      return {
        deleted: false,
        note:
          `No memory with id ${id} that you are able to delete. It may never have existed, it may ` +
          "already be gone, or it may belong to someone else — memories are private to whoever " +
          "saved them. Use recall to get real ids before deleting.",
        sample: remaining.map((m) => ({ id: m.id, deleteWith: deletionLabel(m, principalId) })),
      };
    }
    return { deleted: true, id, reason };
  },
});
