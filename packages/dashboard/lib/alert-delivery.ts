/**
 * Telling someone, rather than waiting to be looked at.
 *
 * `lib/alerts.ts` computes nine monitors and returns them. That is where the
 * feature stopped: the results existed for the length of one render of
 * /monitors and were then discarded. A monitor you have to be watching is a
 * chart with a threshold drawn on it, and the moment you need it is precisely
 * the moment nobody is looking.
 *
 * ── Why this runs in the dashboard and not in the agent ──────────────────────
 *
 * evestack already has a path that reaches a human: the heartbeat schedule wakes
 * the agent on a cron and it posts through a channel (docs/proactive.mdx). That
 * is the obvious place to put this, and it is the wrong one.
 *
 * Three of the nine monitors — `wedged`, `no_spans_while_active`,
 * `turn_failure_rate` — fire exactly when the agent is unwell. Delivering them
 * through the agent's own channel means the alert path shares fate with its
 * subject: the turn that wedges is the turn that would have told you. The
 * dashboard is a separate process, on the same machine, with its own connection
 * to Postgres and its own view of the Docker socket, and it stays up when the
 * agent does not. So the notifier lives here, and it does not call the agent at
 * all.
 *
 * The cost of that choice is stated plainly rather than hidden: if the DASHBOARD
 * is down, nothing is delivered either, and nothing in this file can tell you
 * so. That is a genuine limit of any in-process notifier and the reason the
 * payload carries a `sentAt` — a receiver that cares can alert on silence, which
 * is the one check that has to live outside the thing it watches.
 *
 * ── Transitions, not levels ──────────────────────────────────────────────────
 *
 * Everything below turns on one rule: a message is sent when a monitor CHANGES,
 * not while it is bad. An alerting integration that re-sends every tick is muted
 * within a day, at which point it is worth less than nothing — it has trained
 * its reader to ignore the channel where the real one will arrive.
 *
 * `planNotifications` is pure and exported for that reason. The rule table is
 * the whole product, it has eight cases and two of them are counter-intuitive,
 * and a rule table that can only be exercised by standing up Postgres, a webhook
 * receiver and a broken agent is one that never gets exercised.
 */

