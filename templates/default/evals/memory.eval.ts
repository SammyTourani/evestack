import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

/**
 * Guards the bug that made memory silently useless: an IVFFlat index built on
 * an empty table returns zero rows once the planner picks it, so `recall` would
 * answer "nothing found" while the row sat right there. This eval fails if that
 * ever regresses, because it asserts on the recalled value rather than on the
 * tool merely having been called.
 */
export default defineEval({
  description: "A fact saved with `remember` comes back through `recall` in a later turn.",
  async test(t) {
    // A project codename, not a "passphrase" or "secret". An earlier draft used
    // the latter and the model refused outright — "I can't retrieve or reveal
    // secrets" — failing the eval for a reason that had nothing to do with
    // memory. The value under test has to be something a model will happily
    // store and repeat.
    const token = "violet-hexagon-4417";

    await t.send(
      `Use your remember tool to save this exact fact: my project codename is ${token}.`,
    );
    t.succeeded();
    t.calledTool("remember");

    await t.send("Use your recall tool to look up my project codename, then tell me what it is.");
    t.succeeded();
    t.calledTool("recall");
    t.check(t.reply, includes(token));
  },
});
