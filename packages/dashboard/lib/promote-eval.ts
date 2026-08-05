import type { EveStreamEvent } from "./agent-client";

/**
 * Turns a real session into an eve eval file.
 *
 * This is the flywheel: the sessions worth testing are the ones that already
 * went wrong in production, and writing that test by hand means reading a
 * transcript and retyping it. Here the transcript IS the test — we replay the
 * user's actual messages and assert on what actually happened.
 *
 * WHY THE DURABLE EVENT STREAM AND NOT TRACES.
 * The obvious source is OpenTelemetry: `ai.prompt.messages` holds the prompt
 * bodies. It is the wrong one. eve only creates those spans from the agent
 * instrumentation installed by its *local* tracing runtime, and that runtime
 * refuses to attach when a project authors its own `agent/instrumentation.ts`
 * ("eve could not register OpenTelemetry because another runtime already
 * exists"). Exporting traces anywhere — Jaeger, Langfuse, this dashboard —
 * therefore costs you every agent-level span, prompts included. Measured on
 * eve 0.30.6: an exporting agent emits workflow plumbing spans plus a bare
 * `ai.eve.turn`, and nothing carrying a message.
 *
 * The durable event stream has none of that problem. It is the same NDJSON the
 * chat UI already consumes, it replays from the beginning of a session, it is
 * asserted by contract 05, and it exists whether or not anything is exporting
 * traces. It is also strictly better data: `message.received` carries the exact
 * user text, `actions.requested` carries tool names and arguments, and
 * `action.result` distinguishes a denial from a failure.
 *
 * Two rules come from eve's own eval loader and are not negotiable:
 *
 *  1. **Never emit `id` or `name`.** eve derives eval identity from the
 *     `evals/<path>.eval.ts` file path and *throws* if the definition carries
 *     either key. The generated filename is therefore the identity.
 *  2. **Never emit a legacy key** (`input`/`run`/`checks`/`scores`/`expected`/
 *     `thresholds`/`parseOutput`/`model`/`requires`). eve rejects those outright.
 *
 * The output is deliberately a *draft a human edits*. We can see what the agent
 * did; we cannot see what it should have done. Assertions that encode intent
 * are emitted as commented suggestions with the observed value inlined.
 */

export interface GeneratedEval {
  readonly filename: string;
  readonly source: string;
  /** Human-facing notes about what could not be recovered. */
  readonly warnings: readonly string[];
}

/**
 * Mutable by design: turns are assembled by folding a replayed event log, and
 * a turn's reply and failure state arrive in later events than its opening
 * message.
 */
interface RecoveredTurn {
  turnId: string | null;
  userMessage: string;
  toolNames: string[];
  deniedTools: string[];
  assistantReply: string | null;
  failed: boolean;
}

const LEGACY_KEYS = [
  "input",
  "run",
  "checks",
  "scores",
  "expected",
  "thresholds",
  "parseOutput",
  "model",
  "requires",
  "id",
  "name",
];

