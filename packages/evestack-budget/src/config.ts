/**
 * Configuration for the budget hook and guard.
 *
 * Everything is readable from the environment so the cap is on by default in
 * a template that never calls the constructor with arguments. An opt-in budget
 * is a budget nobody turns on.
 */
export interface BudgetConfig {
  /**
   * USD ceiling for one durable session. `false` disables the session cap.
   *
   * This is the axis eve can also enforce itself (`limits.maxInputTokensPerSession`),
   * but only in tokens and only for a statically configured number.
   */
  readonly sessionUsd: number | false;
  /**
   * USD ceiling for one principal in one day. `false` disables the daily cap.
   *
   * This is the axis eve structurally cannot have: it outlives the session, so
   * starting a new conversation does not reset it.
   */
  readonly dailyUsd: number | false;
  /**
   * IANA zone the daily window is cut on. A cap that rolls over at 5pm local
   * because the server is in UTC is a support ticket, so this is explicit.
   */
  readonly timeZone: string;
  /**
   * What to do at the moment a cap is crossed.
   *
   * - `fail` (default): throw out of the hook. eve treats a thrown hook as a
   *   real failure, so `step.failed` and `turn.failed` both carry our message
   *   — the only way an authored extension can put a reason on the event
   *   stream. Measured: the session is *not* poisoned, `session.waiting`
   *   follows and the next message runs normally. The one wart is the code,
   *   which eve stamps as `MODEL_CALL_FAILED` rather than ours.
   * - `cancel`: POST eve's own cancel route instead. `turn.cancelled` then
   *   `session.waiting`, which eve documents as a user decision rather than an
   *   error — cleaner semantics, but the stream carries no reason at all, so
   *   the stop reads as silent unless someone opens the dashboard. Choose this
   *   when a client treats `turn.failed` harshly.
   * - `observe`: record spend, stop nothing. For measuring before enforcing.
   */
  readonly mode: "cancel" | "fail" | "observe";
  /**
   * Model id used to price tokens, e.g. `openai/gpt-5-mini`.
   *
   * `step.completed` carries token counts but not the model that produced
   * them, and eve only reports `usage.costUsd` when the call went through
   * Vercel's AI Gateway — which a self-hosted agent by definition does not.
   * So the model has to come from configuration. When the agent selects its
   * model dynamically, set this per deployment or pass `resolveModel`.
   */
  readonly model: string;
  /**
   * What to do when the resolved model has no price.
   *
   * `warn` (default) keeps the agent running and logs once per session; the
   * unpriced steps are counted in `evestack.budget_usage.unpriced_steps` so
   * "$0.00 spent" is never mistaken for "free". `stop` treats an unpriced
   * model as an immediately-exceeded budget, which is the fail-closed choice.
   */
  readonly unpricedModel: "warn" | "stop";
  /**
   * What happens when the spend store itself is unreachable.
   *
   * Default `false`: log loudly and let the turn run. A Postgres blip turning
   * into total agent unavailability is a worse outcome than a few unmetered
   * minutes, and this is a cost control, not a security boundary. Set
   * `EVESTACK_BUDGET_FAIL_CLOSED=1` when the cap matters more than uptime —
   * then a store error fails the turn instead of going unrecorded.
   */
  readonly failClosed: boolean;
  /** Base URL of this agent's own eve HTTP API, used for the cancel call. */
  readonly agentUrl: string;
  /** HTTP Basic credentials for that self-call, when the channel requires them. */
  readonly authUser?: string;
  readonly authPassword?: string;
  /**
   * Tool names the step-scoped guard shadows once the budget is gone.
   *
   * A dynamic tool overrides an authored tool of the same name, so naming a
   * tool here replaces it with a refusal for the rest of the session. Names
   * must be authored (static) tools: two *dynamic* resolvers emitting the
   * same name is an ambiguity eve throws on.
   */
  readonly guardTools: readonly string[];
  /** Postgres connection string. Defaults to the same one eve's sessions use. */
  readonly databaseUrl?: string;
}

export type BudgetOptions = Partial<BudgetConfig>;

const DEFAULT_SESSION_USD = 2;
const DEFAULT_DAILY_USD = 10;
const DEFAULT_TIME_ZONE = "UTC";

function envNumberOrFalse(raw: string | undefined, fallback: number | false): number | false {
  if (raw === undefined || raw.trim() === "") return fallback;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "false" || trimmed === "off" || trimmed === "none") return false;
  const value = Number(trimmed.replace(/^\$/, ""));
  // A typo in a cap must not silently become "no cap" — fall back to the
  // default, which is the safe direction, and say so.
  if (!Number.isFinite(value) || value < 0) {
    console.warn(`[evestack:budget] ignoring unparseable cap "${raw}"; using ${String(fallback)}`);
    return fallback;
  }
  return value;
}

