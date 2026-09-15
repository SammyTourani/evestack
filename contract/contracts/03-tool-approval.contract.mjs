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
    //
    // Through the pinned range this repo used to track, that type lived at
    // dist/src/public/definitions/tool.d.ts, which is where this assertion used
    // to read it. As of 0.54.3 that file is not thinned, it is GONE — `ls
    // dist/src/public/definitions/` has no tool.d.ts or tool.js at all — and the
    // type it declared now lives at dist/src/tools/definition.d.ts. This is one
    // instance of a wider pattern in this release: dist/src/public/** is
    // becoming a barrel of `export type { ... } from "#foo/definition.js"`
    // re-exports (dist/src/public/tools/index.d.ts re-exports `ToolDefinition`
    // exactly that way now) while the field bodies themselves are addressed only
    // through eve's own internal `#foo/*.js` subpath-imports map, declared in
    // eve's package.json `imports`. A barrel re-export carries none of the
    // literal text of what it re-exports, so this has to read the real
    // definition file, not the public alias for it.
    const toolTypes = eve.readFile("dist/src/tools/definition.d.ts");
    t.ok(/^\s*approval\?:/m.test(toolTypes), "ToolDefinition still declares an `approval` field");

    // Same reorganisation, same fix, one detail different: unlike tool.d.ts,
    // dist/src/public/definitions/approval.d.ts still EXISTS at 0.54.3. But its
    // entire content is now two lines — `export type { ApprovalStatus, ... }
    // from "#approval/definition.js"` and one more for `resolveApprovalPolicy`
    // — so `t.contains` against it for "user-approval" or "denied" would fail
    // even though the guarantee holds, because a type-only re-export contains
    // no runtime string literals of the type it names. Verified by reading the
    // file directly before writing this comment. `#approval/definition.js`
    // resolves (per eve's package.json `imports`) to
    // dist/src/approval/definition.d.ts, which still declares `ApprovalStatus`
    // with both `"user-approval"` and `"denied"` among its literal members.
    const approvalTypes = eve.readFile("dist/src/approval/definition.d.ts");
    t.contains(approvalTypes, '"user-approval"', "ApprovalStatus still includes `user-approval`");
    t.contains(approvalTypes, '"denied"', "ApprovalStatus still includes `denied`");

    // eve vendors the AI SDK under dist/src/compiled, where `needsApproval` is
    // the AI SDK's own field and means nothing to us. Finding it on eve's own
    // public surface would mean eve had adopted it — the exact confusion that
    // makes a gate silently stop gating. dist/src/public itself is still the
    // right subtree to scope this to: it is eve's re-export surface regardless
    // of how thin the individual files inside it have become this release.
    const leaked = eve.grep("needsApproval", "dist/src/public");
    t.equal(
      leaked.length,
      0,
      "`needsApproval` has not appeared on eve's public surface (it is the AI SDK's field, not eve's)",
    );

    // dist/src/runtime/input/types.d.ts is gone the same way tool.d.ts is gone
    // — not moved to a barrel, just absent; 0.54.3 has no
    // dist/src/runtime/input/ directory at all. The parked-input-kind enum it
    // used to declare now lives next to the zod schema that actually defines
    // it, dist/src/shared/input.d.ts's `inputRequestKindSchema`, whose three
    // literal members ("question", "session-limit", "tool-approval") are
    // unchanged.
    const inputKinds = eve.readFile("dist/src/shared/input.d.ts");
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
