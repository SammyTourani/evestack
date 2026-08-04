import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

export default defineEval({
  description: "The Docker sandbox is real: bash runs and its output reaches the reply.",
  async test(t) {
    // A nonsense token rather than something like `uname`, so a model that
    // answers from prior knowledge instead of executing cannot pass by luck.
    await t.send(
      "Run this exact bash command in your sandbox and report its output verbatim: " +
        "echo evestack-7fa1c3-ok",
    );
    t.succeeded();
    t.calledTool("bash");
    t.check(t.reply, includes("evestack-7fa1c3-ok"));
  },
});
