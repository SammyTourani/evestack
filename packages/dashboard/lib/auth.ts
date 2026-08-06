import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Session auth for the whole dashboard.
 *
 * WHY THIS EXISTS. Until this file, nothing in the dashboard checked a
 * credential — not one route handler, and no middleware. `POST
 * /api/control/sessions` started an agent run, `/api/control/sessions/:id/fork`
 * replayed a conversation and re-executed its tools, `/api/control/sessions/:id/approve`
 * approved a gated shell command, and `DELETE /api/memories/:id` deleted a
 * belief — all for anyone who could open port 4000, which the Dockerfile binds
 * on 0.0.0.0. The reads were no better: the approval audit log ships IPs and
 * user-agents, `/api/skills/:name` returns file bodies read off disk, and
 * `GET /api/evals/promote/:id` replays real user messages out of the durable
 * log. "Self-hosted" is not a security boundary; a credential is.
 *
 * WHICH CREDENTIAL. `create-evestack` already generates EVESTACK_AUTH_USER and
 * EVESTACK_AUTH_PASSWORD for the agent, and lib/agent-client.ts already sends
 * them onward as Basic. Reusing that pair means a scaffolded project is secure
 * with no extra setup step, and a deployment has exactly one secret to rotate
 * rather than two that drift apart.
 *
 * SHAPE. A signed cookie, not Basic-only: a browser cannot sign out of Basic,
 * and every request re-sending the password is a worse habit than one that
 * carries a signature. Basic is still accepted so `curl -u` and CI keep
 * working. The signature is an HMAC from `node:crypto`, not a JWT library —
 * this package's whole claim is that it runs with almost no dependencies, and
 * a 60-line HMAC that only this process verifies has no algorithm-confusion
 * surface to get wrong.
 *
 * FAIL CLOSED. With EVESTACK_AUTH_PASSWORD unset the dashboard refuses every
 * request rather than serving one. There is deliberately no bypass flag: an
 * escape hatch here is the thing people set once during setup and never unset,
 * and eve itself fails closed on every request including loopback. The 503 body
 * names the two variables to set, so the failure is self-diagnosing.
 */

/** Cookie name. Prefixed nothing fancy — `__Host-` would forbid plain http, and
 * the common deployment is http://localhost:4000. */
export const SESSION_COOKIE = "evestack_session";

/** Where an OTLP exporter puts the ingest shared secret. See app/api/ingest/README.md. */
export const INGEST_TOKEN_HEADER = "x-evestack-ingest-token";

/** Shared by proxy.ts and the route itself, so an exporter author who reads the
 * 401 in one place never sees a different story in the other. */
export const INGEST_UNAUTHENTICATED_MESSAGE =
  "trace ingest requires a credential: send EVESTACK_INGEST_TOKEN in the " +
  `${INGEST_TOKEN_HEADER} header (OTLPHttpJsonTraceExporter takes \`headers\`, and ` +
  "OTEL_EXPORTER_OTLP_HEADERS works for any other SDK), or sign in. Nothing was stored.";

/**
 * Bumping this invalidates every issued cookie, which is the point: it is part
 * of the signed material, so an old cookie cannot be replayed against new
 * semantics.
 */
const COOKIE_VERSION = "v1";

/** Seven days. Long enough that a dashboard left open overnight still works,
 * short enough that a stolen cookie is not a permanent grant. */
const DEFAULT_TTL_HOURS = 168;

export const UNCONFIGURED_MESSAGE =
  "This dashboard has no credentials configured, so it is refusing every request. " +
  "Set EVESTACK_AUTH_USER and EVESTACK_AUTH_PASSWORD (the same pair the agent uses — " +
  "`create-evestack` generates them) and restart. Running without them would leave " +
  "every route, including the ones that start agent runs and approve tool calls, open " +
  "to anyone who can reach this port.";

export interface Credentials {
  readonly user: string;
  readonly password: string;
}

/**
 * How a request proved who it is.
 *
 * `session` and `basic` both prove possession of the one deployment credential —
 * they identify an installation, not a person. `forwarded-*` and `header` name a
 * person but only as well as the proxy in front of us does. Nothing here is
 * allowed to look like more than it is; see identifyApprover in lib/approvals.ts.
 */
export type AuthVia = "session" | "basic";

