import { defineEval } from "eve/evals";

export default defineEval({
  description: "The agent boots, accepts a request, and answers — the whole stack in one check.",
  tags: ["fast"],
  async test(t) {
    await t.send("Reply with exactly the word: ready");
    t.succeeded();
  },
});
