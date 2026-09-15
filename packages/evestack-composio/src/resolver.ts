import type { EveToolCollection } from "@composio/experimental/eve";

/**
 * Which session a step gets: no key, the live one for this principal, or
 * nothing while a failure cools off.
 *
 * This is the only stateful logic in the package and it was untestable, because
 * the closure that held it was passed straight into `defineComposioTools` and the
 * only way in was a real Composio handshake. It is also the part with a
 * non-obvious rule to get wrong — see `attempt` below — so it is split out and
 * the network call is injected. Nothing here talks to Composio; index.ts supplies
 * `openTools`.
 *
 * ─ What this file used to get wrong ─
 *
 * It cached exactly one session, in one variable, with `if (live) return live` —
 * and it ignored the eve context it was handed. Composio binds OAuth grants to a
 * user id, so one cached session meant one Composio identity for everyone: the
 * Gmail account one person connected through the agent was executable by every
 * other principal that ever reached it. On a Slack or Discord channel, where eve
 * mints a distinct principal per human, that is every member of the workspace
 * sharing one inbox.
 *
 * So the cache is now keyed by identity, and the identity is derived from the
 * context (see `composioIdentity` in index.ts, which owns that policy — this
 * file only asks for a key and stores against it). Two things follow, and both
 * are deliberate:
 *
 *  - the map is BOUNDED. An identity can be derived from something an attacker
 *    supplies (a JWT subject, a Slack user id from a public workspace), and an
 *    unbounded map keyed on that is a memory leak with a live Composio session
 *    pinned to every entry. Eviction is least-recently-used and costs nothing
 *    but a later handshake: grants live server-side against the user id, not in
 *    the session object.
 *  - the cooldown after a failed handshake stays PROCESS-WIDE. A Composio
 *    handshake fails because the endpoint is unreachable or the key is bad —
 *    properties of the installation, not of the identity — so a per-identity
 *    cooldown would re-learn the same outage once per principal. It also means
 *    that cycling identities cannot be used to cycle network calls.
 */

export interface EveSession {
  tools: () => Promise<EveToolCollection>;
}

export const NO_TOOLS: EveToolCollection = {};

/**
 * A stable object identity that always resolves to zero tools.
 * `defineComposioTools` memoizes `tools()` per session object, so handing back
 * this singleton makes the disabled path free after the first step instead of
 * re-deciding on every step.
 */
export const DISABLED_SESSION: EveSession = { tools: async () => NO_TOOLS };

export const DEFAULT_RETRY_AFTER_MS = 60_000;

/**
 * How many Composio identities keep a live session at once.
 *
 * A real install has a handful of principals — the person at the keyboard, the
 * scheduled-run principal, one row per teammate. 64 is far past any plausible
 * legitimate concurrency and small enough that the worst case is bounded and
 * cheap: 64 session objects, each a few hundred bytes plus whatever
 * `defineComposioTools` memoized against it. The 65th distinct identity evicts
 * the least recently used one, which costs that principal one handshake the
 * next time it is seen and nothing else.
 */
export const DEFAULT_MAX_IDENTITIES = 64;

/**
 * The principal eve resolved for the request that started this step.
 *
 * Structurally typed rather than imported from `eve/channels/types`, for the
 * same reason the resolver takes its network as a parameter: this package is
 * testable without eve, and a widened field upstream should not be able to
 * break the build of a package that reads four strings out of it. The names and
 * their meaning were read out of eve 0.30.8 (`SessionAuthContext` in
 * `dist/src/channel/types.d.ts`), not guessed.
 */
export interface ComposioPrincipal {
  /** How the caller proved who they are: `http-basic`, `oidc`, `slack-webhook`, `local-dev`, … */
  readonly authenticator?: string;
  /** Who vouched for the id, when the authenticator has an issuer (OIDC, JWT). */
  readonly issuer?: string;
  /** The caller's id within that issuer. A Slack user id, a JWT subject, a Basic username. */
  readonly principalId?: string;
  /** `user`, `service`, `runtime`, `local-dev`, `anonymous`. */
  readonly principalType?: string;
}

/**
 * The slice of eve's `DynamicResolveContext` this package reads.
 *
 * eve hands the resolver the whole context (session id, auth, channel metadata,
 * the visible message history). Everything here is optional because a structural
 * type that demands fields is a type that fails to accept the real one after any
 * upstream widening — and because this same resolver is called with nothing at
 * all by the tests, and by any caller that resolves a session outside a step.
 */
export interface ComposioResolveContext {
  readonly session?: {
    readonly id?: string;
    readonly auth?: {
      /** The caller of the most recent request. */
      readonly current?: ComposioPrincipal | null;
      /** The caller who originally created the session. */
      readonly initiator?: ComposioPrincipal | null;
    } | null;
  } | null;
}

/**
 * The cache key used when no `identify` is supplied.
 *
 * Not the empty string: a blank key reads as "no identity" at a glance in a log
 * or a debugger, and this one means the opposite — one shared bucket, chosen on
 * purpose. index.ts always supplies `identify`, so this is only reached by a
 * caller wiring the resolver up by hand.
 */
export const SINGLE_IDENTITY_KEY = "default";

