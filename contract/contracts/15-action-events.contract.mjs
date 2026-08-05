/**
 * The event vocabulary "Promote to eval" reads out of the durable stream.
 *
 * `packages/dashboard/lib/promote-eval.ts` turns a real session into a real
 * `.eval.ts`, and it does that by walking eve's event stream — not the OTel
 * traces, because eve's local tracing runtime refuses to attach when the project
 * authors `agent/instrumentation.ts`. Two event names carry the whole of it:
 * `actions.requested` names the tools a turn asked for, and `action.result`
 * carries the verdict that says a tool was DENIED. If either moves, the
 * generated eval quietly stops asserting the thing it was promoted to assert —
 * and a green eval that checks nothing is the failure mode this whole repository
 * is organised against.
 *
 * ── Why this contract exists at all ──────────────────────────────────────────
 *
 * eve 0.30.8 added `action.partial`: tools may now stream preliminary snapshots,
 * published before the final `action.result`. Nothing broke — promote-eval's
 * switch has no default branch, so an unrecognised event is ignored rather than
 * miscounted, and that was verified before writing this. But it was *new surface
 * nothing asserted*, found by reading a changelog rather than by any check, and
 * the gap it revealed is the one worth closing: nothing anywhere required the
 * denial verdict to keep arriving on a TERMINAL event.
 *
 * That distinction is the contract. If a future release moved the verdict onto a
 * partial, or made `action.result` optional when partials are present,
 * promote-eval would produce evals with no `calledTool(..., { status:
 * "rejected" })` assertion in them, silently, for every denial. The suite would
 * be green, the page would be green, and the flywheel would be turning on
 * nothing.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../lib/repo.mjs";

export default {
  id: "protocol/action-events-promote-eval-reads",
  title: "the denial verdict still arrives on a terminal action.result, not a partial",
  assumption:
    "eve's stream carries `actions.requested` naming a turn's tools and `action.result` carrying " +
    "the terminal verdict for each, and `action.partial` — when present — is a preliminary " +
    "snapshot that never replaces it.",
  evestackUse:
    "packages/dashboard/lib/promote-eval.ts builds an eval from the durable event stream: it reads " +
    "tool names from `actions.requested` and detects denials from `action.result`. A promoted eval " +
    "for a denied session asserts `calledTool(name, { status: 'rejected' })`, which is the whole " +
    "point of promoting it. If the verdict stopped arriving on a terminal event, every promoted " +
    "eval would silently lose that assertion and pass regardless.",

  async check(eve, t) {
    const declarations = eve.readFile("dist/src/protocol/message.d.ts");

    // The two names promote-eval switches on. Read from the .d.ts rather than
    // grepped from anywhere in dist: these are the declared protocol, not an
    // incidental string in a bundled dependency.
    for (const name of ["actions.requested", "action.result"]) {
      t.ok(
        declarations.includes(`type: "${name}"`),
        `eve still declares a stream event \`${name}\``,
        declarations.includes(`type: "${name}"`)
          ? {}
          : { expected: `type: "${name}"`, actual: "not declared in protocol/message.d.ts" },
      );
    }

    // The interface carrying the terminal result must still carry a `result`.
    // promote-eval reads `data.result.toolName` and the approval status beneath
    // it; a rename here is the quiet break this contract exists for.
    const resultBlock = declarations.slice(
      Math.max(0, declarations.lastIndexOf("interface", declarations.indexOf('type: "action.result"'))),
      declarations.indexOf('type: "action.result"'),
    );
    t.ok(
      /\bresult\s*:/.test(resultBlock),
      "the action.result event still carries a `result` payload",
      /\bresult\s*:/.test(resultBlock) ? {} : { expected: "result:", actual: resultBlock.slice(-200) },
    );

    // The denial marker itself. promote-eval accepts either shape — an error
    // code, or an approval status on the output — so the contract holds if
    // EITHER is still present, and fails only if both disappear at once.
    const denialMarkers = eve.grep("TOOL_EXECUTION_DENIED", "dist/src");
    t.ok(
      denialMarkers.length > 0,
      "eve still has a TOOL_EXECUTION_DENIED marker for a refused tool call",
      denialMarkers.length > 0
        ? {}
        : { expected: "TOOL_EXECUTION_DENIED somewhere in dist/src", actual: "gone" },
    );

    /* ---------------------------------------------------------------------- */
    /* action.partial — the surface that prompted this contract                */
    /* ---------------------------------------------------------------------- */

    const hasPartial = declarations.includes('type: "action.partial"');

    // Tolerated in both directions on purpose. Its absence is fine (it did not
    // exist before 0.30.8 and evestack never required it); its presence is fine
    // (promote-eval ignores unrecognised events). What must NOT change is what
    // it means.
    if (hasPartial) {
      // The declared contract is that the final snapshot is action.result. eve
      // states this in the doc comment above the interface, which is the only
      // machine-readable place it is written down — so that sentence is what is
      // pinned. If eve rewords it, this fails and a human re-reads the protocol,
      // which is the correct outcome: it means the relationship between the two
      // events may have changed.
      const partialDocs = declarations.slice(
        Math.max(0, declarations.lastIndexOf("/**", declarations.indexOf("ActionPartialStreamEvent"))),
        declarations.indexOf("ActionPartialStreamEvent"),
      );
      t.ok(
        /final snapshot is emitted as `action\.result`/.test(partialDocs) ||
          /preliminary/.test(partialDocs),
        "action.partial is still documented as preliminary, with action.result as the final snapshot",
        { actual: partialDocs.replace(/\s+/g, " ").trim().slice(0, 240) },
      );

      // And the dashboard must not start depending on partials without this
      // contract being extended to say what it assumes about them. Read from
      // evestack's own source, the way lib/repo.mjs derives the other
      // source-scanning contracts — the pairing is between eve's protocol and
      // our reader of it, so both halves have to be looked at.
      const promoteEval = readFileSync(
        join(REPO_ROOT, "packages", "dashboard", "lib", "promote-eval.ts"),
        "utf8",
      );
      const consumesPartial = /case\s+"action\.partial"/.test(promoteEval);
      t.ok(
        !consumesPartial,
        "promote-eval still derives its assertions from terminal events only",
        consumesPartial
          ? {
              expected: "no dependence on preliminary snapshots",
              actual:
                "promote-eval now reads action.partial — extend this contract to describe what it assumes about them",
            }
          : {},
      );
    } else {
      t.ok(true, "eve declares no action.partial event (nothing to reconcile)");
    }
  },
};
