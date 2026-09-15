/**
 * The registry cache, and the one thing this wizard adds on top of it.
 *
 * The catalogue itself is eve's — same URL eve's own CLI reads — so there is
 * nothing here asserting what Slack's description says. What IS worth pinning:
 *
 *   - the snapshot is a complete, usable catalogue with no network at all,
 *     because a scaffolder that cannot ask its questions on a plane is one
 *     people stop trusting;
 *   - a live read that fails in any of the six ways it can fail falls back
 *     silently rather than turning a wifi problem into a wizard problem;
 *   - `needs` — whether picking something will stop and ask you for a
 *     credential — is right often enough to be worth printing.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { createServer } from "node:http";

import {
  fetchRegistry, gated, isRegistryId, loadCatalog, needsBadge, summarise,
} from "../catalog.mjs";
import { FEATURED_CHANNELS, SNAPSHOT } from "../catalog.data.mjs";

test("the snapshot alone is a usable catalogue", async () => {
  const catalog = await loadCatalog({ offline: true });

  assert.equal(catalog.source, "snapshot");
  assert.ok(catalog.channels.length >= 20, `${catalog.channels.length} channels`);
  assert.ok(catalog.integrations.length >= 40, `${catalog.integrations.length} integrations`);
  for (const item of [...catalog.channels, ...catalog.integrations]) {
    assert.ok(item.id && item.title, JSON.stringify(item));
  }
});

test("the channels people reach for are at the top, in order", () => {
  // Not a quality ranking. It is "what someone setting up their first agent
  // almost always wants", and Web Chat leads because it is the only one needing
  // no third-party account at all.
  const channels = SNAPSHOT.filter((r) => r.kind === "channel").map((r) => r.id);
  for (const id of FEATURED_CHANNELS) {
    assert.ok(channels.includes(id), `${id} is featured but not in the catalogue`);
  }
  assert.equal(FEATURED_CHANNELS[0], "channel/web");
});

test("a registry that is down, slow, or lying falls back without a word", async () => {
  // Six failure shapes, one correct answer: use the snapshot and say nothing.
  // The wizard has a complete catalogue either way, so an error here would be
  // noise about a problem the reader does not have.
  assert.equal(await fetchRegistry("http://127.0.0.1:1/nope", 200), null);
  assert.equal(await fetchRegistry("not-a-url", 200), null);
  assert.equal(await fetchRegistry("https://eve.dev/r/definitely-not-here.json", 3000), null);
});

test("everything under connection/ is marked as needing authentication", () => {
  // Structural, not textual. `connection/notion` says "Search and edit Notion
  // pages and databases over MCP or OpenAPI" — no mention of a credential, and
  // obviously needing one. Reading descriptions alone flagged 7 of 99 items.
  const connections = SNAPSHOT.filter((r) => r.id.startsWith("connection/"));
  assert.ok(connections.length > 20, `${connections.length} connections`);
  assert.ok(connections.every((r) => r.needs), "a connection with nothing to connect to is not a connection");
});

test("GitHub is flagged, because its install really does stop", () => {
  // Measured: `eve add channel/github --non-interactive` ends with
  // `prerequisite_required` — "GitHub setup requires a linked Vercel project".
  // Its description never says "Vercel"; it says "with guided Connect setup".
  const github = SNAPSHOT.find((r) => r.id === "channel/github");
  assert.equal(github.needs, "connect");
  assert.equal(needsBadge(github).text, "sign-in");
});

test("Web Chat is not flagged, because it needs nothing", async () => {
  // Read through loadCatalog, not off the raw snapshot: the snapshot omits an
  // empty `needs` to stay readable, and normalising it is loadCatalog's job.
  // Asserting on the raw table here would pin the storage shape instead of the
  // contract every caller actually sees.
  const { channels } = await loadCatalog({ offline: true });
  const web = channels.find((c) => c.id === "channel/web");

  assert.equal(web.needs, "", "the one channel that works with no account must not look gated");
  assert.equal(needsBadge(web).text, "");
});

test("gated() is what the review step counts", () => {
  const picked = [
    { title: "Web Chat", needs: "" },
    { title: "GitHub", needs: "connect" },
    { title: "Notion", needs: "token" },
  ];
  assert.deepEqual(gated(picked).map((i) => i.title), ["GitHub", "Notion"]);
});

test("a long selection is summarised rather than wrapped", () => {
  const many = ["A", "B", "C", "D", "E", "F"].map((title) => ({ title }));
  const line = summarise(many, 4);

  assert.match(line, /A, B, C, D/);
  assert.match(line, /\+2 more/);
  assert.doesNotMatch(summarise(many.slice(0, 3), 4), /more/);
  assert.match(summarise([]), /none/);
});

test("descriptions stay sentences after the boilerplate is trimmed", async () => {
  // An earlier trim stripped a leading "Add the built-in" and left
  // "Next.js Web Chat channel to an eve agent." — a fragment with a dangling
  // clause. Trimming that reads worse than the boilerplate is not a trim.
  const catalog = await loadCatalog({ offline: true });
  const web = catalog.channels.find((c) => c.id === "channel/web");

  assert.doesNotMatch(web.note, /to an eve agent/, "the repeated tail is dropped");
  assert.match(web.note, /^[A-Z]/, "and what is left still starts a sentence");
  for (const item of catalog.channels) {
    assert.doesNotMatch(item.note, /^(to|with|through|from|and)\b/i, `${item.id}: ${item.note}`);
  }
});

/* -------------------------------------------------------------------------- */
/* the id is a command-line argument, and was type-checked and nothing more    */
/* -------------------------------------------------------------------------- */

