import { defineEvalConfig } from "eve/evals";

/**
 * No external reporter is configured on purpose. Braintrust and friends are
 * fine, but evestack's premise is a stack that runs with nothing phoning home,
 * and a default that quietly ships transcripts off the machine would break it.
 * Artifacts land in .eve/evals/<timestamp>/ instead.
 */
export default defineEvalConfig({
  // Cold start pays for a Docker sandbox, a Postgres connection, and a real
  // model round trip, so the stock timeout is too tight for honest runs.
  timeoutMs: 120_000,
});