export interface AuthenticatedRequest {
  readonly user: string;
  readonly via: AuthVia;
}

/**
 * Which door a path goes through. Default-deny is the whole design: `tierFor`
 * returns "session" for anything it does not recognise, so a route added
 * tomorrow is protected before its author thinks about auth, and a typo'd path
 * lands in the strictest tier rather than the loosest.
 */
export type RouteTier = "liveness" | "sign-in" | "ingest" | "session";

/** Exact paths, never prefixes. `/api/health` is public; `/api/health/detail` is not. */
const PUBLIC_PATHS = new Set(["/signin", "/api/auth/session", "/api/auth/signout"]);
const LIVENESS_PATH = "/api/health";
const INGEST_PATH = "/api/ingest/v1/traces";

export function tierFor(pathname: string): RouteTier {
  const path = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  if (path === LIVENESS_PATH) return "liveness";
  if (PUBLIC_PATHS.has(path)) return "sign-in";
  if (path === INGEST_PATH) return "ingest";
  return "session";
}

/* -------------------------------------------------------------------------- */
/* configuration                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Both variables are required, and the user is deliberately not defaulted to
 * "evestack".
 *
 * `authHeader()` in lib/agent-client.ts attaches Basic to agent calls only when
 * both are set. Defaulting the user here would let a deployment that sets only
 * the password sign in happily while every control route failed against a built
 * agent with a 401 nothing in the dashboard could explain. One rule for both
 * halves of the same credential.
 */
export function credentials(): Credentials | null {
  const user = process.env.EVESTACK_AUTH_USER?.trim();
  const password = process.env.EVESTACK_AUTH_PASSWORD;
  // A blank password is not a password. An empty string would otherwise
  // authenticate every request that guesses "" — the exact failure this file
  // exists to remove.
  if (!user || !password) return null;
  return { user, password };
}

export function authConfigured(): boolean {
  return credentials() !== null;
}

function ttlSeconds(): number {
  const raw = Number(process.env.EVESTACK_SESSION_TTL_HOURS);
  if (Number.isFinite(raw) && raw > 0 && raw <= 24 * 365) return Math.round(raw * 3600);
  return DEFAULT_TTL_HOURS * 3600;
}

/**
 * The signing key.
 *
 * Derived from the password by default rather than stored separately, so that
 * changing the password invalidates every outstanding cookie — which is what a
 * password change is for, and what a separate random secret would silently fail
 * to do. EVESTACK_SESSION_SECRET overrides it when you want to rotate sessions
 * without rotating the password the agent also uses, or when several dashboard
 * replicas must accept each other's cookies.
 */
function signingKey(config: Credentials): Buffer {
  // The NUL between the two halves is domain separation, not decoration: joined
  // with nothing, ("ab", "c") and ("a", "bc") would derive the same key, and a
  // separator that cannot appear in an environment variable is the one that
  // cannot be engineered into a collision.
  const material =
    process.env.EVESTACK_SESSION_SECRET?.trim() || `${config.user}\u0000${config.password}`;
  return createHmac("sha256", material).update("evestack-dashboard-session-v1").digest();
}

/* -------------------------------------------------------------------------- */
/* constant-time comparison                                                    */
/* -------------------------------------------------------------------------- */

/**
 * `timingSafeEqual` throws on length mismatch, and the lengths of a password
 * and a guess are exactly what we must not leak. Hashing both first gives two
 * 32-byte buffers, so the comparison is always the same shape.
 */
function equalsConstantTime(a: string, b: string): boolean {
  const left = createHash("sha256").update(a, "utf8").digest();
  const right = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(left, right);
}

/** Both halves are always compared — short-circuiting on the user would say
 * which of the two was wrong. */
export function verifyCredentials(user: string, password: string): boolean {
  const config = credentials();
  if (!config) return false;
  const userOk = equalsConstantTime(user, config.user);
  const passwordOk = equalsConstantTime(password, config.password);
  return userOk && passwordOk;
}

/* -------------------------------------------------------------------------- */
/* the session cookie                                                          */
/* -------------------------------------------------------------------------- */

interface SessionPayload {
  /** The user the cookie was issued to. Also covered by the signature. */
  readonly u: string;
  readonly iat: number;
  readonly exp: number;
}

export interface IssuedSession {
  readonly value: string;
  readonly maxAgeSeconds: number;
}