export interface SessionResolverDeps {
  /** The resolved key, or undefined for "Composio is not configured". */
  readonly apiKey: () => string | undefined;
  /**
   * Open a session for one identity and return its tools. The only thing that
   * touches network. `identity` is passed through to `sessions.create()` as the
   * Composio user id, which is what OAuth grants hang off.
   */
  readonly openTools: (apiKey: string, identity: string) => Promise<EveToolCollection>;
  readonly log: (message: string) => void;
  readonly retryAfterMs: number;
  /**
   * Who this step is for. Defaults to one shared bucket, which is the old
   * behaviour — index.ts passes `composioIdentity` and every real caller gets
   * per-principal isolation.
   */
  readonly identify?: (context: ComposioResolveContext | undefined) => string;
  /**
   * Defaults to {@link DEFAULT_MAX_IDENTITIES}. Values below 1 are clamped to
   * 1, and anything that is not a finite number falls back to the default —
   * see {@link boundedIdentityCap} for why that last case is not pedantry.
   */
  readonly maxIdentities?: number;
}

export function createSessionResolver(
  deps: SessionResolverDeps,
): (context?: ComposioResolveContext) => EveSession {
  const identify = deps.identify ?? (() => SINGLE_IDENTITY_KEY);
  const maxIdentities = boundedIdentityCap(deps.maxIdentities);

  let announcedMissingKey = false;
  let retryAt = 0;
  // Insertion-ordered, so the first key is always the least recently used one:
  // every hit re-inserts. A Map is the whole LRU here — a real LRU class would
  // be more code than the eviction it performs.
  const live = new Map<string, EveSession>();

  return (context?: ComposioResolveContext) => {
    const apiKey = deps.apiKey();
    if (!apiKey) {
      // Once, not once per step: eve resolves tools at the start of every step, so
      // an unset key would otherwise print this on every turn forever.
      if (!announcedMissingKey) {
        announcedMissingKey = true;
        deps.log(
          "[evestack:composio] COMPOSIO_API_KEY is not set, so the agent has no Composio tools. " +
            "Everything else works. Set the key to reach 1,000+ toolkits; the " +
            "Composio-managed OAuth ones connect in one click.",
        );
      }
      return DISABLED_SESSION;
    }

    const identity = identify(context);

    const cached = live.get(identity);
    if (cached) {
      // Re-insert to mark it most recently used. `defineComposioTools` keys its
      // own memo on the object we return, so handing back the same object is
      // also what keeps a live principal from re-handshaking every step.
      live.delete(identity);
      live.set(identity, cached);
      return cached;
    }

    // Checked after the cache on purpose: an outage must not take away a session
    // that is already open and working for someone else.
    if (Date.now() < retryAt) return DISABLED_SESSION;

    // A fresh object each attempt on purpose: `defineComposioTools` caches by
    // session identity, so reusing a failed one would cache the empty tool set
    // for the life of the process.
    const attempt: EveSession = {
      tools: async () => {
        try {
          return await deps.openTools(apiKey, identity);
        } catch (error) {
          // Only if this attempt is still the current one for THIS identity. A
          // later attempt may already have replaced it, and clearing that one
          // would throw away a session that is fine. (The same guard also stops
          // a failure arriving after eviction from deleting whatever identity
          // happens to be at that key now.)
          if (live.get(identity) === attempt) live.delete(identity);
          retryAt = Date.now() + deps.retryAfterMs;
          deps.log(
            `[evestack:composio] could not reach Composio (${describe(error)}). ` +
              `Continuing without its tools; retrying in ${Math.round(deps.retryAfterMs / 1000)}s.`,
          );
          return NO_TOOLS;
        }
      },
    };
    live.set(identity, attempt);
    evictOldest(live, maxIdentities);
    return attempt;
  };
}

/**
 * How big the identity cache is allowed to get, given what a caller asked for.
 *
 * This was written inline as `Math.max(1, Math.floor(n ?? DEFAULT))`, which is
 * the obvious clamp and has one hole that happens to be the exact failure this
 * whole cache exists to prevent. `Math.max(1, NaN)` is NaN, and `size > NaN` is
 * false for every size — so a single non-finite value does not clamp, it
 * silently removes the bound, and the map grows forever with a live session
 * pinned to every entry an attacker-supplied identity creates. Nothing would
 * have failed; the leak would only appear on an install nobody tests.
 *
 * NaN is not an exotic input for a numeric option in a self-hosted stack.
 * `Number(process.env.SOMETHING)` is how people wire one up, and it is NaN for
 * a variable that is unset or misspelt — the same class of mistake contract 19
 * exists for. Infinity is rejected on the same line rather than honoured as
 * "unbounded": the point of a cap is that there is one, and a caller who really
 * wants every identity resident can say a large number out loud.
 *
 * It falls back rather than throwing, because a bad cache size is not a reason
 * to take a working agent down — the same rule this package applies to a
 * missing key and an unreachable endpoint.
 */
function boundedIdentityCap(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_MAX_IDENTITIES;
  return Math.max(1, Math.floor(requested));
}

/**
 * Drop least-recently-used entries until the map fits.
 *
 * A loop rather than a single delete because `maxIdentities` is a parameter: a
 * caller lowering it at construction should not leave the map permanently one
 * over its own limit.
 */
function evictOldest(live: Map<string, EveSession>, maxIdentities: number): void {
  while (live.size > maxIdentities) {
    const oldest = live.keys().next();
    if (oldest.done) return;
    live.delete(oldest.value);
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
