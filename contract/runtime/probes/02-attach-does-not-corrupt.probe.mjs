/**
 * `evestack attach` must never leave a project that does not parse.
 *
 * This one has already happened, and it is the worst kind of failure this tool
 * can have. The world snippet attach inserts ends in a `//` comment ruler, so
 * anything already sitting on the same line as `defineAgent({` was appended to
 * that comment and silently commented out. A compact agent —
 *
 *     export default defineAgent({ model: openai("gpt-5-mini") });
 *
 * which is exactly what a hand-written or minimal project looks like — came out
 * with **no `model` property and an unclosed paren**. The project stopped
 * parsing. And attach printed "Done."
 *
 * The bug was fixed by capturing the rest of the line and re-emitting it below.
 * That fix is one regex, in a tool whose entire job is rewriting other people's
 * source, and nothing was checking that it stays correct. This probe is that
 * check.
 *
 * It asserts on the real TypeScript parser rather than on brace counting: the
 * failure mode was a *syntactically* broken file, and a heuristic that counts
 * braces would have been satisfied by the corrupted output in at least one of
 * the shapes below.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "../../lib/repo.mjs";

/**
 * Driven through index.mjs, not attach.mjs.
 *
 * `attach` is a subcommand, and attach.mjs only exports a function — running it
 * directly produces no output, changes nothing, and exits 0. The first version
 * of this probe did exactly that and would have reported a clean pass forever
 * while testing nothing, which is the failure this whole tier exists to catch.
 * The "attach actually modified the agent" assertion below is what caught it,
 * and is why that assertion is not redundant.
 */
const CLI = join(REPO_ROOT, "packages", "create-evestack", "index.mjs");

/**
 * Agent shapes attach has to survive. The first is the one that broke it; the
 * rest are the neighbouring shapes a real project might have, each of which
 * puts something different immediately after `defineAgent({`.
 */
const FIXTURES = [
  {
    name: "one-line agent (the shape that broke it)",
    source: `import { defineAgent } from "eve";
import { openai } from "@ai-sdk/openai";

export default defineAgent({ model: openai("gpt-5-mini") });
`,
    mustKeep: ["model", "openai("],
  },
  {
    name: "multi-line agent",
    source: `import { defineAgent } from "eve";
import { openai } from "@ai-sdk/openai";

export default defineAgent({
  model: openai("gpt-5-mini"),
  system: "You are helpful.",
});
`,
    mustKeep: ["model", "system"],
  },
  {
    name: "trailing comment on the defineAgent line",
    source: `import { defineAgent } from "eve";
import { openai } from "@ai-sdk/openai";

export default defineAgent({ // the agent
  model: openai("gpt-5-mini"),
});
`,
    mustKeep: ["model"],
  },
  {
    name: "space between defineAgent and the brace",
    source: `import { defineAgent } from "eve";
import { openai } from "@ai-sdk/openai";

export default defineAgent(  {  model: openai("gpt-5-mini"), system: "hi" }  );
`,
    mustKeep: ["model", "system"],
  },
];

