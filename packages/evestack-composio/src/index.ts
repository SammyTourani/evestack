import { Composio } from "@composio/core";
import type { ToolRouterCreateSessionConfig } from "@composio/core";
import { EveProvider, defineComposioTools } from "@composio/experimental/eve";
import type {
  EveAuthLinkContext,
  EveProviderHooks,
  EveProviderOptions,
  EveToolCollection,
} from "@composio/experimental/eve";

export { EveProvider, denyEveToolCall, requireApprovalForTools } from "@composio/experimental/eve";
export type { EveProviderHooks, EveProviderOptions, EveToolCollection };

/**
 * Meta-tools the Tool Router can expose. They are why this scales: the model
 * searches the catalog, connects an account, then executes — instead of ~1000
 * toolkits being loaded into the context window.
 *
 * The router decides the actual subset per session, so treat this as the
 * vocabulary for `requireApprovalForTools()`, not as a guaranteed tool list.
 * Observed against the live API: `manageConnections: false` drops
 * MANAGE_CONNECTIONS, and disabling the remote sandbox drops REMOTE_BASH_TOOL
 * and REMOTE_WORKBENCH. COMPOSIO_EXECUTE_TOOL is a legacy slug the current
 * router no longer returns — MULTI_EXECUTE_TOOL covers both single and batch.
 */
export const COMPOSIO_META_TOOLS = [
  "COMPOSIO_SEARCH_TOOLS",
  "COMPOSIO_GET_TOOL_SCHEMAS",
  "COMPOSIO_MANAGE_CONNECTIONS",
  "COMPOSIO_MULTI_EXECUTE_TOOL",
  "COMPOSIO_EXECUTE_TOOL",
  "COMPOSIO_REMOTE_BASH_TOOL",
  "COMPOSIO_REMOTE_WORKBENCH",
] as const;

/**
 * Composio ties connected accounts to a user id, not to a session — so this is
 * the identity that owns every OAuth grant the agent earns. Keep it stable or
 * the agent forgets which accounts it is signed into.
 */
export const DEFAULT_COMPOSIO_USER_ID = "evestack";

export interface ComposioToolsOptions {
  /** Defaults to `process.env.COMPOSIO_API_KEY`. Absent means "no Composio tools". */
  apiKey?: string;
  /** Defaults to `process.env.EVESTACK_COMPOSIO_USER_ID`, then `"evestack"`. */
  userId?: string;
  /** Restrict the router to these toolkit slugs (e.g. `["gmail", "github"]`). Omit for the whole catalog. */
  toolkits?: string[];
  /**
   * Let the model run code in Composio's hosted sandbox. Off, because evestack
   * already gives it a real bash shell in a local Docker container — turning
   * this on adds a second, remote execution environment on someone else's
   * infrastructure, which is the thing this stack exists to avoid.
   */
  remoteSandbox?: boolean;
  /** Anything else `composio.sessions.create()` accepts. Merged last, so it wins. */
  session?: ToolRouterCreateSessionConfig;
  /** Passed to `EveProvider` — `strict`, `needsApproval`, and `hooks`. */
  provider?: EveProviderOptions;
  /**
   * Called with every Composio Connect Link the router produces. The default
   * prints it, which is how a self-hoster running `eve dev` gets a URL to click.
   */
  onConnectLink?: (url: string, context: EveAuthLinkContext) => void;
  /** Defaults to `console.warn`. */
  logger?: (message: string) => void;
  /** How long to wait before retrying after a failed session handshake. Default 60s. */
  retryAfterMs?: number;
  /** Composio SDK telemetry. Off by default — this is a self-hosted stack. */
  allowTracking?: boolean;
}

type EveSession = { tools: () => Promise<EveToolCollection> };

const NO_TOOLS: EveToolCollection = {};

/**
 * A stable object identity that always resolves to zero tools. `defineComposioTools`
 * memoizes `tools()` per session object, so handing back this singleton makes the
 * disabled path free after the first step instead of re-deciding on every step.
 */
const DISABLED_SESSION: EveSession = { tools: async () => NO_TOOLS };

