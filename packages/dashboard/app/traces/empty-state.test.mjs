/**
 * The setup instructions on /traces, and the port they used to guess.
 *
 * This page is only ever read when traces are NOT arriving, which makes a wrong
 * line on it uniquely expensive: the reader is here because something is
 * misconfigured and this is the page they trust to say what. It printed
 * `http://localhost:4000/api/ingest/v1/traces` as a literal, and 4000 is a
 * guess — the scaffolder takes the first free port at or after 4000, so a
 * second project on the same machine is published on 4001 and told to overwrite
 * a correct `EVESTACK_DASHBOARD_URL` with one pointing somewhere else.
 *
 * Colocated with the code rather than in ../../test, because it needs a `.css`
 * load hook that nothing else in the suite wants: the component imports its CSS
 * module, and `node --test` has no opinion about `.css`. The hook is registered
 * here, before ui-render.mjs is imported, and is why every import below is
 * dynamic — a static import is hoisted above the registration and would load
 * the stylesheet before there was anything to load it with.
 */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith(".css")) return nextLoad(url, context);
    // Every class name resolves to itself, which is what a CSS-module loader
    // does in development anyway — so an assertion can name a class if it ever
    // needs to, and a typo'd one is still visibly a typo in the markup.
    return {
      format: "module",
      shortCircuit: true,
      source: "export default new Proxy({}, { get: (_, key) => (typeof key === 'string' ? key : undefined) });",
    };
  },
});

const { contains, omits, render } = await import("../../test/ui-render.mjs");
const { NoSpans } = await import("./empty-state.tsx");
const { FALLBACK_ORIGIN, INGEST_PATH, ingestOriginForHumans } = await import("./ingest-url.ts");

/* -------------------------------------------------------------------------- */
/* the derivation                                                              */
/* -------------------------------------------------------------------------- */

test("the port the browser used is the port the instruction names", () => {
  // The measured case: a project scaffolded second, published on 4001, whose
  // own .env.local already said 4001 and whose /traces page said 4000.
  assert.equal(ingestOriginForHumans("localhost:4001"), "http://localhost:4001");
  assert.equal(ingestOriginForHumans("127.0.0.1:4044"), "http://127.0.0.1:4044");
  // No port in the Host header means port 80, and saying `:80` would be wrong.
  assert.equal(ingestOriginForHumans("dash.example.com"), "http://dash.example.com");
});

test("a proxy's scheme is honoured, and only if it is a scheme", () => {
  assert.equal(ingestOriginForHumans("dash.example.com", "https"), "https://dash.example.com");
  // Proxies chain, and some append rather than replace. The first entry is the
  // one the client used.
  assert.equal(ingestOriginForHumans("dash.example.com", "https, http"), "https://dash.example.com");
  assert.equal(ingestOriginForHumans("dash.example.com", "HTTPS"), "https://dash.example.com");
  // Not a scheme this dashboard is ever served over: ignored, not passed on.
  assert.equal(ingestOriginForHumans("dash.example.com", "javascript"), "http://dash.example.com");
  assert.equal(ingestOriginForHumans("dash.example.com", ""), "http://dash.example.com");
});

test("an address that is not a destination becomes one, port intact", () => {
  // `0.0.0.0` is where a server listens, not somewhere a client connects, and
  // `host.docker.internal` resolves in a container and nowhere else. Both would
  // be pasted into a shell on the host. lib/agent-client.ts rewrites the same
  // two for the same reason.
  assert.equal(ingestOriginForHumans("0.0.0.0:4001"), "http://localhost:4001");
  assert.equal(ingestOriginForHumans("host.docker.internal:4000"), "http://localhost:4000");
  // The host COMPONENT, never a substring: this is somebody else's domain.
  assert.equal(
    ingestOriginForHumans("host.docker.internal.evil.example:4000"),
    "http://host.docker.internal.evil.example:4000",
  );
});

test("an IPv6 literal keeps its brackets and does not lose its port", () => {
  assert.equal(ingestOriginForHumans("[::1]:4001"), "http://[::1]:4001");
  assert.equal(ingestOriginForHumans("[::1]"), "http://[::1]");
});

test("a Host that is not a host is refused rather than cleaned up", () => {
  // `Host` is attacker-controlled and the result is a line the reader is invited
  // to paste into a shell. A half-sanitised host is a host somebody still pastes,
  // so anything unrecognised falls back to a stated default instead.
  for (const hostile of [
    "evil.example/../../etc/passwd",
    "evil.example a; rm -rf /",
    "local host:4000",
    "localhost:4000/api",
    "javascript:alert(1)",
    "",
    "   ",
    null,
    undefined,
  ]) {
    assert.equal(
      ingestOriginForHumans(hostile),
      FALLBACK_ORIGIN,
      `${JSON.stringify(hostile)} was not refused`,
    );
  }
});

/* -------------------------------------------------------------------------- */
/* the rendered page                                                           */
/* -------------------------------------------------------------------------- */

test("the empty state prints the address it was given and no other", () => {
  const markup = render(NoSpans, { origin: "http://localhost:4001" });

  contains(
    markup,
    `EVESTACK_DASHBOARD_URL=http://localhost:4001${INGEST_PATH}`,
    "the instruction does not name this dashboard's address",
  );
  // The whole defect, asserted directly: the page must not name a port it
  // guessed. This is what goes red if the literal ever comes back.
  omits(markup, "localhost:4000", "the empty state hardcodes a port again");
});

test("the ingest path is the full path, because the exporter appends nothing", () => {
  const markup = render(NoSpans, { origin: "https://dash.example.com" });
  contains(markup, `EVESTACK_DASHBOARD_URL=https://dash.example.com${INGEST_PATH}`);
  // The two claims the line depends on, still on the page beside it.
  contains(markup, "appends nothing");
  contains(markup, "EVESTACK_INGEST_TOKEN");
});