function scaffoldFixture(dir, source) {
  mkdirSync(join(dir, "agent"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify(
      {
        name: "attach-fixture",
        private: true,
        type: "module",
        dependencies: { eve: "^0.30.0" },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(dir, "agent", "agent.ts"), source);
}

export default {
  id: "attach/never-produces-a-file-that-does-not-parse",
  title: "evestack attach leaves every agent shape still parsing, with its model intact",
  needs: ["typescript"],
  why:
    "attach rewrites source it did not write. It once appended a project's entire model binding " +
    "onto a comment, leaving a file with no model and an unclosed paren — and reported success. " +
    "A tool that silently breaks the project it was pointed at is worse than one that refuses.",

  async available() {
    try {
      await import("typescript");
      return [];
    } catch {
      return ["the typescript package is not resolvable from the repo root"];
    }
  },

  async run(t) {
    const ts = (await import("typescript")).default;
    const root = mkdtempSync(join(tmpdir(), "evestack-attach-probe-"));

    // How many fixtures attach actually rewrote. Read by the suite-level
    // assertion after the loop; see the comment there for why counting is the
    // only thing that survives the `continue` below.
    let rewritten = 0;

    try {
      for (const fixture of FIXTURES) {
        const dir = join(root, fixture.name.replace(/[^a-z0-9]+/gi, "-"));
        scaffoldFixture(dir, fixture.source);

        // --dry-run would prove nothing: the corruption was in the written file.
        // --yes drives it non-interactively; attach explicitly supports both.
        let failedToRun = null;
        try {
          execFileSync(process.execPath, [CLI, "attach", dir, "--yes"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 120_000,
            // Nothing here should reach the network; if attach ever starts
            // installing during attach, that is worth knowing about loudly
            // rather than waiting two minutes for it.
            env: { ...process.env, EVESTACK_ATTACH_SKIP_INSTALL: "1", npm_config_offline: "true" },
          });
        } catch (error) {
          failedToRun = (error.stderr || error.stdout || error.message || "").toString().slice(-400);
        }

        const after = readFileSync(join(dir, "agent", "agent.ts"), "utf8");

        // Ran at all. A non-zero exit is a legitimate outcome only if the file
        // was left untouched; a crash *after* a partial rewrite is the exact
        // scenario that produced a broken project.
        const untouched = after === fixture.source;
        if (failedToRun !== null) {
          t.ok(untouched, `${fixture.name}: attach failed but left the file untouched`, {
            actual: failedToRun,
          });
          if (untouched) continue;
        }

        // The assertion that matters. Syntactic diagnostics only: the fixture
        // has no node_modules, so type errors are expected and meaningless here
        // — a file that does not PARSE is the failure.
        const parsed = ts.createSourceFile(
          "agent.ts",
          after,
          ts.ScriptTarget.ESNext,
          /* setParentNodes */ false,
          ts.ScriptKind.TS,
        );
        const syntactic = parsed.parseDiagnostics ?? [];
        t.ok(
          syntactic.length === 0,
          `${fixture.name}: the rewritten agent still parses`,
          syntactic.length === 0
            ? {}
            : {
                expected: "no syntax errors",
                actual: syntactic
                  .slice(0, 3)
                  .map((d) => ts.flattenDiagnosticMessageText(d.messageText, " "))
                  .join(" | "),
              },
        );

        // Parsing is necessary and not sufficient: the original bug produced a
        // file that (in some shapes) still parsed while having lost the model.
        for (const keep of fixture.mustKeep) {
          const kept = after.includes(keep);
          t.ok(kept, `${fixture.name}: \`${keep}\` survived the rewrite`, {
            ...(kept ? {} : { expected: `${keep} still present`, actual: after.slice(0, 300) }),
          });
        }

        // And prove attach actually did something, or every assertion above is
        // trivially satisfied by a no-op.
        const changed = after !== fixture.source;
        t.ok(changed, `${fixture.name}: attach actually modified the agent`, {
          ...(changed ? {} : { expected: "a rewritten file", actual: "unchanged" }),
        });
        if (changed) rewritten += 1;
      }

      // SUITE-LEVEL ANTI-VACUITY, and it exists because the `continue` above
      // routes around every assertion that matters.
      //
      // "attach exited non-zero and left the file alone" is a legitimate
      // per-fixture outcome, so skipping the parse check for that fixture is
      // right — there is nothing to parse-check. What was wrong is what the
      // PROBE then reported: one green check for that fixture and nothing else,
      // including nothing from the `changed` assertion whose own comment says it
      // is there so "every assertion above is [not] trivially satisfied by a
      // no-op". An `evestack attach` that crashed on every shape in this file
      // produced a probe that was entirely green, one check per fixture.
      //
      // That is the same failure the header records for the FIRST version of
      // this probe — "would have reported a clean pass forever while testing
      // nothing" — reintroduced by the control flow rather than by the target.
      //
      // Every fixture is documented as a shape attach has to survive, so the bar
      // is all of them. If one legitimately cannot be attached, this fails and
      // someone writes down why, which is the outcome worth having.
      t.ok(
        rewritten === FIXTURES.length,
        `attach ran and rewrote all ${FIXTURES.length} fixtures`,
        rewritten === FIXTURES.length
          ? { actual: `${rewritten}/${FIXTURES.length}` }
          : {
              expected: `${FIXTURES.length} rewritten — every fixture here is a shape attach must survive`,
              actual: `${rewritten}/${FIXTURES.length}. The rest exited non-zero without touching the file, so their assertions never ran and this probe would otherwise be green having checked almost nothing`,
            },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
};