function envMode(raw: string | undefined): BudgetConfig["mode"] {
  if (raw === "fail" || raw === "observe" || raw === "cancel") return raw;
  if (raw !== undefined && raw.trim() !== "") {
    console.warn(`[evestack:budget] unknown EVESTACK_BUDGET_MODE "${raw}"; using "fail"`);
  }
  return "fail";
}

/** Zones already complained about, so a bad one warns once and not once per turn. */
const warnedTimeZones = new Set<string>();

/**
 * A zone `Intl` will actually accept, or the documented default.
 *
 * `Intl.DateTimeFormat` throws `RangeError` on a zone it does not know, and
 * `dayKey` sits on the path of every step — so an unchecked value here turned a
 * one-character typo into an agent that could not complete a turn at all. The
 * values that reach this are ordinary rather than exotic: a trailing space
 * survives both a `.env` file and `docker compose`, and `GMT+2` is a plausible
 * guess at an IANA name that is not one.
 *
 * Hence the same posture as every other field in this file, for the same reason:
 * warn, fall back to the default, keep serving. A daily window cut in the wrong
 * zone is a smaller error than an agent that cannot answer, and this is a cost
 * control — a typo in it must not be the thing that stops an agent.
 *
 * Empty is not a typo. `EVESTACK_BUDGET_TIMEZONE=` is a blank line in a `.env`,
 * which plainly means "not configured", so it falls back in silence the way
 * `envNumberOrFalse` does rather than shouting about a value nobody set.
 */
function validTimeZone(raw: string | undefined): string {
  const trimmed = raw?.trim();
  if (!trimmed) return DEFAULT_TIME_ZONE;
  try {
    // Construction is where the zone is validated, so this is the whole test.
    new Intl.DateTimeFormat("en-CA", { timeZone: trimmed });
    return trimmed;
  } catch {
    if (!warnedTimeZones.has(trimmed)) {
      warnedTimeZones.add(trimmed);
      console.warn(
        `[evestack:budget] "${trimmed}" is not a time zone Intl accepts; cutting the daily ` +
          `window on ${DEFAULT_TIME_ZONE} instead. EVESTACK_BUDGET_TIMEZONE wants an IANA name ` +
          `like "America/Toronto", not an offset like "GMT+2".`,
      );
    }
    return DEFAULT_TIME_ZONE;
  }
}

/**
 * Each provider's default model, which has to match the agent's.
 *
 * `templates/default/agent/agent.ts` carries the same three and says out loud
 * that the two tables must stay in step. They had drifted: this file defaulted
 * every non-ollama provider to `gpt-5-mini`, so the documented anthropic setup —
 * `EVESTACK_PROVIDER=anthropic` with `EVESTACK_MODEL` left commented out, which
 * is exactly what `templates/default/.env.example` shows — priced the run as
 * `anthropic/gpt-5-mini`. Nothing prices that, and there is no `anthropic/*`
 * wildcard to catch it, so every step cost $0.00 and neither the $2 session cap
 * nor the $10 daily one could ever trip. With the `EVESTACK_BUDGET_UNPRICED=stop`
 * that same file recommends it failed the other way: the first step of every turn
 * was instantly over budget. A drifted default here is not a small error in
 * either direction, which is why it is one map rather than an inline ternary.
 */
const PROVIDER_DEFAULT_MODEL: Record<string, string | undefined> = {
  openai: "gpt-5-mini",
  anthropic: "claude-sonnet-5",
  ollama: "qwen3",
};

/**
 * The model the template would have built, reconstructed from the same two
 * variables `agent.ts` reads. Keeping this in lockstep with the template is
 * why both live in the same repo.
 *
 * Trimmed and length-checked rather than `??`, which is how `agent.ts` reads the
 * same two variables: `??` only falls back on undefined, so `EVESTACK_MODEL=` —
 * a blank line in `.env.local`, or CI passing through an unset input — survived
 * as the model half of the key and produced `openai/`, and `EVESTACK_PROVIDER`
 * was compared to `"ollama"` case- and space-sensitively, so `Anthropic` and
 * ` ollama ` became providers of their own. Every one of those is an unpriced
 * key, which is the failure above reached by another route.
 */
