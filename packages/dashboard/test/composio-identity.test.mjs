/**
 * The Composio user id is defined twice, and must never diverge.
 *
 * Composio ties OAuth grants to a user id. The agent resolves it in
 * `@evestack/composio`; the dashboard resolves it in
 * app/integrations/composio.ts. If the two literals ever differ, the dashboard
 * connects accounts under one identity and the agent looks for its tools under
 * another — so the Integrations page shows "connected" for accounts the agent
 * cannot see, which is the worst shape this failure could take: it looks like it
 * worked.
 *
 * The obvious fix is for the dashboard to import the constant. That is
 * deliberately NOT done: `@evestack/composio` depends on `@composio/core` and
 * `@composio/experimental`, and the dashboard's hand-rolled client exists
 * precisely so the dashboard ships no runtime dependency beyond `pg`. Sharing
 * nine characters is not worth that dependency tree.
 *
 * So the constant is duplicated and this test is the seam. It reads both files
 * as text rather than importing either, so it stays free of both dependency
 * graphs and cannot be satisfied by a mock.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");

/** The one spelling both files must use. Read, never assumed. */
function declaredUserId(file) {
  const source = readFileSync(join(repo, file), "utf8");
  const match = source.match(/DEFAULT_COMPOSIO_USER_ID\s*=\s*"([^"]*)"/);
  assert.ok(match, `${file} no longer declares DEFAULT_COMPOSIO_USER_ID as a string literal`);
  return match[1];
}

test("the dashboard and the agent agree on the Composio user id", () => {
  const dashboard = declaredUserId("packages/dashboard/app/integrations/composio.ts");
  const agent = declaredUserId("packages/evestack-composio/src/index.ts");

  assert.equal(
    dashboard,
    agent,
    "the dashboard and @evestack/composio disagree on DEFAULT_COMPOSIO_USER_ID, so the " +
      "dashboard would connect accounts the agent cannot see",
  );
  assert.notEqual(dashboard, "", "an empty user id would group every grant under one anonymous owner");
});

test("the dashboard still avoids importing @evestack/composio", () => {
  // The reason the duplication is allowed. If someone later adds the import,
  // the duplication is no longer justified and this test should be deleted
  // along with it — rather than both being left in place.
  //
  // Matched as an import specifier, not as a substring: the file NAMES
  // @evestack/composio in the comment explaining why it does not import it, and
  // a bare `includes` check fails on that prose. (The redirect-origin contract
  // learned the same lesson the same way.)
  const source = readFileSync(join(repo, "packages/dashboard/app/integrations/composio.ts"), "utf8");
  assert.ok(
    !/(?:from|require\()\s*["']@evestack\/composio["']/.test(source),
    "the dashboard now imports @evestack/composio, so delete this file and import the constant",
  );
  const manifest = JSON.parse(readFileSync(join(repo, "packages/dashboard/package.json"), "utf8"));
  assert.deepEqual(
    Object.keys(manifest.dependencies).filter((d) => d.startsWith("@composio/")),
    [],
    "the dashboard has taken on a @composio/* runtime dependency",
  );
});