/** `v1.<base64url payload>.<base64url hmac>` — the signature covers the version
 * and the payload, so neither can be swapped without detection. */
export function issueSession(user: string): IssuedSession | null {
  const config = credentials();
  if (!config) return null;

  const maxAgeSeconds = ttlSeconds();
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = { u: user, iat: now, exp: now + maxAgeSeconds };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = sign(config, encoded);

  return { value: `${COOKIE_VERSION}.${encoded}.${signature}`, maxAgeSeconds };
}

function sign(config: Credentials, encodedPayload: string): string {
  return createHmac("sha256", signingKey(config))
    .update(`${COOKIE_VERSION}.${encodedPayload}`)
    .digest("base64url");
}

/** Returns the user the cookie names, or null for anything that is not a
 * currently valid cookie issued by this deployment. */
export function verifySessionCookie(raw: string | null | undefined): string | null {
  const config = credentials();
  if (!config || !raw) return null;

  const parts = raw.split(".");
  if (parts.length !== 3) return null;
  const [version, encoded, signature] = parts;
  if (version !== COOKIE_VERSION || !encoded || !signature) return null;

  const expected = sign(config, encoded);
  // Compare before parsing. Feeding an unverified payload to JSON.parse is how
  // a signature check ends up running after the thing it was protecting.
  if (signature.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(signature, "utf8"), Buffer.from(expected, "utf8"))) return null;

  let payload: SessionPayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as SessionPayload;
  } catch {
    return null;
  }

  if (typeof payload?.u !== "string" || typeof payload?.exp !== "number") return null;
  if (payload.exp * 1000 <= Date.now()) return null;
  // The key already changes with the password, so this only catches a renamed
  // user — but an audit row naming a user this deployment no longer has is
  // exactly the kind of stale identity the approvals log must not record.
  if (payload.u !== config.user) return null;

  return payload.u;
}

/* -------------------------------------------------------------------------- */
/* reading a request                                                           */
/* -------------------------------------------------------------------------- */

/** Parsed by hand rather than through NextRequest.cookies, so route handlers,
 * lib/approvals.ts and the proxy can all call this with a plain `Request`. */
export function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

/**
 * The username from an `Authorization: Basic` header **whose password we
 * checked**.
 *
 * The distinction matters: the previous code read the username out of this
 * header without ever verifying the password, so `curl -H 'Authorization: Basic
 * <base64 of "ceo@example.com:">'` stamped that name on an approval. Anything
 * this function returns has proven possession of the deployment credential.
 */
export function verifyBasic(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header || !/^Basic /i.test(header)) return null;

  let decoded: string;
  try {
    decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
  } catch {
    return null;
  }
  const separator = decoded.indexOf(":");
  if (separator < 0) return null;

  const user = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);
  return verifyCredentials(user, password) ? user : null;
}

/** The one function every gate calls: cookie or verified Basic, nothing else. */
export function authenticate(request: Request): AuthenticatedRequest | null {
  const fromBasic = verifyBasic(request);
  if (fromBasic !== null) return { user: fromBasic, via: "basic" };

  const fromCookie = verifySessionCookie(cookieValue(request, SESSION_COOKIE));
  if (fromCookie !== null) return { user: fromCookie, via: "session" };

  return null;
}

/* -------------------------------------------------------------------------- */
/* trace ingest                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Trace ingest is the one route a signed-in human is not the caller for, so it
 * gets its own credential.
 *
 * The old comment on that route claimed an exporter "has nowhere to put a
 * credential, which is exactly why the dashboard binds to 127.0.0.1". Both
 * halves were wrong: the Dockerfile binds 0.0.0.0, and every OTLP exporter
 * takes custom headers (`headers:` on OTLPHttpJsonTraceExporter,
 * OTEL_EXPORTER_OTLP_HEADERS for anything else). So it takes a shared secret
 * in a header, and with EVESTACK_INGEST_TOKEN unset it falls back to ordinary
 * session auth rather than to nothing.
 *
 * Loopback-only was considered and rejected: nothing inside a Next route can
 * see the peer address, and Host / X-Forwarded-For are both client-controlled,
 * so a "loopback only" check here would be a comment rather than a control.
 */
