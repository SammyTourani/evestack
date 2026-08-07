import type { EveToolCollection } from "@composio/experimental/eve";

/**
 * Which session a step gets: no key, the live one, or nothing while a failure
 * cools off.
 *
 * This is the only stateful logic in the package and it was untestable, because
 * the closure that held it was passed straight into `defineComposioTools` and the
 * only way in was a real Composio handshake. It is also the part with a
 * non-obvious rule to get wrong — see `attempt` below — so it is split out and
 * the network call is injected. Nothing here talks to Composio; index.ts supplies
 * `openTools`.
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

export interface SessionResolverDeps {
  /** The resolved key, or undefined for "Composio is not configured". */
  readonly apiKey: () => string | undefined;
  /** Open a session and return its tools. The only thing that touches network. */
  readonly openTools: (apiKey: string) => Promise<EveToolCollection>;
  readonly log: (message: string) => void;
  readonly retryAfterMs: number;
}

export function createSessionResolver(deps: SessionResolverDeps): () => EveSession {
  let announcedMissingKey = false;
  let live: EveSession | null = null;
  let retryAt = 0;

  return () => {
    const apiKey = deps.apiKey();
    if (!apiKey) {
      // Once, not once per step: eve resolves tools at the start of every step, so
      // an unset key would otherwise print this on every turn forever.
      if (!announcedMissingKey) {
        announcedMissingKey = true;
        deps.log(
          "[evestack:composio] COMPOSIO_API_KEY is not set, so the agent has no Composio tools. " +
            "Everything else works. Set the key to give it one-click access to 1000+ apps.",
        );
      }
      return DISABLED_SESSION;
    }

    if (live) return live;
    if (Date.now() < retryAt) return DISABLED_SESSION;

    // A fresh object each attempt on purpose: `defineComposioTools` caches by
    // session identity, so reusing a failed one would cache the empty tool set
    // for the life of the process.
    const attempt: EveSession = {
      tools: async () => {
        try {
          return await deps.openTools(apiKey);
        } catch (error) {
          // Only if this attempt is still the current one. A later attempt may
          // already have replaced it, and clearing that one would throw away a
          // session that is fine.
          if (live === attempt) live = null;
          retryAt = Date.now() + deps.retryAfterMs;
          deps.log(
            `[evestack:composio] could not reach Composio (${describe(error)}). ` +
              `Continuing without its tools; retrying in ${Math.round(deps.retryAfterMs / 1000)}s.`,
          );
          return NO_TOOLS;
        }
      },
    };
    live = attempt;
    return attempt;
  };
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