const DEFAULT_RETRY_AFTER_MS = 60_000;

export function isComposioConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.COMPOSIO_API_KEY?.trim());
}

export function composioUserId(
  env: Record<string, string | undefined> = process.env,
): string {
  return env.EVESTACK_COMPOSIO_USER_ID?.trim() || DEFAULT_COMPOSIO_USER_ID;
}

/**
 * Wire Composio's 1000+ toolkits into an eve agent.
 *
 * Default-export the result from a file under `agent/tools/` and eve will
 * resolve it at the start of every step:
 *
 * ```ts
 * // agent/tools/composio.ts
 * import { composioTools } from "@evestack/composio";
 * export default composioTools();
 * ```
 *
 * Three things this deliberately does NOT do: throw when `COMPOSIO_API_KEY` is
 * missing, throw when Composio is unreachable, or hold the agent's boot on a
 * network call. An agent that cannot reach a SaaS directory is still an agent.
 */
export function composioTools(options: ComposioToolsOptions = {}) {
  const log = options.logger ?? ((message: string) => console.warn(message));
  const retryAfterMs = options.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS;

  let announcedMissingKey = false;
  let live: EveSession | null = null;
  let retryAt = 0;

  return defineComposioTools((): EveSession => {
    const apiKey = options.apiKey ?? process.env.COMPOSIO_API_KEY?.trim();
    if (!apiKey) {
      if (!announcedMissingKey) {
        announcedMissingKey = true;
        log(
          "[evestack:composio] COMPOSIO_API_KEY is not set, so the agent has no Composio tools. " +
            "Everything else works. Set the key to give it one-click access to 1000+ apps.",
        );
      }
      return DISABLED_SESSION;
    }

    if (live) return live;
    if (Date.now() < retryAt) return DISABLED_SESSION;

    // A fresh object each attempt on purpose: `defineComposioTools` caches by
    // session identity, so reusing a failed one would cache the empty tool set.
    const attempt: EveSession = {
      tools: async () => {
        try {
          const session = await openSession(apiKey, options, log);
          return await session.tools();
        } catch (error) {
          if (live === attempt) live = null;
          retryAt = Date.now() + retryAfterMs;
          log(
            `[evestack:composio] could not reach Composio (${describe(error)}). ` +
              `Continuing without its tools; retrying in ${Math.round(retryAfterMs / 1000)}s.`,
          );
          return NO_TOOLS;
        }
      },
    };
    live = attempt;
    return attempt;
  });
}

async function openSession(
  apiKey: string,
  options: ComposioToolsOptions,
  log: (message: string) => void,
) {
  const composio = new Composio({
    apiKey,
    allowTracking: options.allowTracking ?? false,
    provider: new EveProvider({
      ...options.provider,
      hooks: withConnectLinkHook(options, log),
    }),
  });

  const userId = options.userId ?? composioUserId();
  const session = await composio.sessions.create(userId, {
    // The headline feature: the model can initiate its own OAuth flow and hand
    // the user a link, instead of an operator pre-provisioning every connector.
    manageConnections: true,
    sandbox: { enable: options.remoteSandbox ?? false },
    ...(options.toolkits?.length ? { toolkits: options.toolkits } : {}),
    ...options.session,
  });

  for (const warning of session.warnings ?? []) {
    log(`[evestack:composio] ${JSON.stringify(warning)}`);
  }
  return session;
}

function withConnectLinkHook(
  options: ComposioToolsOptions,
  log: (message: string) => void,
): EveProviderHooks {
  const hooks = options.provider?.hooks ?? {};
  const announce =
    options.onConnectLink ??
    ((url: string) => log(`[evestack:composio] connect this account to continue: ${url}`));

  // A Connect Link the user never sees is a dead end, so surfacing it happens
  // even when a caller installs their own onAuthLink — theirs still decides
  // what the model gets back.
  const downstream = hooks.onAuthLink;
  return {
    ...hooks,
    onAuthLink: (context, next) => {
      announce(context.url, context);
      return downstream ? downstream(context, next) : next();
    },
  };
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