export function ingestAuthorized(request: Request): boolean {
  const token = process.env.EVESTACK_INGEST_TOKEN?.trim();
  if (token) {
    const presented = request.headers.get(INGEST_TOKEN_HEADER)?.trim() ?? bearerToken(request);
    if (presented && equalsConstantTime(presented, token)) return true;
  }
  return authenticate(request) !== null;
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header || !/^Bearer /i.test(header)) return null;
  return header.slice(7).trim() || null;
}

/* -------------------------------------------------------------------------- */
/* trusted proxy                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Whether X-Forwarded-User / X-Forwarded-Email / EVESTACK_APPROVER_HEADER may
 * be believed on this request.
 *
 * Off unless EVESTACK_TRUSTED_PROXY is set, because those headers are three
 * words of curl away from anyone who can reach the port, and an audit log that
 * can be dictated to is worse than one that admits it knows nothing.
 *
 * Accepted values:
 *   1 | true | *        a proxy you control terminates every request and strips
 *                       inbound X-Forwarded-* headers. That stripping is the
 *                       real control; this variable only records that you did it.
 *   <ip>[,<ip|cidr>…]   additionally require the nearest hop to be one of these.
 *
 * The list form narrows the blast radius and is honestly weaker than it looks:
 * the nearest hop is read from the right-most X-Forwarded-For entry, which is
 * appended by the closest proxy, and a direct caller can spell out an entire
 * header. It is a second lock on a door whose first lock is the proxy stripping
 * client-supplied headers. Never treat it as a substitute for that.
 */
export function trustsForwardedIdentity(request: Request): boolean {
  const raw = process.env.EVESTACK_TRUSTED_PROXY?.trim();
  if (!raw) return false;

  const lowered = raw.toLowerCase();
  if (lowered === "0" || lowered === "false" || lowered === "off" || lowered === "no") return false;
  if (lowered === "1" || lowered === "true" || lowered === "*" || lowered === "all") return true;

  const hop = nearestHop(request);
  if (!hop) return false;
  return raw.split(",").some((entry) => matchesAddress(hop, entry.trim()));
}

/** The right-most X-Forwarded-For entry: the address the closest proxy added. */
function nearestHop(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for");
  if (!forwarded) return null;
  const entries = forwarded.split(",").map((entry) => normalizeAddress(entry));
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]) return entries[index]!;
  }
  return null;
}

/** Strips brackets, a trailing `:port`, and the IPv4-mapped IPv6 prefix, so
 * `[::ffff:172.19.0.2]:41234` and `172.19.0.2` compare equal. */
function normalizeAddress(raw: string): string {
  let value = raw.trim();
  if (value.startsWith("[")) {
    const close = value.indexOf("]");
    value = close < 0 ? value.slice(1) : value.slice(1, close);
  }
  // Only strip a port from `host:port`; a bare IPv6 address is full of colons.
  const colon = value.indexOf(":");
  if (colon > 0 && value.indexOf(":", colon + 1) < 0) value = value.slice(0, colon);
  if (value.toLowerCase().startsWith("::ffff:")) value = value.slice(7);
  return value;
}

/** Exact match for any address family; CIDR for IPv4, which is what a Docker
 * bridge network hands you (`172.16.0.0/12`). */
function matchesAddress(address: string, pattern: string): boolean {
  if (!pattern) return false;
  if (pattern === address) return true;

  const slash = pattern.indexOf("/");
  if (slash < 0) return false;

  const bits = Number(pattern.slice(slash + 1));
  const network = toIpv4(pattern.slice(0, slash));
  const candidate = toIpv4(address);
  if (network === null || candidate === null) return false;
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  if (bits === 0) return true;

  const mask = bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0;
  return ((network & mask) >>> 0) === ((candidate & mask) >>> 0);
}

function toIpv4(value: string): number | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    out = ((out << 8) | octet) >>> 0;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* request provenance                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Cross-site write protection.
 *
 * Adding a cookie added a CSRF surface that did not exist while every route was
 * open: `readJsonObject` in app/api/control/_http.ts reads the body as text, so
 * a cross-origin form posting `text/plain` containing JSON is a CORS-simple
 * request that would otherwise ride the operator's cookie into
 * `/api/control/sessions`. SameSite=Lax on the cookie already stops that; this
 * is the second lock, and it is the same test app/integrations/connect/route.ts
 * settled on: same-origin, or no Origin at all (curl, an OTLP exporter).
 * `Sec-Fetch-Site` is set by every current browser and cannot be set from script.
 */
