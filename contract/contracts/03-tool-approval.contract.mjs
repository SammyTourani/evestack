/**
 * The human-in-the-loop gate: `approval`, and what its helpers return.
 *
 * This is a semantic contract, not a shape one. `approval: always()` typechecks
 * whether or not the harness still honours it — TypeScript is happy to let an
 * ignored field sit on an object. What actually matters is the *string* the
 * helper returns, because that string is the whole protocol between an
 * authored tool and the runtime's decision to park the turn.
 */

/** The context an Approval function receives. Minimal but structurally real. */
function approvalContext(overrides = {}) {
  return {
    approvedTools: new Set(),
    callId: "call_contract",
    toolName: "forget",
    toolInput: { id: 1, reason: "contract suite" },
    ...overrides,
  };
}

const gate = {
  id: "tools/approval-is-the-gating-field",
  title: "`approval` gates tool calls, and its helpers still return the statuses that park a turn",
  assumption:
    "eve gates tools with an `approval` field returning `\"user-approval\"` to park a turn — not the AI SDK's `needsApproval`.",
  evestackUse:
    "templates/default/agent/tools/forget.ts carries `approval: always()` because deleting a memory is the " +
    "one irreversible memory operation. If eve renames the field, changes the status vocabulary, or moves " +
    "to the AI SDK's `needsApproval`, that tool keeps compiling and stops asking — the agent deletes user " +
    "memories with no human in the loop, and the dashboard's approve/deny UI has nothing to render. " +
    "packages/dashboard/lib/agent-client.ts also hard-codes the `tool-approval` input kind that this gate " +
    "produces.",

  async check(eve, t) {
    const approval = await eve.loadPublic("eve/tools/approval");

    for (const helper of ["always", "never", "once"]) {
      t.equal(typeof approval[helper], "function", `eve/tools/approval exports \`${helper}()\``);
    }

    // The exact strings, executed. This is the assertion that survives a
    // refactor of eve's types and catches a change of meaning.
    t.equal(await approval.always()(approvalContext()), "user-approval", "always() demands user approval every call");
    t.equal(await approval.never()(approvalContext()), "not-applicable", "never() waives approval");
    t.equal(
      await approval.once()(approvalContext()),
      "user-approval",
      "once() demands approval the first time a tool is called in a session",
    );
    t.equal(
      await approval.once()(approvalContext({ approvedTools: new Set(["forget"]) })),
      "not-applicable",
      "once() waives approval after the tool has been approved in this session",
    );

    // The field, on the type eve asks authors to satisfy.
    const toolTypes = eve.readFile("dist/src/public/definitions/tool.d.ts");
    t.ok(/^\s*approval\?:/m.test(toolTypes), "ToolDefinition still declares an `approval` field");

    const approvalTypes = eve.readFile("dist/src/public/definitions/approval.d.ts");
    t.contains(approvalTypes, '"user-approval"', "ApprovalStatus still includes `user-approval`");
    t.contains(approvalTypes, '"denied"', "ApprovalStatus still includes `denied`");

    // eve vendors the AI SDK under dist/src/compiled, where `needsApproval` is
    // the AI SDK's own field and means nothing to us. Finding it on eve's own
    // public surface would mean eve had adopted it — the exact confusion that
    // makes a gate silently stop gating.
    const leaked = eve.grep("needsApproval", "dist/src/public");
    t.equal(
      leaked.length,
      0,
      "`needsApproval` has not appeared on eve's public surface (it is the AI SDK's field, not eve's)",
    );

    const inputKinds = eve.readFile("dist/src/runtime/input/types.d.ts");
    t.contains(inputKinds, "tool-approval", "the parked-input kind for an approval is still `tool-approval`");
  },
};

const dynamicApproval = {
  id: "tools/approval-survives-defineTool",
  title: "defineTool preserves the approval policy and brands the entry",
  assumption: "`defineTool` returns the approval function untouched and stamps the `eve:tool-brand` symbol.",
  evestackUse:
    "Every gated tool evestack ships goes through `defineTool`. eve's own resolver uses the brand symbol to " +
    "tell a single tool entry from a map of them; @evestack/composio returns entries from a dynamic resolver " +
    "and depends on that distinction being made the same way.",

  async check(eve, t) {
    const tools = await eve.loadPublic("eve/tools");
    const approval = await eve.loadPublic("eve/tools/approval");

    const policy = approval.always();
    const tool = tools.defineTool({
      description: "contract suite probe",
      inputSchema: {},
      approval: policy,
      execute: () => "ok",
    });

    t.equal(tool.approval, policy, "defineTool keeps the exact approval function it was given");
    t.equal(
      tool[Symbol.for("eve:tool-brand")],
      true,
      "defineTool stamps Symbol.for('eve:tool-brand') on the entry it returns",
    );
  },
};

export default [gate, dynamicApproval];