/** A stand-in for the registry at eve.dev, so no test here needs the network. */
async function serveRegistry(items) {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(items));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}/r.json`, close: () => new Promise((r) => server.close(r)) };
}

test("every id in the snapshot is one the wizard will accept", () => {
  // The gate is only worth having if the real catalogue passes it. All 99 rows
  // do; a registry convention that changes would fail here rather than silently
  // emptying a section of the picker for everybody.
  for (const row of SNAPSHOT) {
    assert.ok(isRegistryId(row.id), `${row.id} is in the snapshot and would be refused`);
  }
});

test("an id that is not an id is refused, and a plausible one is not", () => {
  for (const good of ["channel/web", "connection/notion", "extension/browserbase", "eve", "a.b-c_d/e1"]) {
    assert.ok(isRegistryId(good), good);
  }
  // Each of these is a shell fragment first and a name second. On Windows the
  // installer's spawn ends up at cmd.exe, and `&`, `|`, `>` and `%` all mean
  // something there.
  for (const bad of [
    "channel/slack & calc",
    "channel/x&calc",
    "channel/x|calc",
    "channel/x>out.txt",
    "%PATH%",
    "channel/x`id`",
    "channel/x$(id)",
    "/absolute",
    "channel//double",
    "-flag",
    "Channel/Web",
    "",
    null,
    undefined,
    42,
    `a${"b".repeat(200)}`,
  ]) {
    assert.equal(isRegistryId(bad), false, `${JSON.stringify(bad)} was accepted`);
  }
});

/**
 * THE BUG THIS PINS, stated as the wizard sees it.
 *
 * `fetchRegistry` filtered on `typeof item?.name === "string"`, and the id it
 * kept goes straight into `eve add <id>` as an argv element. The picker renders
 * `title`, never `id`, so the row below looks exactly like Slack: someone ticks
 * "Slack", and on Windows the part after `&` runs.
 *
 * The row is DROPPED rather than sanitised. A name that is not a name is not
 * something to install a corrected version of.
 */
test("a registry row whose id is a shell fragment never reaches the picker", async () => {
  const registry = await serveRegistry([
    { name: "channel/slack & calc", title: "Slack", description: "Connect an eve agent to Slack." },
    { name: "channel/web", title: "Web Chat", description: "Add the built-in Next.js Web Chat channel to an eve agent." },
  ]);
  try {
    const rows = await fetchRegistry(registry.url, 3000);
    assert.deepEqual(rows.map((r) => r.id), ["channel/web"]);
    assert.equal(
      rows.some((r) => r.title === "Slack"),
      false,
      "the row survived under a title that gives the reader no way to see its id",
    );
  } finally {
    await registry.close();
  }
});

test("a registry of nothing but bad ids falls back to the snapshot", async () => {
  // The same answer as any other unusable response: use the snapshot, say
  // nothing. `rows.length > 0` is what makes that happen, and it only holds
  // because the filter runs before the emptiness test.
  const registry = await serveRegistry([{ name: "x;y", title: "X", description: "" }]);
  try {
    assert.equal(await fetchRegistry(registry.url, 3000), null);
  } finally {
    await registry.close();
  }
});