import { createHash, createHmac, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { evaluateAlerts, type AlertResult, type AlertState, type Severity } from "./alerts";
import { describeDbError, isMissingTable, query } from "./db";

/* ── types ─────────────────────────────────────────────────────────────────── */

/** What we last told someone about one monitor. */
export interface Remembered {
  readonly state: AlertState;
  /** NULL until something has actually been delivered. Not the same as `ok`. */
  readonly notifiedState: AlertState | null;
  readonly notifiedAt: string | null;
  readonly since: string | null;
  /**
   * Per sink, keyed by `sinkKey()`. The authority for what to send where; the
   * two fields above are the union across sinks, kept for the panel.
   */
  readonly notifiedSinks?: Readonly<Record<string, { state: AlertState; at: string | null }>>;
  /** Has this monitor ever been observed healthy? Durable; see sql/alerts.sql. */
  readonly everOk?: boolean;
}

/**
 * A stable id for a sink that is safe to store and render.
 *
 * The URL itself cannot be the key: Slack and Discord both carry a working
 * credential in the path, and this ends up in a jsonb column the dashboard
 * renders. The kind alone cannot be either — two Slack webhooks would collide
 * and each would be told the other's transitions had already been delivered.
 */
export function sinkKey(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

export type TransitionKind = "fired" | "resolved" | "stale" | "renotify";

export interface Transition {
  readonly alert: AlertResult;
  readonly kind: TransitionKind;
  /** The state we last delivered. `null` means we have never said anything. */
  readonly from: AlertState | null;
  readonly to: AlertState;
  /** How long the monitor has been in `to`, when we know. Milliseconds. */
  readonly forMs: number | null;
}

export type SinkKind = "slack" | "discord" | "webhook";

export interface Sink {
  readonly kind: SinkKind;
  readonly url: string;
  /** Only meaningful for `webhook`; Slack and Discord authenticate by URL. */
  readonly secret: string | null;
}

export interface SinkConfig {
  readonly sinks: readonly Sink[];
  /** Why there are no sinks, in a sentence fit to render. `null` when there are. */
  readonly disabledReason: string | null;
  readonly intervalMs: number;
  /** `null` disables re-notification entirely, which is the default. */
  readonly renotifyMs: number | null;
}

/* ── the rule table ────────────────────────────────────────────────────────── */

/**
 * Which changes are worth a message.
 *
 * Pure, and exported, because this is the part that decides whether the feature
 * is useful or muted. `remembered` is keyed by alert id; a missing key means the
 * monitor has never been delivered, which is a distinct case from `ok` and is
 * the reason `from` is `AlertState | null` rather than defaulting to `ok`.
 *
 *   from        to         action     why
 *   ─────────── ────────── ────────── ────────────────────────────────────────
 *   never       firing     fired      a fresh install that is ALREADY broken is
 *                                     the one first-run message worth sending
 *   never       ok         —          silence. Nine "everything is fine" messages
 *                                     on first boot is how a channel gets muted
 *                                     before it has ever carried real news
 *   never       unknown    —          silence, same reason
 *   ok          firing     fired      the ordinary alert
 *   unknown     firing     fired      it became evaluable and it was bad
 *   firing      ok         resolved   the all-clear. Worth sending: an operator
 *                                     who was paged needs to know they can stop
 *   firing      unknown    stale      NOT a resolution. The monitor stopped
 *                                     being answerable while it was firing, so
 *                                     the problem is un-observed, not over.
 *                                     Reporting this as `resolved` is the single
 *                                     most dangerous thing this file could do
 *   ok          unknown    stale      ONLY at `page` severity. For the checks
 *                                     that would wake someone, losing the
 *                                     ability to evaluate is itself the
 *                                     incident. Below `page` it is silent,
 *                                     because an unmounted Docker socket is a
 *                                     configuration choice and not news
 *   unknown     ok         —          silence
 *   X           X          renotify   only while `firing`, only when a re-notify
 *                                     interval is configured, and only once it
 *                                     has elapsed since the last delivery
 */
export function planNotifications(
  live: readonly AlertResult[],
  remembered: ReadonlyMap<string, Remembered>,
  options: { readonly now: number; readonly renotifyMs: number | null },
): Transition[] {
  const out: Transition[] = [];

  for (const alert of live) {
    const prior = remembered.get(alert.id);
    const from = prior?.notifiedState ?? null;
    const to = alert.state;

    /*
     * How long it has been in the state being ANNOUNCED — which is only a
     * knowable number when the state did not just change.
     *
     * `prior.since` is read before this tick's observation is written, so on a
     * transition it is when the monitor entered the state it is LEAVING. Using
     * it there made a brand-new alert say "(2.1d)", reporting how long
     * everything had been fine as though it were the length of the outage. The
     * number was not merely wrong, it was wrong in the direction that makes an
     * operator think they missed two days of it.
     *
     * A monitor that just started firing has been firing for approximately no
     * time, and the honest rendering of that is nothing at all.
     */
    const unchanged = prior?.state === to;
    const forMs = unchanged ? elapsed(prior?.since, options.now) : null;

    if (from === to) {
      // Unchanged. The only reason to speak is a re-notify interval, and only
      // for something that is still wrong — repeating "resolved" or "not
      // checked" on a timer is noise by construction.
      if (
        to === "firing" &&
        options.renotifyMs !== null &&
        options.renotifyMs > 0 &&
        prior?.notifiedAt != null
      ) {
        const quiet = options.now - Date.parse(prior.notifiedAt);
        // NaN when the stored timestamp is unparseable. `>=` on NaN is false,
        // so a corrupt row goes quiet rather than notifying on every tick.
        if (quiet >= options.renotifyMs) {
          out.push({ alert, kind: "renotify", from, to, forMs });
        }
      }
      continue;
    }

    if (to === "firing") {
      out.push({ alert, kind: "fired", from, to, forMs });
      continue;
    }

    if (from === "firing" && to === "ok") {
      out.push({ alert, kind: "resolved", from, to, forMs });
      continue;
    }

    /*
     * Coverage lost.
     *
     * The `ok` half tests `prior.state` — what was last SEEN — not `from`, which
     * is what was last DELIVERED. A healthy monitor is never delivered (that is
     * the whole no-first-boot-spam rule), so its `notifiedState` stays null
     * forever, and a rule written as `from === "ok"` could not fire on any
     * monitor that had never fired. The one case it was written for — a `page`
     * check that has been fine all along and then stops being answerable — was
     * exactly the case it could not reach.
     *
     * `from !== "unknown"` is what stops it repeating: once the stale notice is
     * delivered, notified_state is `unknown` and the next tick falls into the
     * unchanged branch above.
     */
    /*
     * `everOk` is durable; `prior.state` is not, and that difference was a
     * dropped page.
     *
     * This read `prior.state === "ok"`. That is the last OBSERVATION, and
     * writeObservations advances it on every tick before anything is sent — so
     * the rule was eligible for exactly one tick. If that tick's POST failed,
     * the next tick saw state='unknown', concluded the monitor had never been
     * healthy, and planned nothing. A `page`-severity notification, dropped by
     * one transient 5xx, never retried. Worse, the empty plan then counted the
     * row as settled and cleared its delivery_error, so nothing was left to say
     * it had happened.
     *
     * Reachable on any install: `sandbox_networked` is `page` and goes unknown
     * the moment Docker is unreachable.
     */
    const wasOk = prior?.everOk === true;
    if (
      to === "unknown" &&
      from !== "unknown" &&
      (from === "firing" || (wasOk && alert.severity === "page"))
    ) {
      out.push({ alert, kind: "stale", from, to, forMs });
      continue;
    }

    // Everything else — first sight of a healthy monitor, unknown→ok, ok→unknown
    // below page severity — is a real change that is not worth interrupting
    // anyone for. It is still written to evestack.alert_state, so /monitors
    // shows it; it just does not leave the machine.
  }

  return out;
}

function elapsed(since: string | null | undefined, now: number): number | null {
  if (since == null) return null;
  const at = Date.parse(since);
  return Number.isFinite(at) ? Math.max(0, now - at) : null;
}

/* ── configuration ─────────────────────────────────────────────────────────── */

const DEFAULT_INTERVAL_SECONDS = 60;
/** Below this the loop would evaluate faster than the checks it runs. */
const MIN_INTERVAL_SECONDS = 15;

/**
 * Read the environment. Pure — it takes the env rather than reading the global,
 * so the tests can drive every branch without mutating `process.env`.
 *
 * `EVESTACK_ALERT_WEBHOOK_URL` is the on switch, in the same posture as
 * EVESTACK_HEARTBEAT_CHANNEL: unset means the loop never starts, nothing is
 * scheduled, and no schema is created. A feature that is off should cost
 * nothing, including a table.
 */
export function resolveSinks(env: Record<string, string | undefined>): SinkConfig {
  const intervalMs = seconds(env.EVESTACK_ALERT_INTERVAL_SECONDS, DEFAULT_INTERVAL_SECONDS) * 1000;
  const renotifyMinutes = Number(env.EVESTACK_ALERT_RENOTIFY_MINUTES ?? 0);
  const renotifyMs =
    Number.isFinite(renotifyMinutes) && renotifyMinutes > 0 ? renotifyMinutes * 60_000 : null;

  const raw = env.EVESTACK_ALERT_WEBHOOK_URL?.trim();
  if (!raw) {
    return {
      sinks: [],
      disabledReason:
        "No delivery target is configured, so these nine monitors are computed and shown here " +
        "and told to nobody. Set EVESTACK_ALERT_WEBHOOK_URL to a Slack, Discord or plain HTTPS " +
        "endpoint to have transitions delivered.",
      intervalMs,
      renotifyMs,
    };
  }

  const urls = raw
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);

  const sinks: Sink[] = [];
  const bad: string[] = [];
  const forced = env.EVESTACK_ALERT_WEBHOOK_FORMAT?.trim().toLowerCase();
  const secret = env.EVESTACK_ALERT_WEBHOOK_SECRET?.trim() || null;

  for (const url of urls) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      bad.push(url);
      continue;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      bad.push(url);
      continue;
    }
    // Deduplicated by URL, because the same URL is the same sink.
    //
    // Per-sink delivery keys its record by sinkKey(url), so a list containing
    // one URL twice is two entries collapsing onto one record: both get POSTed,
    // the second acknowledgement overwrites the first, and the reader is paged
    // twice for one transition. A comma-separated list is exactly the shape
    // where a copy-paste duplicate goes unnoticed.
    if (sinks.some((existing) => existing.url === url)) continue;
    sinks.push({ kind: sinkKind(parsed, forced), url, secret });
  }

  if (sinks.length === 0) {
    return {
      sinks: [],
      disabledReason: `EVESTACK_ALERT_WEBHOOK_URL is set but no usable http(s) URL could be read from it (${bad.length} rejected). Nothing will be delivered.`,
      intervalMs,
      renotifyMs,
    };
  }

  return { sinks, disabledReason: null, intervalMs, renotifyMs };
}

