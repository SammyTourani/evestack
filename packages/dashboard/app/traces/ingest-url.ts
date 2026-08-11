/**
 * The ingest endpoint, as the person reading this page would have to type it.
 *
 * ── the bug this closes ──────────────────────────────────────────────────────
 *
 * The /traces empty state printed
 *
 *     EVESTACK_DASHBOARD_URL=http://localhost:4000/api/ingest/v1/traces
 *
 * as a literal, and 4000 is a guess. `create-evestack` picks the first free
 * port at or after 4000, so a second project on the same machine is scaffolded
 * on 4001 and its own `.env.local` says so. Measured on such a project: the
 * empty state told the reader to overwrite a correct `EVESTACK_DASHBOARD_URL`
 * with one pointing at a port this dashboard is not published on.
 *
 * That is worse than a page saying nothing. This is the page you are looking at
 * PRECISELY BECAUSE spans are not arriving, and following its instruction is
 * what keeps them from arriving — the exporter then posts into a closed port,
 * or worse, into a DIFFERENT project's dashboard that happens to hold 4000.
 *
 * ── why the Host header and not a variable ───────────────────────────────────
 *
 * There is no variable to read. `EVESTACK_DASHBOARD_URL` is the AGENT's name for
 * this endpoint and the dashboard is not given it. Inside the shipped container
 * the process always listens on 4000 and knows nothing about the host port it
 * was published on — `DASHBOARD_PORT` is interpolated by Compose on the host and
 * never reaches the container. The only thing in the process that knows the
 * address this dashboard actually answers on is the request that just arrived,
 * because the browser reached it at exactly that address.
 *
 * `app/sessions/page.tsx` solves the mirror-image problem with
 * `agentUrlForHumans()` — the same principle, applied to the address of the
 * OTHER process, which the dashboard is configured with. This page was the one
 * that used neither mechanism.
 *
 * Pure and synchronous, taking the two header values rather than calling
 * `headers()` itself, so it can be tested without a request and so the trace
 * pages stay the server components format.ts's header describes.
 */

/** `@vercel/otel` appends nothing, so the variable must carry the full path. */
export const INGEST_PATH = "/api/ingest/v1/traces";

/**
 * Where the sentence points when the request carried no usable host.
 *
 * A default that is stated as a default. This is reached only by a request with
 * no `Host` header at all or with one that is not a host — neither of which a
 * browser produces — so its job is to be a sane string rather than to be right.
 */
export const FALLBACK_ORIGIN = "http://localhost:4000";

/**
 * What a `Host` header is allowed to look like before it is printed.
 *
 * Anchored and narrow on purpose: `Host` is attacker-controlled, and this value
 * is rendered into a line the reader is invited to paste into a shell. React
 * escapes it into HTML safely either way, but "safe to render" and "sensible to
 * copy" are different bars, and a value that is not a hostname clears neither.
 * Anything unrecognised falls back rather than being sanitised — a half-cleaned
 * host is a host somebody still pastes.
 *
 * Two forms, which is every form a `Host` header has: `name[:port]`, and an
 * IPv6 literal in brackets, `[::1][:port]`.
 */
const HOST = /^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;

/**
 * Addresses that are correct for a listener and useless as a destination.
 *
 * `0.0.0.0` means "every interface" to a server and is not a name a client can
 * connect to; `host.docker.internal` resolves inside a container and nowhere
 * else. Either can arrive here — the first from somebody typing it into a
 * browser, the second from a container-to-container request — and both would
 * be pasted into a terminal on the host, where they do not work.
 *
 * The host COMPONENT is compared, never a substring: `host.docker.internal.example`
 * is somebody else's domain and is left exactly as it arrived. `lib/agent-client.ts`
 * makes the same rewrite for the same reason, and its test pins that case.
 */
const UNREACHABLE = new Set(["0.0.0.0", "host.docker.internal"]);

/**
 * The scheme, from `x-forwarded-proto` when a proxy set one.
 *
 * A proxy may append rather than replace, so the value can be a list
 * (`https, http`); the first entry is the scheme the client used. Anything that
 * is not one of the two schemes this dashboard is ever served over is ignored
 * rather than passed through, because the result is a URL somebody pastes.
 */
function scheme(forwardedProto: string | null | undefined): string {
  const first = (forwardedProto ?? "").split(",")[0]?.trim().toLowerCase();
  return first === "https" || first === "http" ? first : "http";
}

export function ingestOriginForHumans(
  host: string | null | undefined,
  forwardedProto?: string | null,
): string {
  const raw = (host ?? "").trim();
  if (!HOST.test(raw)) return FALLBACK_ORIGIN;

  // Split at the LAST colon so an IPv6 literal keeps its own.
  const portAt = raw.lastIndexOf(":");
  const bracketed = raw.endsWith("]");
  const name = !bracketed && portAt > 0 ? raw.slice(0, portAt) : raw;
  const port = !bracketed && portAt > 0 ? raw.slice(portAt) : "";
  const usable = UNREACHABLE.has(name.toLowerCase()) ? `localhost${port}` : raw;

  return `${scheme(forwardedProto)}://${usable}`;
}
