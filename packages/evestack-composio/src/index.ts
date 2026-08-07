import { Composio } from "@composio/core";
import type { ToolRouterCreateSessionConfig } from "@composio/core";
import { EveProvider, defineComposioTools } from "@composio/experimental/eve";
import type {
  EveAuthLinkContext,
  EveProviderHooks,
  EveProviderOptions,
  EveToolCollection,
} from "@composio/experimental/eve";

import { DEFAULT_RETRY_AFTER_MS, createSessionResolver } from "./resolver.js";

export { EveProvider, denyEveToolCall, requireApprovalForTools } from "@composio/experimental/eve";
export type { EveProviderHooks, EveProviderOptions, EveToolCollection };

/**
 * Meta-tools the Tool Router can expose. They are why this scales: the model
 * searches the catalog, connects an account, then executes — instead of ~1000
 * toolkits being loaded into the context window.
 *
 * Public because it is the vocabulary for `requireApprovalForTools()` — see the
 * README — not because it is a guaranteed tool list: the router decides the
 * actual subset per session. Observed against the live API:
 * `manageConnections: false` drops MANAGE_CONNECTIONS, and disabling the remote
 * sandbox drops REMOTE_BASH_TOOL and REMOTE_WORKBENCH.
 *
 * COMPOSIO_EXECUTE_TOOL is deliberately absent: it is a legacy slug the current
 * router no longer returns, and MULTI_EXECUTE_TOOL covers both single and batch.
 * It was listed here anyway, which made this list wrong in the one direction that
 * matters — a caller who spread it into `requireApprovalForTools()` was gating a
 * tool that never arrives, and would have read that as "execution is approved
 * before it runs".
 */
export const COMPOSIO_META_TOOLS = [
  "COMPOSIO_SEARCH_TOOLS",
  "COMPOSIO_GET_TOOL_SCHEMAS",
  "COMPOSIO_MANAGE_CONNECTIONS",
  "COMPOSIO_MULTI_EXECUTE_TOOL",
  "COMPOSIO_REMOTE_BASH_TOOL",
  "COMPOSIO_REMOTE_WORKBENCH",
] as const;

/**
 * Composio ties connected accounts to a user id, not to a session — so this is
 * the identity that owns every OAuth grant the agent earns. Keep it stable or
 * the agent forgets which accounts it is signed into.
 *
 * Exported because it must have exactly one definition, and today it has two:
 * `packages/dashboard/app/integrations/composio.ts` declares the same literal
 * again. Two independent definitions of the identity that owns every OAuth grant
 * is precisely the drift this README warns about — change one and the dashboard
 * lists accounts the agent cannot see, with no error anywhere. The dashboard
 * should import this instead; that is a one-line change on its side.
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

/**
 * Whether Composio is configured at all, without opening a session.
 *
 * Public and documented in the README rather than deleted, because the question
 * is asked outside the agent: the dashboard's `/integrations` page has to decide
 * whether to render a connect flow or an explanation, and it currently answers it
 * with its own copy of this check.
 *
 * `env` is a parameter rather than a `process.env` read so it can be tested and
 * so a caller holding a different environment (a request-scoped config, a test)
 * is not forced to mutate the global one.
 */
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

  // The decision of WHICH session a step gets — no key, the live one, or nothing
  // while a failure cools off — lives in ./resolver.ts with the network injected,
  // because it is the only stateful logic here and it was unreachable from a test
  // while it sat inside this closure.
  return defineComposioTools(
    createSessionResolver({
      apiKey: () => options.apiKey ?? process.env.COMPOSIO_API_KEY?.trim(),
      openTools: async (apiKey) => (await openSession(apiKey, options, log)).tools(),
      log,
      retryAfterMs: options.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS,
    }),
  );
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