export function isCrossSiteWrite(request: Request): boolean {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false;

  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") return true;

  const origin = request.headers.get("origin");
  if (!origin) return false;

  const sent = URL.parse(origin);
  if (!sent) return true;

  // Hosts, not full origins. Behind TLS termination the browser sends
  // `Origin: https://evestack.example.com` while the request arrives over plain
  // http, and comparing schemes would 403 every write on a correctly configured
  // deployment. Host equality is what CSRF turns on anyway: an attacker's page
  // cannot forge the Origin header, and a same-host attacker is already inside
  // the boundary this is defending.
  //
  // The comparison is against the HOST HEADER, not `new URL(request.url).host`.
  // That distinction was the whole bug: Next builds `request.url` in the proxy
  // from the address the server is BOUND to, and the container runs
  // `next start --hostname 0.0.0.0`, so `request.url.host` was literally
  // `0.0.0.0:4000` — a value no browser will ever send as an Origin. Every
  // write from a browser 403'd, sign-in included, so the shipped dashboard
  // could not be logged into at all. Nothing caught it because curl sends no
  // Origin and takes the early return above.
  //
  // Host is the right side of the comparison on its own merits: it is the name
  // the browser dialled, so `Origin.host === Host` IS the same-origin test. It
  // is attacker-supplied, but not by the attacker who matters here — a page on
  // evil.com cannot change the Host the victim's browser sends to us, and
  // cannot set Origin at all.
  const allowed = new Set<string>();
  for (const host of expectedHosts(request)) allowed.add(host);
  const configured = process.env.EVESTACK_PUBLIC_URL?.trim();
  if (configured) {
    const parsed = URL.parse(configured);
    if (parsed) allowed.add(parsed.host);
  }
  return !allowed.has(sent.host);
}

/**
 * The host names a browser could legitimately have used to reach this request.
 *
 * `X-Forwarded-Host` is believed only behind a declared trusted proxy, the same
 * rule the identity headers follow — otherwise a forged header would name its
 * own origin as allowed and disable the check it is part of.
 *
 * The bind address from `request.url` is kept as a last resort for a runtime
 * that presents no Host header at all (HTTP/1.0, some test harnesses). It is
 * last, and it is never the only reason a browser Origin is accepted in a real
 * deployment, because real browsers always send Host.
 */
function expectedHosts(request: Request): string[] {
  const hosts: string[] = [];

  if (trustsForwardedIdentity(request)) {
    const forwarded = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
    if (forwarded) hosts.push(forwarded.toLowerCase());
  }

  const host = request.headers.get("host")?.trim();
  if (host) {
    hosts.push(host.toLowerCase());
    // Deliberately no bind-address fallback once Host is present. Adding it
    // would put `0.0.0.0:4000` back on the allow-list permanently, which is the
    // state this function is being fixed out of.
    return hosts;
  }

  const parsed = URL.parse(request.url);
  if (parsed?.host) hosts.push(parsed.host.toLowerCase());

  return hosts;
}

/**
 * Where to send someone after they sign in.
 *
 * `//evil.example` and `/\evil.example` are both read as protocol-relative URLs
 * by browsers, so "starts with a slash" is not enough to keep a redirect local.
 */
export function safeNextPath(raw: string | null | undefined): string {
  if (!raw) return "/";
  if (!raw.startsWith("/")) return "/";
  if (raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  // Bouncing back to the sign-in page after signing in is a loop, not a
  // destination.
  if (raw === "/signin" || raw.startsWith("/signin?")) return "/";
  return raw;
}

/**
 * Whether the cookie should carry `Secure`.
 *
 * X-Forwarded-Proto is only believed behind a declared trusted proxy, for the
 * same reason the identity headers are: otherwise a forged header could mark
 * the cookie Secure on a plain-http deployment and lock the operator out of
 * their own dashboard.
 */
export function isSecureRequest(request: Request): boolean {
  if (new URL(request.url).protocol === "https:") return true;
  if (process.env.EVESTACK_PUBLIC_URL?.trim().toLowerCase().startsWith("https://")) return true;
  if (trustsForwardedIdentity(request)) {
    const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
    if (proto === "https") return true;
  }
  return false;
}