/** Escape for a TypeScript double-quoted string literal. */
function q(value: string): string {
  return JSON.stringify(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Walks the replayed event log in order and rebuilds one entry per user turn.
 *
 * Turn attribution comes from `turnId` on the events themselves rather than
 * from ordering, because a denied turn interleaves: the approval is answered
 * long after the turn that requested it started.
 */
export function recoverTurns(events: readonly EveStreamEvent[]): RecoveredTurn[] {
  const byTurn = new Map<string, RecoveredTurn>();
  const order: string[] = [];

  /**
   * Resolve the turn an event belongs to.
   *
   * The fallback to the most recently opened turn is load-bearing, not
   * defensive. Answering an approval starts a NEW turn: the user message opens
   * `turn_0`, and the `action.result` carrying the denial arrives on `turn_1`,
   * which has no `message.received` of its own. Keying strictly on turnId drops
   * every denial on the floor — which is what happened before this comment
   * existed, and the generated eval silently lost the one assertion worth
   * having.
   */
  const ensure = (turnId: string | null): RecoveredTurn | null => {
    const exact = byTurn.get(turnId ?? "__no_turn__");
    if (exact) return exact;
    const last = order[order.length - 1];
    return last ? (byTurn.get(last) ?? null) : null;
  };

  for (const event of events) {
    const data = asRecord(event.data);
    const turnId = str(data.turnId);
    const key = turnId ?? "__no_turn__";

    switch (event.type) {
      case "message.received": {
        // `message` is the plain text; `parts` is the structured form. Prefer
        // the text and fall back to concatenating text parts.
        const text =
          str(data.message) ??
          (Array.isArray(data.parts)
            ? data.parts
                .map((part) => str(asRecord(part).text) ?? "")
                .join("")
                .trim() || null
            : null);
        if (!text) break;

        if (!byTurn.has(key)) order.push(key);
        byTurn.set(key, {
          turnId,
          userMessage: text,
          toolNames: [],
          deniedTools: [],
          assistantReply: null,
          failed: false,
        });
        break;
      }

      case "actions.requested": {
        const turn = ensure(turnId);
        if (!turn || !Array.isArray(data.actions)) break;
        for (const action of data.actions) {
          const name = str(asRecord(action).toolName);
          if (name && !turn.toolNames.includes(name)) turn.toolNames.push(name);
        }
        break;
      }

      case "action.result": {
        const turn = ensure(turnId);
        if (!turn) break;
        const result = asRecord(data.result);
        const name = str(result.toolName);
        // A denial is recorded as a tool result carrying the approval verdict,
        // not as a distinct event type.
        const denied =
          str(asRecord(data.error).code) === "TOOL_EXECUTION_DENIED" ||
          str(asRecord(asRecord(result.output).approval).status) === "denied";
        if (name && denied && !turn.deniedTools.includes(name)) turn.deniedTools.push(name);
        break;
      }

      case "message.completed": {
        const turn = ensure(turnId);
        if (!turn) break;
        const message = asRecord(data.message);
        if (str(message.role) === "user") break;
        const parts = Array.isArray(message.parts) ? message.parts : [];
        const text = parts
          .map((part) => (str(asRecord(part).type) === "text" ? (str(asRecord(part).text) ?? "") : ""))
          .join("")
          .trim();
        if (text) turn.assistantReply = text;
        break;
      }

      case "turn.failed":
      case "session.failed": {
        const turn = ensure(turnId);
        if (turn) turn.failed = true;
        break;
      }
    }
  }

  return order.map((key) => byTurn.get(key)!).filter(Boolean);
}

/**
 * `evals/<name>.eval.ts` — the filename IS the eval's identity, so it has to be
 * stable, unique, and readable in a CI failure line.
 */
export function suggestFilename(sessionId: string, title: string | null): string {
  const base = (title ?? "session")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const suffix = sessionId.replace(/^wrun_/, "").slice(-6).toLowerCase();
  return `${base || "session"}-${suffix}.eval.ts`;
}

export function generateEval(input: {
  sessionId: string;
  title: string | null;
  events: readonly EveStreamEvent[];
}): GeneratedEval {
  const turns = recoverTurns(input.events);
  const warnings: string[] = [];

  if (turns.length === 0) {
    warnings.push(
      "No user messages were recovered from this session's durable event log. If the session " +
        "is old, eve may have pruned it; otherwise check that the agent is reachable from the " +
        "dashboard.",
    );
  }

  const anyDenied = turns.some((t) => t.deniedTools.length > 0);
  const anyFailed = turns.some((t) => t.failed);

  // Only `defineEval` is imported. Reply assertions are emitted as
  // `messageIncludes`, which lives on the turn handle — importing `includes`
  // from eve/evals/expect for a commented-out line would be an unused import in
  // every generated file.
  const imports = [`import { defineEval } from "eve/evals";`];

  const body: string[] = [];
  for (const [index, turn] of turns.entries()) {
    if (index > 0) body.push("");

    // Assertions are emitted on the RETURNED TURN, not on `t`. Bare `t.succeeded()`
    // is session-scoped, so in a session that ends parked — which is exactly what
    // an approval flow does — it fails with "run parked on N unanswered input
    // request(s)" even though every turn behaved correctly. Learned by running a
    // generated eval and reading that failure.
    const handle = `turn${index + 1}`;
    body.push(`    const ${handle} = await t.send(${q(turn.userMessage)});`);

    // Tools that ran to completion are asserted on this turn. Denied tools are
    // NOT: see below.
    for (const tool of turn.toolNames) {
      if (turn.deniedTools.includes(tool)) continue;
      body.push(`    ${handle}.calledTool(${q(tool)});`);
    }

    if (turn.deniedTools.length > 0) {
      body.push("");
      body.push(`    // This turn parked for human approval and the human said no. Replaying the`);
      body.push(`    // denial is the point: before the model middleware in agent/agent.ts, a`);
      body.push(`    // denied tool result killed the whole durable session on the next turn.`);
      body.push(`    ${handle}.parked();`);
      body.push(`    const ${handle}Resumed = await t.respondAll("deny");`);
      body.push(`    // The agent may ask a follow-up after a denial, in which case this turn`);
      body.push(`    // parks again — swap to .parked() if that is the behaviour you want.`);
      body.push(`    ${handle}Resumed.succeeded();`);
      for (const tool of turn.deniedTools) {
        // Session scope, deliberately. A denied call spans two turns: the
        // request lands in the parked turn and the rejection resolves in the
        // resumed one, so NEITHER turn holds both halves and a turn-scoped
        // assertion can never match. `calledTool` also defaults to status
        // "completed", which a denied call never reaches — omit the status and
        // it reports "expected a matching call to X" while printing that exact
        // call as observed. Both facts learned by running this.
        body.push(`    t.calledTool(${q(tool)}, { status: "rejected" });`);
      }
    } else {
      body.push(`    ${handle}.succeeded();`);
    }

    if (turn.assistantReply) {
      const excerpt = turn.assistantReply.slice(0, 60);
      body.push(`    // Observed reply — replace with the phrase that actually matters:`);
      body.push(`    // ${handle}.messageIncludes(${q(excerpt)});`);
    }
  }

  if (anyFailed) {
    warnings.push(
      "This session contains a failed turn. The generated eval asserts t.succeeded(), so it " +
        "stays red until the bug is fixed — which is exactly what a regression test is for.",
    );
  }
  if (anyDenied) {
    warnings.push(
      "A tool approval was denied here, so the eval replays the denial with t.respondAll(\"deny\"). " +
        "That path used to end the durable session; keeping it under test is worth more than the " +
        "rest of this file.",
    );
  }

  const description =
    input.title?.trim() ||
    `Replay of session ${input.sessionId} — describe the behaviour under test`;

  const source = `${imports.join("\n")}

/**
 * Promoted from production session ${input.sessionId}.
 *
 * A DRAFT, not a finished test. The event log records what the agent did, never
 * what it should have done — so the messages and tool calls below are real, and
 * the value assertions are commented suggestions for you to make meaningful.
 *
 * Generated by the evestack dashboard.
 */
export default defineEval({
  description: ${q(description)},
  async test(t) {
${body.length > 0 ? body.join("\n") : "    // No user messages recovered — see the dashboard warning."}
  },
});
`;

  assertNoLegacyKeys(source);

  return { filename: suggestFilename(input.sessionId, input.title), source, warnings };
}

/**
 * eve throws at load time on a legacy or identity key, which would turn a
 * promoted eval into a broken build rather than a red test. Cheaper to catch
 * here than to hand someone a file that cannot be loaded.
 */
function assertNoLegacyKeys(source: string): void {
  for (const key of LEGACY_KEYS) {
    if (new RegExp(`^\\s{2}${key}\\s*:`, "m").test(source)) {
      throw new Error(`generated eval contains the key "${key}", which eve's eval loader rejects`);
    }
  }
}