/**
 * Slack and Discord both take a POST of JSON at a secret URL and both reject the
 * other one's field name, so the body has to be chosen per vendor. Detecting it
 * from the host means the common case is one environment variable rather than
 * two, and `EVESTACK_ALERT_WEBHOOK_FORMAT` overrides it for anything proxied.
 */
function sinkKind(url: URL, forced: string | undefined): SinkKind {
  if (forced === "slack" || forced === "discord" || forced === "webhook") return forced;
  const host = url.hostname.toLowerCase();
  if (host === "hooks.slack.com") return "slack";
  if (host === "discord.com" || host === "discordapp.com" || host.endsWith(".discord.com")) {
    return url.pathname.includes("/api/webhooks/") ? "discord" : "webhook";
  }
  return "webhook";
}

function seconds(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(MIN_INTERVAL_SECONDS, Math.floor(n));
}

/* ── rendering ─────────────────────────────────────────────────────────────── */

const HEADLINE: Record<TransitionKind, string> = {
  fired: "FIRING",
  resolved: "RESOLVED",
  stale: "NOT CHECKED",
  renotify: "STILL FIRING",
};

const MARK: Record<TransitionKind, string> = {
  fired: "\u{1F534}",
  resolved: "\u{1F7E2}",
  stale: "\u{1F7E1}",
  renotify: "\u{1F534}",
};

/** Discord rejects a body over 2000 characters outright; Slack truncates at 40k. */
const LIMIT: Record<SinkKind, number> = { discord: 1900, slack: 3800, webhook: Infinity };

export function summarise(transitions: readonly Transition[]): string {
  const firing = transitions.filter((t) => t.kind === "fired" || t.kind === "renotify").length;
  const resolved = transitions.filter((t) => t.kind === "resolved").length;
  const stale = transitions.filter((t) => t.kind === "stale").length;
  const parts: string[] = [];
  if (firing > 0) parts.push(`${firing} firing`);
  if (resolved > 0) parts.push(`${resolved} resolved`);
  if (stale > 0) parts.push(`${stale} no longer checked`);
  return parts.length > 0 ? parts.join(", ") : "no change";
}

/**
 * Plain text, for the two vendors that take plain text.
 *
 * Deliberately not Block Kit or embeds. A Slack message built from blocks is a
 * different payload from a Discord embed is a different payload from a generic
 * JSON body, and three renderers is three places for the detail string to go
 * missing. One line per transition, the whole detail sentence included, because
 * the detail is the part that says what the number actually was.
 */
export function renderText(
  transitions: readonly Transition[],
  kind: SinkKind,
  dashboardUrl: string | null,
): string {
  const lines: string[] = [`${MARK[transitions[0]?.kind ?? "fired"]} *evestack* — ${summarise(transitions)}`];

  for (const t of transitions) {
    const where = t.alert.href && dashboardUrl ? ` ${dashboardUrl.replace(/\/$/, "")}${t.alert.href}` : "";
    const held = t.forMs !== null && t.kind !== "resolved" ? ` (${humanMs(t.forMs)})` : "";
    lines.push(`${HEADLINE[t.kind]} — ${t.alert.title}${held}: ${t.alert.detail}${where}`);
  }

  const text = lines.join("\n");
  const limit = LIMIT[kind];
  if (text.length <= limit) return text;
  // Truncating in the middle of a sentence and saying so beats a 400 from
  // Discord, which would look to the operator exactly like a broken webhook.
  const note = `\n… truncated, ${transitions.length} transitions in full at /monitors`;
  return `${text.slice(0, Math.max(0, limit - note.length))}${note}`;
}

function humanMs(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  return `${(ms / 86_400_000).toFixed(1)}d`;
}