function envModel(): string {
  const explicit = process.env.EVESTACK_BUDGET_MODEL?.trim();
  if (explicit) return explicit;

  const provider = process.env.EVESTACK_PROVIDER?.trim().toLowerCase() || "openai";
  const model = process.env.EVESTACK_MODEL?.trim() || PROVIDER_DEFAULT_MODEL[provider];
  if (!model) {
    // A provider `agent.ts` does not know, which it treats as a hard error — so
    // the agent will not have started, and refusing here too would buy nothing
    // this package's own policy allows. There is no default model to guess
    // either: handing back openai's would price the run against the wrong table
    // while looking entirely correct. Naming the provider alone keeps the key
    // honestly unpriced, which the hook already complains about loudly.
    console.warn(
      `[evestack:budget] no default model known for EVESTACK_PROVIDER="${provider}"; ` +
        `set EVESTACK_BUDGET_MODEL to price this run.`,
    );
    return provider;
  }
  return model.includes("/") ? model : `${provider}/${model}`;
}

export function resolveConfig(options: BudgetOptions = {}): BudgetConfig {
  const disabled =
    process.env.EVESTACK_BUDGET_DISABLED === "1" ||
    process.env.EVESTACK_BUDGET_DISABLED === "true";

  const port = process.env.PORT ?? process.env.EVE_PORT ?? "2000";

  // The two names the siblings accept, in the same order they accept them:
  // `packages/evestack-schedules/src/store.ts` and `packages/dashboard/lib/db.ts`
  // both read `WORKFLOW_POSTGRES_URL ?? DATABASE_URL`. Reading only the first
  // meant that on a PaaS which sets only `DATABASE_URL` — the Heroku, Railway,
  // Render and Neon convention — the dashboard connected and the schedules
  // connected, while this package's pool constructor threw and `hook.ts` caught
  // that throw as "spend store unavailable". A spend cap that silently does not
  // run, with every other half of the app looking healthy, is the worst shape
  // this failure could have taken.
  const databaseUrl = process.env.WORKFLOW_POSTGRES_URL ?? process.env.DATABASE_URL;

  const resolved: BudgetConfig = {
    sessionUsd: disabled
      ? false
      : envNumberOrFalse(process.env.EVESTACK_BUDGET_SESSION_USD, DEFAULT_SESSION_USD),
    dailyUsd: disabled
      ? false
      : envNumberOrFalse(process.env.EVESTACK_BUDGET_DAILY_USD, DEFAULT_DAILY_USD),
    timeZone: validTimeZone(process.env.EVESTACK_BUDGET_TIMEZONE),
    mode: envMode(process.env.EVESTACK_BUDGET_MODE),
    model: envModel(),
    unpricedModel: process.env.EVESTACK_BUDGET_UNPRICED === "stop" ? "stop" : "warn",
    failClosed:
      process.env.EVESTACK_BUDGET_FAIL_CLOSED === "1" ||
      process.env.EVESTACK_BUDGET_FAIL_CLOSED === "true",
    agentUrl: process.env.EVESTACK_BUDGET_AGENT_URL ?? `http://127.0.0.1:${port}`,
    guardTools: (process.env.EVESTACK_BUDGET_GUARD_TOOLS ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name.length > 0),
    ...(process.env.EVESTACK_AUTH_USER ? { authUser: process.env.EVESTACK_AUTH_USER } : {}),
    ...(process.env.EVESTACK_AUTH_PASSWORD
      ? { authPassword: process.env.EVESTACK_AUTH_PASSWORD }
      : {}),
    ...(databaseUrl ? { databaseUrl } : {}),
  };

  const merged = { ...resolved, ...options };

  // Options win over the environment, so the merged value is the one `dayKey`
  // will hand to `Intl` — validate that, not only what the environment said.
  // `budgetHook({ timeZone: "GMT+2" })` is the same mistake made in code and
  // must not get a different outcome; and because `BudgetOptions` is a
  // `Partial`, an explicit `timeZone: undefined` spreads over a good value as
  // `undefined`, which `Intl` rejects as well.
  return { ...merged, timeZone: validTimeZone(merged.timeZone) };
}

/** True when neither axis is capped, i.e. the hook has nothing to enforce. */
export function isUncapped(config: BudgetConfig): boolean {
  return config.sessionUsd === false && config.dailyUsd === false;
}

/**
 * The calendar day a spend lands in, in the configured zone.
 *
 * `en-CA` is the shortest route to a real ISO date from `Intl`; formatting in
 * the target zone is what keeps the window from silently following the host's
 * clock.
 */
export function dayKey(config: BudgetConfig, at: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: config.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}
