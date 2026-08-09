/**
 * Argument validation for the runtime runner's selection flags.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * `contract/runtime/run.mjs` is the tier that exists because static assertions
 * are blind to behaviour. That argument only holds if the tier actually runs.
 * Before this file, it could be reduced to nothing by a single mistyped
 * character and still print the sentence it prints when everything is fine:
 *
 *     $ node contract/runtime/run.mjs --only=seem     # meant --only=seam
 *
 *     evestack runtime probes
 *
 *       0 probes, 0 checks — all green
 *
 *     $ echo $?
 *     0
 *
 * Six seam probes were meant to run. None did. The job is green. Nobody finds
 * out, because green is exactly what a passing job looks like.
 *
 * The same hole had two more mouths:
 *
 *   --exclude=/       every id contains a slash, so this removed all 20 probes
 *                     and reported "0 probes, 0 checks — all green", exit 0.
 *
 *   --require=postgress   a typo in the one flag whose entire job is to turn a
 *                     skip into a failure. The runner matched it against no
 *                     probe's `needs`, every probe skipped as if the flag had
 *                     never been passed, and the run went green having checked
 *                     nothing. ci.yml:216 and eve-watch.yml:235 both depend on
 *                     that flag being the thing that stops a silent skip; a
 *                     typo there silently removed the guard against silence.
 *
 * So: a selection that selects nothing, and a requirement that can require
 * nothing, are USAGE ERRORS (exit 2 — "could not start"), not passes.
 *
 * ── The line this file is careful not to cross ───────────────────────────────
 *
 * "Zero probes selected" is a bug in the command. "Selected, but its
 * prerequisite is absent, therefore skipped" is legitimate and load-bearing:
 * ci.yml:216 runs the Postgres tier before the agent is booted, and the
 * agent-needing probes MUST be allowed to skip there. Nothing in this file
 * looks at availability. It only asks whether the flags could ever have
 * selected or required anything, which is knowable from the probe list alone,
 * before a single probe runs.
 */

/** Exit code for a malformed invocation. Matches the runner's documented
 *  "2 · could not start": a command that selects nothing never started. */
export const USAGE_EXIT_CODE = 2;

/** The `foo` in `foo/does-a-thing` — what a human means by "the seam probes". */
export function groupsOf(probes) {
  return [...new Set(probes.map((p) => p.id.split("/")[0]))].sort();
}

/** Every capability any probe declares in `needs`. The vocabulary --require
 *  accepts; anything outside it is a typo by definition. */
export function capabilitiesOf(probes) {
  return [...new Set(probes.flatMap((p) => p.needs ?? []))].sort();
}

/**
 * @returns {string|null} an operator-facing explanation, or null if the
 *   selection contains at least one probe.
 */
export function emptySelectionError({ all, matched, selected, only, exclude }) {
  if (selected.length > 0) return null;

  if (all.length === 0) {
    return (
      "No probe files found in contract/runtime/probes.\n" +
      "  A runtime tier with no probes cannot pass. This is a broken checkout, not a green run."
    );
  }

  const hint =
    `  Probe groups that exist: ${groupsOf(all).join(", ")}\n` +
    "  Full list: node contract/runtime/run.mjs --list";

  if (only !== null && matched.length === 0) {
    return (
      `--only=${only} matched none of the ${all.length} runtime probes.\n` +
      "  A filter that selects nothing is a usage error, not a pass — otherwise a typo\n" +
      "  in a CI step turns a whole verification tier into a no-op that reports success.\n" +
      hint
    );
  }

  return (
    `--exclude=${exclude} removed all ${matched.length} probes` +
    `${only === null ? "" : ` matched by --only=${only}`}, leaving nothing to run.\n` +
    "  A selection that selects nothing is a usage error, not a pass.\n" +
    hint
  );
}

/**
 * --require is the flag that turns "prerequisite absent, so I skipped" into
 * "prerequisite absent, so I failed". It is matched against each probe's
 * `needs`, so a token that appears in no `needs` field is inert: the run
 * behaves exactly as if the flag had been omitted, and the CI step that passed
 * it believes it is protected when it is not.
 *
 * Two ways to be inert, reported separately because they have different fixes:
 *
 *   unknown   the token is not a capability at all (`postgress`). Fix the spelling.
 *   inert     a real capability, but no SELECTED probe needs it — `--require=agent
 *             --only=memory` cannot fail anything, because every memory probe
 *             needs postgres and nothing else. Fix the flag or widen the selection.
 *
 * @returns {string[]} zero or more operator-facing explanations.
 */
export function requirementErrors({ required, all, selected, only, exclude }) {
  const known = capabilitiesOf(all);
  const usable = capabilitiesOf(selected);
  const errors = [];

  for (const capability of required) {
    if (!known.includes(capability)) {
      errors.push(
        `--require=${capability} names a capability no probe declares, so it can never fail anything.\n` +
          `  Capabilities probes actually declare: ${known.join(", ")}`,
      );
      continue;
    }
    if (!usable.includes(capability)) {
      const filters = [only === null ? null : `--only=${only}`, exclude === null ? null : `--exclude=${exclude}`]
        .filter(Boolean)
        .join(" ");
      errors.push(
        `--require=${capability} has no effect on this selection: not one of the ${selected.length} probes ` +
          `selected${filters ? ` by ${filters}` : ""} declares it in \`needs\`,\n` +
          "  so the flag cannot turn a single skip into a failure. That is the silent-no-op this\n" +
          "  runner exists to refuse.\n" +
          `  Selected probes need: ${usable.join(", ") || "(nothing)"}`,
      );
    }
  }

  return errors;
}