export function renderBody(
  transitions: readonly Transition[],
  kind: SinkKind,
  dashboardUrl: string | null,
  sentAt: string,
): string {
  const text = renderText(transitions, kind, dashboardUrl);
  if (kind === "slack") return JSON.stringify({ text });
  if (kind === "discord") return JSON.stringify({ content: text });
  return JSON.stringify({
    source: "evestack",
    sentAt,
    summary: summarise(transitions),
    dashboardUrl,
    alerts: transitions.map((t) => ({
      id: t.alert.id,
      title: t.alert.title,
      severity: t.alert.severity,
      kind: t.kind,
      from: t.from,
      to: t.to,
      forMs: t.forMs,
      detail: t.alert.detail,
      threshold: t.alert.threshold ?? null,
      href: t.alert.href ?? null,
    })),
  });
}

/**
 * HMAC over `${timestamp}.${body}`, not over the body alone.
 *
 * Signing the body by itself authenticates the content and nothing else, so a
 * captured POST can be replayed forever. Binding the timestamp into the signed
 * material lets a receiver reject anything older than its own tolerance — the
 * convention Stripe and Slack both use, and the same reasoning as the
 * `TELEGRAM_WEBHOOK_SECRET_TOKEN` check evestack already documents.
 */
export function signBody(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

/** Slack and Discord put a working credential in the PATH. Never store one. */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname === "/" ? parsed.origin : `${parsed.origin}/…`;
  } catch {
    return "(unparseable)";
  }
}

/* ── storage ───────────────────────────────────────────────────────────────── */

let schemaReady: Promise<void> | null = null;

export function ensureAlertSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = query(readSchemaSql())
      .then(() => undefined)
      // Same reasoning as lib/traces.ts: a bootstrap that failed because the
      // database was merely unreachable must not be cached as broken forever.
      .catch((error: unknown) => {
        schemaReady = null;
        throw error;
      });
  }
  return schemaReady;
}

