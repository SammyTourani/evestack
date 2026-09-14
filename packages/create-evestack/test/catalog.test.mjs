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

import {
  fetchRegistry, gated, loadCatalog, needsBadge, summarise,
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