function readSchemaSql(): string {
  let dir = process.cwd();
  for (let up = 0; up < 5; up += 1) {
    try {
      return readFileSync(join(dir, "sql", "alerts.sql"), "utf8");
    } catch {
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  throw new Error(
    `Could not find sql/alerts.sql above ${process.cwd()}. ` +
      "Run the dashboard from packages/dashboard, or apply the file by hand.",
  );
}

export async function readRemembered(): Promise<Map<string, Remembered>> {
  const rows = await query<{
    id: string;
    state: AlertState;
    notified_state: AlertState | null;
    notified_at: string | Date | null;
    since: string | Date | null;
    notified_sinks: Record<string, { state: AlertState; at: string | null }> | null;
    ever_ok: boolean | null;
  }>(
    `SELECT id, state, notified_state, notified_at, since, notified_sinks, ever_ok
       FROM evestack.alert_state`,
  );

  return new Map(
    rows.map((r) => [
      r.id,
      {
        state: r.state,
        notifiedState: r.notified_state,
        notifiedAt: iso(r.notified_at),
        since: iso(r.since),
        notifiedSinks: r.notified_sinks ?? {},
        everOk: r.ever_ok === true,
      },
    ]),
  );
}

function iso(value: string | Date | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * Write what we saw. Always — including the states we deliberately do not send.
 *
 * `since` is only reset when the state actually changed, which is what makes
 * "failing for 40 minutes" true rather than "failing since the last tick".
 * `notified_state` is untouched here; only a successful delivery moves it.
 */
async function writeObservations(alerts: readonly AlertResult[]): Promise<void> {
  if (alerts.length === 0) return;
  const params: unknown[] = [];
  const tuples = alerts.map((a, i) => {
    const b = i * 5;
    params.push(a.id, a.state, a.severity, a.title, a.detail);
    // The 6th column is computed, not bound: a first insert of a healthy
    // monitor has to latch ever_ok immediately, or its very first ok->unknown
    // would be silent.
    return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 2} = 'ok')`;
  });

  await query(
    `INSERT INTO evestack.alert_state (id, state, severity, title, detail, ever_ok)
     VALUES ${tuples.join(", ")}
     ON CONFLICT (id) DO UPDATE SET
       -- Latches. Once healthy, always "has been healthy" — that is what makes
       -- the coverage-loss rule survive a failed send.
       ever_ok     = evestack.alert_state.ever_ok OR EXCLUDED.state = 'ok',
       state       = EXCLUDED.state,
       severity    = EXCLUDED.severity,
       title       = EXCLUDED.title,
       detail      = EXCLUDED.detail,
       observed_at = now(),
       since       = CASE WHEN evestack.alert_state.state IS DISTINCT FROM EXCLUDED.state
                          THEN now() ELSE evestack.alert_state.since END`,
    params,
  );
}

/**
 * Only after a sink accepted it. See the note on the table.
 *
 * The state is passed in PER ID rather than written as `notified_state = state`.
 * That reads the column back, and the column is not what was delivered: another
 * tick (a forced one from /api/alerts, or an overlapping timer tick) can write a
 * newer observation between this tick's plan and this statement. Stamping the
 * re-read value marks a transition delivered that nobody was ever sent — which
 * is precisely the silent-loss this table's two columns exist to prevent,
 * reintroduced by the one line that updates them.
 */
async function recordAcknowledgements(
  acknowledged: ReadonlyMap<string, ReadonlyMap<string, AlertState>>,
  allSinkKeys: readonly string[],
): Promise<void> {
  if (acknowledged.size === 0) return;

  const at = new Date().toISOString();
  for (const [key, byId] of acknowledged) {
    const ids = [...byId.keys()];
    const patches = ids.map((id) => JSON.stringify({ [key]: { state: byId.get(id), at } }));
    // `||` merges at the top level, so one sink's entry is replaced and every
    // other sink's is left exactly as it was. Writing the whole object would
    // make two sinks racing the same row lose each other's acknowledgements.
    await query(
      `UPDATE evestack.alert_state AS a
          SET notified_sinks = a.notified_sinks || v.patch::jsonb,
              delivery_error = NULL, delivery_attempts = 0
         FROM unnest($1::text[], $2::text[]) AS v(id, patch)
        WHERE a.id = v.id`,
      [ids, patches],
    );
  }

  /*
   * `notified_state` is the state EVERY configured sink has acknowledged.
   *
   * It is derived rather than written directly because it is a summary, and the
   * panel is its only reader. A monitor that reached one of two sinks is not
   * "delivered" in the sense the panel means, so it stays at whatever both last
   * agreed on until the lagging sink catches up.
   */
  await query(
    `UPDATE evestack.alert_state AS a
        SET notified_state = sub.state, notified_at = now()
       FROM (
         SELECT id,
                min(notified_sinks -> k ->> 'state') AS state,
                count(*) FILTER (WHERE notified_sinks ? k) AS covered,
                count(DISTINCT notified_sinks -> k ->> 'state') AS distinct_states
           FROM evestack.alert_state, unnest($1::text[]) AS k
          GROUP BY id
       ) AS sub
      WHERE a.id = sub.id
        AND sub.covered = $2
        AND sub.distinct_states = 1
        AND a.notified_state IS DISTINCT FROM sub.state`,
    [allSinkKeys, allSinkKeys.length],
  );
}

async function markFailed(ids: readonly string[], error: string): Promise<void> {
  if (ids.length === 0) return;
  await query(
    `UPDATE evestack.alert_state
        SET delivery_error = $2, delivery_attempts = delivery_attempts + 1
      WHERE id = ANY($1::text[])`,
    [ids, error.slice(0, 500)],
  );
}

async function recordDelivery(row: {
  sink: SinkKind;
  target: string;
  transitions: readonly Transition[];
  ok: boolean;
  httpStatus: number | null;
  error: string | null;
  durationMs: number;
}): Promise<void> {
  await query(
    `INSERT INTO evestack.alert_deliveries
       (sink, target, transitions, ok, http_status, error, duration_ms)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)`,
    [
      row.sink,
      row.target,
      JSON.stringify(
        row.transitions.map((t) => ({
          id: t.alert.id,
          kind: t.kind,
          from: t.from,
          to: t.to,
          severity: t.alert.severity,
        })),
      ),
      row.ok,
      row.httpStatus,
      row.error === null ? null : row.error.slice(0, 1000),
      Math.round(row.durationMs),
    ],
  );
}

/**
 * One sender at a time.
 *
 * A conditional UPDATE ... RETURNING is atomic on its own: Postgres takes a row
 * lock for the duration of the statement, so of two dashboards racing, the
 * second re-reads the row after the first commits and its WHERE no longer
 * matches. No advisory lock, and no lock held across the HTTP call — which
 * matters, because a webhook that hangs for 30 seconds would otherwise hold a
 * session-level lock for 30 seconds and wedge the other replica behind it.
 *
 * The lease is deliberately short-lived and NOT released: it expires. A holder
 * that crashes mid-send leaves a stale claim that the other instance takes over
 * one interval later, with no cleanup path to get wrong.
 */
async function claimLease(holder: string, intervalMs: number): Promise<boolean> {
  await query(
    `INSERT INTO evestack.alert_lease (id, holder, claimed_at)
     VALUES (true, $1, now() - $2::interval)
     ON CONFLICT (id) DO NOTHING`,
    [holder, `${Math.round(intervalMs / 1000)} seconds`],
  );

  const rows = await query<{ ok: boolean }>(
    `UPDATE evestack.alert_lease
        SET holder = $1, claimed_at = now()
      WHERE claimed_at <= now() - $2::interval
      RETURNING true AS ok`,
    // 0.9 rather than 1.0: two ticks that are one interval apart must not race
    // the boundary and skip a round because neither was quite late enough.
    [holder, `${Math.max(1, Math.round((intervalMs * 0.9) / 1000))} seconds`],
  );
  return rows.length > 0;
}

/** Keep the audit log bounded without a cron. */
async function pruneDeliveries(days: number): Promise<void> {
  await query(`DELETE FROM evestack.alert_deliveries WHERE sent_at < now() - $1::interval`, [
    `${days} days`,
  ]);
}

/* ── the tick ──────────────────────────────────────────────────────────────── */

export interface DeliveryOutcome {
  readonly evaluated: number;
  readonly planned: readonly Transition[];
  readonly sent: number;
  readonly failures: readonly { sink: SinkKind; target: string; error: string }[];
  /** Set when the tick did nothing, and why. */
  readonly skipped: string | null;
}

/**
 * Evaluate, decide, send, remember — in that order, and the order is load-bearing.
 *
 * The observation is written BEFORE anything is sent, so /monitors reflects
 * reality even when every sink is refusing. `notified_state` moves only after a
 * sink returns 2xx, so a failing receiver replays the same transition on the
 * next tick instead of losing it.
 */
export async function deliverOnce(options?: {
  readonly force?: boolean;
  readonly config?: SinkConfig;
}): Promise<DeliveryOutcome> {
  /*
   * ONE AT A TIME IN THIS PROCESS, and the reason is a bug that was reproduced
   * rather than reasoned about.
   *
   * `setInterval(() => void tick(), …)` does not await the previous tick, and
   * `claimLease` grants on elapsed time without checking WHO holds it — its
   * WHERE names `claimed_at` and never `holder` — so a process re-wins its own
   * lease. Meanwhile `notified_state` does not advance until every sink has been
   * posted. Line those three up and one dashboard pages the on-call twice for
   * one transition: measured at a 15s interval with three sinks whose successful
   * posts totalled 19s, the same "FIRING" message arrived at t=0 and t=15.
   *
   * The forced path from POST /api/alerts had the same shape from the other
   * direction — it skips the lease entirely, so an operator running the curl
   * from docs/alerts.mdx while a tick was mid-send got a second copy.
   *
   * Serialising here fixes both, and it is the right layer: the race is between
   * two calls in ONE process, which no amount of care in the Postgres lease can
   * see. A second caller waits for the one in flight and then runs — by which
   * time the transition is recorded, so it correctly plans nothing.
   */
  const run = deliveryChain.then(
    () => runDelivery(options),
    // A previous delivery that threw must not poison the queue: the next caller
    // still runs, which is the whole point of retrying a failed send.
    () => runDelivery(options),
  );
  deliveryChain = run.catch(() => {});
  return run;
}

/** The tail of the serialised queue. Every deliverOnce chains onto it. */
let deliveryChain: Promise<unknown> = Promise.resolve();

async function runDelivery(options?: {
  readonly force?: boolean;
  readonly config?: SinkConfig;
}): Promise<DeliveryOutcome> {
  const config = options?.config ?? resolveSinks(process.env);
  if (config.sinks.length === 0) {
    return { evaluated: 0, planned: [], sent: 0, failures: [], skipped: config.disabledReason };
  }

  await ensureAlertSchema();

  if (options?.force !== true) {
    const held = await claimLease(HOLDER, config.intervalMs);
    if (!held) {
      return {
        evaluated: 0,
        planned: [],
        sent: 0,
        failures: [],
        skipped: "another dashboard instance holds the delivery lease",
      };
    }
  }

  const live = await evaluateAlerts();
  const remembered = await readRemembered();
  await writeObservations(live);

  /*
   * One plan PER SINK, from that sink's own record of what it has been told.
   *
   * There used to be a single plan and an all-or-nothing rule: a transition
   * counted as delivered only once every sink had accepted it. The reasoning was
   * that marking it done because one worked would leave the other never
   * receiving that alert — true, and it produced a worse failure. A single
   * permanently-broken sink meant the transition was never consumed, so every
   * HEALTHY sink was sent the identical alert on every tick, forever. Sixty
   * seconds apart. About one incident. That is the muted channel this module
   * exists to prevent, reached by way of being careful about the other thing.
   */
  const now = Date.now();
  const perSink = config.sinks.map((sink) => {
    const key = sinkKey(sink.url);
    const view = new Map(
      [...remembered].map(([id, r]) => {
        const mine = r.notifiedSinks?.[key];
        return [id, { ...r, notifiedState: mine?.state ?? null, notifiedAt: mine?.at ?? null }];
      }),
    );
    return {
      sink,
      key,
      plan: planNotifications(live, view, { now, renotifyMs: config.renotifyMs }),
    };
  });

  /*
   * Clear stale failure markers BEFORE the nothing-to-do return.
   *
   * This block used to sit at the end, after the early return below — so on
   * every tick where nothing needed sending, which in a healthy system is
   * almost every tick, it never ran. A monitor that fired, failed to deliver,
   * and then resolved without ever being delivered plans nothing afterwards, so
   * /monitors kept rendering "1 monitor could not be delivered and is being
   * retried" about a transition that no longer existed and nothing would retry.
   * The fix was unreachable on exactly the ticks that needed it.
   */
  const stillPending = new Set(perSink.flatMap((e) => e.plan.map((t) => t.alert.id)));
  const settled = live.map((a) => a.id).filter((id) => !stillPending.has(id));
  if (settled.length > 0) {
    await query(
      `UPDATE evestack.alert_state
          SET delivery_error = NULL, delivery_attempts = 0
        WHERE id = ANY($1::text[]) AND delivery_error IS NOT NULL`,
      [settled],
    );
  }

  if (perSink.every((entry) => entry.plan.length === 0)) {
    return { evaluated: live.length, planned: [], sent: 0, failures: [], skipped: null };
  }

  const dashboardUrl = process.env.EVESTACK_PUBLIC_URL?.trim() || null;
  const sentAt = new Date().toISOString();
  const failures: { sink: SinkKind; target: string; error: string }[] = [];
  const acknowledged = new Map<string, Map<string, AlertState>>();
  const failedIds = new Set<string>();
  let delivered = 0;

  for (const { sink, key, plan } of perSink) {
    if (plan.length === 0) continue;

    const started = Date.now();
    const result = await post(sink, plan, dashboardUrl, sentAt);
    const durationMs = Date.now() - started;

    await recordDelivery({
      sink: sink.kind,
      target: redactUrl(sink.url),
      transitions: plan,
      ok: result.ok,
      httpStatus: result.status,
      error: result.error,
      durationMs,
    });

    if (result.ok) {
      delivered += 1;
      acknowledged.set(key, new Map(plan.map((t) => [t.alert.id, t.to])));
    } else {
      for (const t of plan) failedIds.add(t.alert.id);
      failures.push({ sink: sink.kind, target: redactUrl(sink.url), error: result.error ?? "" });
    }
  }

  await recordAcknowledgements(acknowledged, config.sinks.map((s) => sinkKey(s.url)));

  if (failedIds.size > 0) {
    await markFailed([...failedIds], failures.map((f) => `${f.sink}: ${f.error}`).join("; "));
  }

  // The union, for the caller's report. A monitor appears once even when two
  // sinks were both told about it.
  const planned = [...new Map(perSink.flatMap((e) => e.plan).map((t) => [t.alert.id, t])).values()];

  return {
    evaluated: live.length,
    planned,
    sent: delivered,
    failures,
    skipped: null,
  };
}

const POST_TIMEOUT_MS = 10_000;

async function post(
  sink: Sink,
  transitions: readonly Transition[],
  dashboardUrl: string | null,
  sentAt: string,
): Promise<{ ok: boolean; status: number | null; error: string | null }> {
  const body = renderBody(transitions, sink.kind, dashboardUrl, sentAt);
  const headers: Record<string, string> = { "content-type": "application/json" };

  if (sink.kind === "webhook" && sink.secret !== null) {
    const timestamp = String(Date.now());
    headers["x-evestack-alert-timestamp"] = timestamp;
    headers["x-evestack-alert-signature"] = signBody(sink.secret, timestamp, body);
  }

  try {
    const response = await fetch(sink.url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    if (response.ok) return { ok: true, status: response.status, error: null };
    // The body is where Slack and Discord say WHY — "invalid_payload",
    // "no_service". A bare status code sends the operator to the wrong problem.
    const text = await response.text().catch(() => "");
    return {
      ok: false,
      status: response.status,
      error: `HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}`,
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      // REDACTED, and this is not paranoia. undici puts the request URL into the
      // message of most network failures — "request to https://hooks.slack.com/
      // services/T0/B0/XXXXsecret failed, reason: ECONNREFUSED" — and a Slack or
      // Discord webhook carries its whole credential in that path. This string
      // is written to evestack.alert_deliveries, rendered on /monitors, returned
      // by GET /api/alerts and printed to the boot log, so leaving it raw would
      // publish a working webhook to four places at once, and only ever on the
      // day something is already going wrong.
      error: scrubUrls(error instanceof Error ? error.message : String(error)),
    };
  }
}

/**
 * Replace any absolute URL in a string with its redacted form.
 *
 * Deliberately not "remove the one URL we know about": the message may name a
 * redirect target, a proxy, or a URL we never configured, and a blocklist of one
 * would pass all three through.
 */
export function scrubUrls(text: string): string {
  return text.replace(/https?:\/\/[^\s"']+/gi, (match) => redactUrl(match));
}

/**
 * Prove the transport, without pretending anything is wrong.
 *
 * A forced tick on a healthy install correctly sends nothing, which is useless
 * for answering "is my webhook URL right". This sends one obviously-synthetic
 * message to every configured sink and touches NEITHER alert_state nor the
 * transition rules — a test that consumed a real transition could swallow a
 * genuine alert, and one that wrote `notified_state` would make the next real
 * firing look like a repeat.
 *
 * It IS recorded in alert_deliveries, under the id `test`, because "I clicked
 * test and nothing arrived" needs the same audit trail as a missed alert.
 */
export async function sendTestNotification(): Promise<{
  sent: number;
  failures: { sink: SinkKind; target: string; error: string }[];
  skipped: string | null;
}> {
  const config = resolveSinks(process.env);
  if (config.sinks.length === 0) {
    return { sent: 0, failures: [], skipped: config.disabledReason };
  }
  await ensureAlertSchema();

  const transitions: Transition[] = [
    {
      alert: {
        id: "test",
        title: "Test notification",
        severity: "info",
        state: "ok",
        detail:
          "Nothing is wrong. Someone pressed the test button on /monitors to check that this " +
          "channel works. Real alerts are sent only when a monitor changes state.",
        href: "/monitors",
      },
      kind: "resolved",
      from: "firing",
      to: "ok",
      forMs: null,
    },
  ];

  const dashboardUrl = process.env.EVESTACK_PUBLIC_URL?.trim() || null;
  const sentAt = new Date().toISOString();
  const failures: { sink: SinkKind; target: string; error: string }[] = [];
  let sent = 0;

  for (const sink of config.sinks) {
    const started = Date.now();
    const result = await post(sink, transitions, dashboardUrl, sentAt);
    await recordDelivery({
      sink: sink.kind,
      target: redactUrl(sink.url),
      transitions,
      ok: result.ok,
      httpStatus: result.status,
      error: result.error,
      durationMs: Date.now() - started,
    });
    if (result.ok) sent += 1;
    else failures.push({ sink: sink.kind, target: redactUrl(sink.url), error: result.error ?? "" });
  }

  return { sent, failures, skipped: null };
}

/* ── what the page needs to say about itself ───────────────────────────────── */

export interface DeliveryStatus {
  readonly configured: boolean;
  /** Sink kinds, deduplicated. Never the URLs — they carry the credential. */
  readonly sinks: readonly SinkKind[];
  readonly disabledReason: string | null;
  readonly intervalSeconds: number;
  readonly renotifyMinutes: number | null;
  readonly lastDeliveryAt: string | null;
  readonly lastDeliveryOk: boolean | null;
  /** Monitors whose transition is stuck because a sink keeps refusing. */
  readonly failing: readonly { id: string; error: string; attempts: number }[];
  /** Set when the state tables have never been created — nothing has ever run. */
  readonly neverRun: boolean;
  /**
   * Why the delivery state could not be read at all, when that is the reason
   * the fields above are empty.
   *
   * `neverRun` used to absorb this case too, and it was wrong twice over: the
   * flag was written and never read, and its catch returned it for ANY failure
   * — so a Postgres that was down rendered as "Nothing has been sent yet", the
   * same words a healthy install with delivery switched off shows. A monitor
   * panel reporting calm because it could not reach the database is the exact
   * failure the alert loop exists to prevent.
   */
  readonly unreadable: string | null;
}

/**
 * Read-only, and it must never create the schema.
 *
 * /monitors renders this on every load. If it bootstrapped, an install with no
 * delivery configured would grow three tables the moment someone opened the
 * page, which is the opposite of "off costs nothing" — and the missing-table
 * error is itself the answer to the question being asked.
 */
export async function deliveryStatus(): Promise<DeliveryStatus> {
  const config = resolveSinks(process.env);
  const base = {
    configured: config.sinks.length > 0,
    sinks: [...new Set(config.sinks.map((s) => s.kind))],
    disabledReason: config.disabledReason,
    intervalSeconds: Math.round(config.intervalMs / 1000),
    renotifyMinutes: config.renotifyMs === null ? null : Math.round(config.renotifyMs / 60_000),
  };

  try {
    const [last] = await query<{ sent_at: string | Date; ok: boolean }>(
      `SELECT sent_at, ok FROM evestack.alert_deliveries ORDER BY sent_at DESC LIMIT 1`,
    );
    const failing = await query<{ id: string; delivery_error: string; delivery_attempts: number }>(
      `SELECT id, delivery_error, delivery_attempts
         FROM evestack.alert_state
        WHERE delivery_error IS NOT NULL
        ORDER BY delivery_attempts DESC LIMIT 5`,
    );
    return {
      ...base,
      lastDeliveryAt: last === undefined ? null : iso(last.sent_at),
      lastDeliveryOk: last === undefined ? null : last.ok,
      failing: failing.map((f) => ({
        id: f.id,
        error: f.delivery_error,
        attempts: f.delivery_attempts,
      })),
      neverRun: false,
      unreadable: null,
    };
  } catch (error) {
    // Missing table and "the database is down" are opposite answers and used to
    // return the same one. A table this repo has simply never created is a
    // legitimate off state — nothing has run, say so calmly, and do NOT
    // bootstrap from a page render. Anything else is a read that failed, and a
    // delivery panel that stays quiet about that is telling the reader they are
    // covered when nobody knows whether they are.
    const missing = isMissingTable(error);
    return {
      ...base,
      lastDeliveryAt: null,
      lastDeliveryOk: null,
      failing: [],
      neverRun: missing,
      unreadable: missing ? null : describeDbError(error),
    };
  }
}

/* ── the loop ──────────────────────────────────────────────────────────────── */

const HOLDER = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
const PRUNE_EVERY_TICKS = 60;
/**
 * How often to repeat an UNCHANGED failure.
 *
 * Derived from the interval rather than fixed in ticks, so it is an hour at the
 * 60s default and an hour at the 15s floor. A fixed tick count would have meant
 * four hours at one setting and one at the other, for no reason a reader could
 * see.
 */
const REPEAT_ERROR_MS = 3_600_000;

declare global {
  // eslint-disable-next-line no-var
  var __evestackAlertLoop: NodeJS.Timeout | undefined;
}

/**
 * Start the ticker. Idempotent, and a no-op when nothing is configured.
 *
 * Called from instrumentation.ts, which Next runs once per server instance. The
 * global guard is for `next dev`, where a module can be re-evaluated without the
 * process restarting — without it, an edit to this file would leave the previous
 * interval running and every save would add another sender.
 */
export function startAlertDelivery(): { started: boolean; reason: string } {
  const config = resolveSinks(process.env);
  if (config.sinks.length === 0) {
    return { started: false, reason: config.disabledReason ?? "not configured" };
  }
  if (globalThis.__evestackAlertLoop !== undefined) {
    return { started: false, reason: "already running in this process" };
  }

  let ticks = 0;
  // Kept across ticks so an unchanged failure is not re-logged every interval.
  const repeatEvery = Math.max(1, Math.round(REPEAT_ERROR_MS / config.intervalMs));
  let lastTickError: string | null = null;
  let sameErrorTicks = 0;
  const tick = async (): Promise<void> => {
    try {
      const outcome = await deliverOnce({ config });
      ticks += 1;
      // A tick that worked ends the streak. Without this a later failure would
      // inherit the old count and could skip its own first report.
      lastTickError = null;
      sameErrorTicks = 0;
      if (outcome.failures.length > 0) {
        console.warn(
          `[evestack:alerts] ${outcome.failures.length} sink(s) refused: ` +
            outcome.failures.map((f) => `${f.sink} ${f.error}`).join("; "),
        );
      }
      if (ticks % PRUNE_EVERY_TICKS === 0) {
        await pruneDeliveries(30).catch(() => {});
      }
    } catch (error) {
      /*
       * The database being down is the common case here and it is transient.
       * Logging and continuing is right; throwing out of a timer callback would
       * take the dashboard process with it.
       *
       * But NOT the same line every interval forever. Measured against a dead
       * Postgres: the loop survives correctly and writes an identical
       * "connect ECONNREFUSED" every 15 seconds — 5,760 lines a day, about one
       * fact. This module's own argument against re-sending an unchanged alert
       * applies to its own logs, and a log nobody can read is the same failure
       * as a channel nobody listens to.
       *
       * So: say it when it changes, and once an hour while it persists, which is
       * what a reader tailing this actually needs — that it is STILL failing,
       * without the other 239 copies.
       */
      const message = error instanceof Error ? error.message : String(error);
      const repeated = message === lastTickError;
      lastTickError = message;
      if (repeated) {
        sameErrorTicks += 1;
        if (sameErrorTicks % repeatEvery !== 0) return;
        const minutes = Math.round((sameErrorTicks * config.intervalMs) / 60_000);
        console.warn(`[evestack:alerts] still failing after ${minutes}m: ${message}`);
        return;
      }
      sameErrorTicks = 0;
      console.warn(
        `[evestack:alerts] tick failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const timer = setInterval(() => void tick(), config.intervalMs);
  // Do not hold the process open on our own account. If the HTTP server exits,
  // there is nothing left to alert about from here.
  timer.unref?.();
  globalThis.__evestackAlertLoop = timer;

  // One immediately, so a fresh boot with something already firing does not wait
  // out a full interval before saying so.
  void tick();

  return {
    started: true,
    reason: `${config.sinks.length} sink(s), every ${Math.round(config.intervalMs / 1000)}s`,
  };
}
