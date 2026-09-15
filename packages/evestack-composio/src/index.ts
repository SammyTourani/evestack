import { createHash } from "node:crypto";

import { Composio } from "@composio/core";
import type { ToolRouterCreateSessionConfig } from "@composio/core";
import { EveProvider, defineComposioTools } from "@composio/experimental/eve";
import type {
  EveAuthLinkContext,
  EveNeedsApproval,
  EveProviderHooks,
  EveProviderOptions,
  EveToolCollection,
} from "@composio/experimental/eve";

import { DEFAULT_RETRY_AFTER_MS, createSessionResolver } from "./resolver.js";
import type { ComposioPrincipal, ComposioResolveContext } from "./resolver.js";

export { EveProvider, denyEveToolCall, requireApprovalForTools } from "@composio/experimental/eve";
export type { EveNeedsApproval, EveProviderHooks, EveProviderOptions, EveToolCollection };
export type { ComposioPrincipal, ComposioResolveContext };

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
 * the NAMESPACE that owns every OAuth grant the agent earns. Keep it stable or
 * the agent forgets which accounts it is signed into.
 *
 * It used to be the whole answer: every principal on the agent resolved to this
 * one string, so the Gmail account one person connected was executable by
 * everybody else. It is now the base of a per-principal identity — see
 * {@link composioIdentity} for the full rule and for what stays on this bare
 * value, which is everything a single-user install has.
 *
 * Exported because it must have exactly one definition, and today it has two:
 * `packages/dashboard/app/integrations/composio.ts` declares the same literal
 * again. Two independent definitions of the identity that owns every OAuth grant
 * is precisely the drift this README warns about — change one and the dashboard
 * lists accounts the agent cannot see, with no error anywhere. The dashboard
 * should import this instead; that is a one-line change on its side.
 */
export const DEFAULT_COMPOSIO_USER_ID = "evestack";

/**
 * What separates the namespace from the per-principal part of an identity.
 *
 * Two hyphens, and the whole identity stays inside `[A-Za-z0-9._-]` — the
 * URL-unreserved set — because this string is a Composio user id that travels
 * through their API and shows up in their dashboard, and nothing in their docs
 * promises what happens to a user id containing an `@`, a space, or a `/`. A
 * principal id that contains any of those is sanitized rather than trusted; see
 * {@link composioIdentity}.
 */
export const COMPOSIO_IDENTITY_SEPARATOR = "--";

/**
 * Authenticators that identify the INSTALLATION rather than a person, and which
 * therefore all share the namespace identity.
 *
 * This list is the whole compatibility story, so it is worth being exact about
 * why each entry is on it. Every value was read out of eve 0.30.8's own dist,
 * not guessed:
 *
 *  - `local-dev` — `localDev()` mints `{principalId: "local-dev",
 *    principalType: "local-dev"}` for every request inside an `eve dev` process.
 *    It is the person at the keyboard, and there is exactly one of them.
 *  - `http-basic` — eve mints `{principalId: <the configured username>}`. In
 *    evestack that username is ONE credential generated per install
 *    (EVESTACK_AUTH_USER / EVESTACK_AUTH_PASSWORD) and shared by everyone who
 *    can sign in, including the dashboard. Isolating those callers from each
 *    other would be theatre — they all hold the same secret — while breaking
 *    every existing install's dashboard access to its own connected accounts.
 *  - `none` — the `none()` authenticator, principal `anonymous`. There is no
 *    identity information in the request at all, so there is nothing to isolate
 *    on. If your auth chain cannot tell your callers apart, neither can this.
 *  - `app` — eve's scheduled runs carry `{authenticator: "app", principalId:
 *    "eve:app", principalType: "runtime"}` (`dist/src/channel/schedule-auth.js`).
 *    A cron turn that summarizes your inbox every morning must keep reaching the
 *    accounts the install connected, or every scheduled job in every existing
 *    install silently loses its connectors on upgrade.
 *
 * Everything else — `oidc`, `jwt-hmac`, `jwt-ecdsa`, and every channel webhook
 * (`slack-webhook`, `discord-interaction`, `telegram-webhook`, `teams-activity`,
 * `github-webhook`, `linear-agent-webhook`, `twilio-webhook`) — carries a real
 * per-person id, and those are exactly the deployments where one shared Composio
 * identity meant one shared inbox. They get their own identity.
 *
 * Override it with `sharedAuthenticators` if you have genuinely configured
 * several distinct `httpBasic()` users and want them separated.
 */
export const SHARED_CREDENTIAL_AUTHENTICATORS = [
  "local-dev",
  "http-basic",
  "none",
  "app",
] as const;

/** Set to `1` to collapse every principal back onto one Composio identity. */
export const SHARED_IDENTITY_ENV = "EVESTACK_COMPOSIO_SHARED_IDENTITY";

/** Set to `off` to run Composio's write tools with no human in the loop. */
export const APPROVALS_ENV = "EVESTACK_COMPOSIO_APPROVALS";

export interface ComposioToolsOptions {
  /** Defaults to `process.env.COMPOSIO_API_KEY`. Absent means "no Composio tools". */
  apiKey?: string;
  /**
   * The namespace every identity is built under. Defaults to
   * `process.env.EVESTACK_COMPOSIO_USER_ID`, then `"evestack"`.
   */
  namespace?: string;
  /**
   * The older name for {@link namespace}, kept because it is in the published
   * README and in people's agents. It used to be the complete Composio user id;
   * it is now the base one, which is the same string for every install that has
   * only the principals in {@link SHARED_CREDENTIAL_AUTHENTICATORS}.
   */
  userId?: string;
  /**
   * Put every principal back on one Composio identity — the behaviour before
   * per-principal isolation existed. Defaults to
   * `EVESTACK_COMPOSIO_SHARED_IDENTITY=1`. Say yes only if you know every caller
   * of this agent is the same person, because it makes one person's connected
   * accounts executable by all of them.
   */
  sharedIdentity?: boolean;
  /** Overrides {@link SHARED_CREDENTIAL_AUTHENTICATORS}. */
  sharedAuthenticators?: readonly string[];
  /** How many identities keep a live session. Default 64; see `DEFAULT_MAX_IDENTITIES`. */
  maxCachedIdentities?: number;
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
  /**
   * Passed to `EveProvider` — `strict`, `needsApproval`, and `hooks`. Leave
   * `needsApproval` out and you get {@link composioApprovals}; pass it
   * explicitly (`undefined` included) and yours is the only policy.
   */
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

/**
 * The namespace: `EVESTACK_COMPOSIO_USER_ID` trimmed, else `"evestack"`.
 *
 * The name is the one this package has always published and the resolution
 * order is unchanged, because it is the string a single-user install's grants
 * already hang off — renaming it or folding a principal into it by default
 * would orphan every account anyone has connected. What changed is what sits
 * on top: see {@link composioIdentity}.
 */
export function composioUserId(
  env: Record<string, string | undefined> = process.env,
): string {
  return env.EVESTACK_COMPOSIO_USER_ID?.trim() || DEFAULT_COMPOSIO_USER_ID;
}

/**
 * Whether `EVESTACK_COMPOSIO_SHARED_IDENTITY` asks for the old single identity.
 *
 * Written `env.EVESTACK_…` rather than `env[SHARED_IDENTITY_ENV]`, even though
 * the constant is right there, for the same reason `composioUserId` is: the
 * env-names contract (`contract/contracts/19-env-names.contract.mjs`) finds
 * reads by pattern, and it resolves a constant only through `process.env[CONST]`
 * — never through an injected `env` parameter. A variable this README documents
 * and that the contract cannot see being read is reported as a setting a user
 * can turn on and get silence from, which is exactly the class of bug that
 * contract exists for. `identity.test.mjs` pins the constant against the read so
 * the two cannot drift apart.
 */
export function isSharedComposioIdentity(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env.EVESTACK_COMPOSIO_SHARED_IDENTITY?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export interface ComposioIdentityOptions {
  /** Defaults to {@link composioUserId}. */
  readonly namespace?: string;
  /** Defaults to {@link isSharedComposioIdentity}. */
  readonly shared?: boolean;
  /** Defaults to {@link SHARED_CREDENTIAL_AUTHENTICATORS}. */
  readonly sharedAuthenticators?: readonly string[];
}

/**
 * Which Composio user id a step runs under — the fix for "one Composio identity
 * for everyone".
 *
 * Composio binds an OAuth grant to a user id. This package used to hand every
 * step the same user id, so the Gmail account one person connected through the
 * agent was executable by every other principal that ever reached it: every
 * member of a Slack workspace, every holder of a JWT, sharing one inbox and one
 * calendar. Nothing in the tool call said so, and the session cache made it
 * permanent for the life of the process.
 *
 * The rule now:
 *
 *  1. `shared` (or `EVESTACK_COMPOSIO_SHARED_IDENTITY=1`) returns the namespace
 *     for everyone. That is the old behaviour, kept and named rather than left
 *     as the default.
 *  2. No principal at all — no eve context, or a session eve never authenticated
 *     — is the installation, and keeps the accounts the install connected. A
 *     caller resolving a session outside a step lands here.
 *
 *     A dispatched subagent does NOT, and an earlier version of this comment
 *     said it did. eve carries the dispatching turn's `AuthKey` and
 *     `InitiatorAuthKey` into the child on every path it has — the local one
 *     (`startWorkflowTask({ auth, initiatorAuth, … })` in
 *     `dist/src/execution/coordination-dispatch-step.js`) and the remote one
 *     (`dispatchSession({ command: { auth, … } })` in
 *     `dist/src/subagents/handle-dispatch.js`), read out of 0.54.3, with the
 *     same pair present in 0.30.8's `dispatch-runtime-actions-step.js`. So a
 *     subagent acts as whoever dispatched it. That is the answer this rule
 *     wants: had the comment been right, a Slack user's subagent would have
 *     quietly inherited the installation's connected accounts and walked
 *     straight back through the hole the rest of this function closes.
 *  3. A principal whose authenticator is in `sharedAuthenticators` is the
 *     installation too, for the reasons written out on
 *     {@link SHARED_CREDENTIAL_AUTHENTICATORS}. This is what makes a single-user
 *     install byte-identical to what it resolved before: `eve dev`, the
 *     dashboard's Basic credential, and scheduled runs all still resolve to the
 *     bare namespace.
 *  4. Everyone else gets `<namespace>--<label>-<fingerprint>`, which is stable
 *     across restarts (it is a pure function of the principal) and distinct per
 *     person.
 *
 * `current` before `initiator` mirrors `principalOf()` in `@evestack/budget`: a
 * shared session is charged to, and here acts as, whoever is actually driving it
 * rather than whoever opened it.
 *
 * The fingerprint is not decoration. The label is sanitized and truncated, which
 * is lossy — two principals whose ids differ only past the 48th character, or
 * only in characters that sanitize to `_`, would otherwise collide into one
 * identity and one inbox. The digest is taken over the untouched `issuer` +
 * `principalId`, so it restores what the label throws away. Issuer first, and
 * ahead of the authenticator, because eve keys its own connection principals the
 * same way (`user:${issuer}:${id}` in `runtime/connections/principal.js`): two
 * identity providers that both call someone `alice` are two different people.
 */
export function composioIdentity(
  context?: ComposioResolveContext,
  options: ComposioIdentityOptions = {},
  env: Record<string, string | undefined> = process.env,
): string {
  const namespace = options.namespace?.trim() || composioUserId(env);
  if (options.shared ?? isSharedComposioIdentity(env)) return namespace;

  const auth = context?.session?.auth;
  const principal: ComposioPrincipal | null | undefined = auth?.current ?? auth?.initiator;
  if (!principal) return namespace;

  const authenticator = principal.authenticator?.trim() ?? "";
  const shared = options.sharedAuthenticators ?? SHARED_CREDENTIAL_AUTHENTICATORS;
  if (authenticator && shared.includes(authenticator)) return namespace;

  // Fails closed, and the two branches are different failures. An authenticator
  // eve does not name is not on the shared list, so it is treated as a person:
  // the cost of being wrong is one extra Connect Link, not one shared mailbox.
  // A principal with no usable id at all is a malformed principal — eve types
  // `principalId` as a required non-empty string — so it gets its own dead-end
  // bucket rather than inheriting the installation's accounts.
  const realm = principal.issuer?.trim() || authenticator || "unknown";
  const principalId = principal.principalId?.trim() ?? "";
  const label = sanitizeLabel(principalId ? `${realm}_${principalId}` : `${realm}_unidentified`);
  // Length-prefixed rather than joined on a separator: `realm` and
  // `principalId` are both arbitrary strings, so any character used to join
  // them is one either half could also contain, and `a:b` + `c` would hash
  // the same as `a` + `b:c` — two people, one identity, one inbox.
  const digest = createHash("sha256")
    .update(`${realm.length}:${realm}:${principalId}`, "utf8")
    .digest("hex");
  return `${namespace}${COMPOSIO_IDENTITY_SEPARATOR}${label}-${digest.slice(0, 12)}`;
}

/** Longest the readable half of an identity gets. The digest after it carries the rest. */
const IDENTITY_LABEL_MAX = 48;

function sanitizeLabel(raw: string): string {
  // Runs collapse to a single `_` so that an email and its punctuation-stripped
  // twin do not turn into two nearly-identical unreadable labels. Everything
  // left is ASCII, so slicing cannot split a character in half.
  return raw.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, IDENTITY_LABEL_MAX);
}

/**
 * Meta-tools that always ask, whatever they are pointed at.
 *
 * MANAGE_CONNECTIONS is the tool that binds a new OAuth grant to this agent's
 * Composio identity. It is how the agent gains a capability it did not have,
 * which makes it the single highest-consequence call in the package and one a
 * human presses maybe twice a year. The two remote-sandbox tools are arbitrary
 * code execution on someone else's machine; they only exist when
 * `remoteSandbox` is on, and if it is on they are worth a prompt.
 *
 * SEARCH_TOOLS and GET_TOOL_SCHEMAS read the catalog and execute nothing, so
 * gating them would train people to click through approvals, which is worse
 * than not asking.
 */
export const APPROVAL_GATED_META_TOOLS = [
  "COMPOSIO_MANAGE_CONNECTIONS",
  "COMPOSIO_REMOTE_BASH_TOOL",
  "COMPOSIO_REMOTE_WORKBENCH",
] as const;

/**
 * Verbs that only read, as the first or last word of a Composio action slug.
 *
 * Composio slugs are `TOOLKIT_ACTION` in caps — `GMAIL_FETCH_EMAILS`,
 * `GITHUB_CREATE_ISSUE`, `SLACK_SEND_MESSAGE` — and with 1,000+ toolkits no
 * hand-written allowlist of tool names can ever be complete. So the policy is
 * inverted: a short closed list of read verbs passes and EVERYTHING ELSE ASKS.
 * Getting a read verb wrong costs one unnecessary approval prompt; getting a
 * write verb wrong sends the email. Those are not the same mistake, so the list
 * that has to be complete is the one where being wrong is cheap.
 *
 * Last word as well as first because both orders are in the catalog
 * (`GMAIL_LIST_DRAFTS`, `GOOGLECALENDAR_EVENTS_LIST`).
 */
export const READ_ONLY_TOOL_VERBS: readonly string[] = [
  "COUNT",
  "DESCRIBE",
  "DOWNLOAD",
  "FETCH",
  "FIND",
  "GET",
  "LIST",
  "LOOKUP",
  "QUERY",
  "READ",
  "RETRIEVE",
  "SEARCH",
  "SHOW",
  "VIEW",
];

/**
 * Verbs that mean a write wherever they appear in the action.
 *
 * The read list above is checked at the ends of the slug, which would let
 * something like `GMAIL_DELETE_DRAFT_LIST` read as a list. Any of these words
 * anywhere in the action overrides that. Short on purpose: it is a backstop for
 * the positional rule, not an attempt to enumerate every way a tool can write.
 */
export const WRITE_TOOL_VERBS: readonly string[] = [
  "ADD",
  "ARCHIVE",
  "CANCEL",
  "CHARGE",
  "CREATE",
  "DELETE",
  "DEPLOY",
  "EXECUTE",
  "INVITE",
  "MERGE",
  "MOVE",
  "PAY",
  "POST",
  "PUBLISH",
  "PURGE",
  "REFUND",
  "REMOVE",
  "REPLY",
  "REVOKE",
  "SEND",
  "SET",
  "SHARE",
  "TRANSFER",
  "TRASH",
  "UPDATE",
  "UPLOAD",
  "WRITE",
];

/**
 * Whether a Composio tool slug is one this package is willing to run unattended.
 *
 * Unknown shapes — a slug with no action part, an empty string, a name that is
 * all nouns — come back `false`, which means "ask". See the comment on
 * {@link READ_ONLY_TOOL_VERBS} for why the uncertain answer is the cautious one.
 */
export function isReadOnlyComposioTool(slug: string): boolean {
  const tokens = slug.toUpperCase().split("_").filter(Boolean);
  // Token 0 is the toolkit (GMAIL, GITHUB, NOTION). The action is the rest.
  const action = tokens.slice(1);
  if (action.length === 0) return false;
  if (action.some((token) => WRITE_TOOL_VERBS.includes(token))) return false;
  return (
    READ_ONLY_TOOL_VERBS.includes(action[0]) ||
    READ_ONLY_TOOL_VERBS.includes(action[action.length - 1])
  );
}

/**
 * Ask a human before Composio writes anything, or connects an account.
 *
 * This closes an asymmetry that was impossible to defend: deleting one row of
 * the agent's local memory parked the turn and waited for a person (the
 * template's `agent/tools/forget.ts` has always carried an approval gate), while
 * `COMPOSIO_MULTI_EXECUTE_TOOL` could send mail from your account, post to your
 * Slack, or close your GitHub issues with nothing in the loop at all, because
 * `needsApproval` was never set on the provider.
 *
 * The batch case is the one that matters and the one an approval policy usually
 * misses: the model does not call `GMAIL_SEND_EMAIL`, it calls
 * `COMPOSIO_MULTI_EXECUTE_TOOL` with a list of tools inside its arguments. So
 * this walks that list, the way the SDK's own `requireApprovalForTools` does —
 * `context.toolInput.tools[].tool_slug`, uppercased — and asks if ANY entry in
 * the batch writes. A batch that cannot be read (missing, not an array, an entry
 * with no string slug) asks too: the SDK's helper returns false there, which is
 * right for "gate these named tools" and wrong for "gate anything that writes",
 * because an unreadable batch is exactly the shape that must not slip through.
 *
 * `alsoRequire` adds specific slugs on top, for the reads you consider sensitive
 * anyway — `requireApprovalForWrites("GMAIL_FETCH_EMAILS")`.
 */
export function requireApprovalForWrites(...alsoRequire: string[]): EveNeedsApproval {
  const extra = new Set(alsoRequire.map((slug) => slug.trim().toUpperCase()).filter(Boolean));
  const gated = new Set<string>(APPROVAL_GATED_META_TOOLS);
  const asks = (slug: string) => extra.has(slug) || gated.has(slug) || !isReadOnlyComposioTool(slug);

  return (tool, context) => {
    const slug = tool.slug.toUpperCase();
    if (extra.has(slug) || gated.has(slug)) return true;

    if (slug === "COMPOSIO_MULTI_EXECUTE_TOOL") {
      const requested = context.toolInput?.tools;
      if (!Array.isArray(requested)) return true;
      return requested.some((item) => {
        if (typeof item !== "object" || item === null) return true;
        const inner = (item as { tool_slug?: unknown }).tool_slug;
        return typeof inner === "string" ? asks(inner.toUpperCase()) : true;
      });
    }

    // The legacy single-execute slug. The current router does not return it —
    // which is why it is not in COMPOSIO_META_TOOLS — but the SDK still routes
    // hooks for it, so if it ever comes back it is read the same way rather
    // than falling through to the catalog rule below and passing as a meta-tool.
    if (slug === "COMPOSIO_EXECUTE_TOOL") {
      const inner = context.toolInput?.tool_slug;
      return typeof inner === "string" ? asks(inner.toUpperCase()) : true;
    }

    // SEARCH_TOOLS / GET_TOOL_SCHEMAS reach this: they read the catalog and run
    // nothing. Anything else with this prefix is a meta-tool this package has
    // not seen, so it asks.
    if (slug.startsWith("COMPOSIO_")) {
      return slug !== "COMPOSIO_SEARCH_TOOLS" && slug !== "COMPOSIO_GET_TOOL_SCHEMAS";
    }

    // An app tool the router exposed directly (`sessionPreset: DIRECT_TOOLS`).
    return !isReadOnlyComposioTool(slug);
  };
}

/**
 * The approval policy `composioTools()` installs when the caller does not supply
 * one: {@link requireApprovalForWrites}, unless `EVESTACK_COMPOSIO_APPROVALS` is
 * `off`.
 *
 * Returning `undefined` for the off switch is not a shortcut — it is the exact
 * value `EveProvider` reads as "no approval policy" (`toEveApprovalPolicy`
 * returns early on a falsy policy), so the disabled path is byte-identical to
 * how this package behaved before any of this existed.
 *
 * This IS a behaviour change for an existing install: a turn that used to send
 * an email now parks and waits for a person. That is the point, and it is the
 * safe direction; `EVESTACK_COMPOSIO_APPROVALS=off` puts it back for anyone
 * running unattended who has decided they are fine with that.
 */
export function composioApprovals(
  env: Record<string, string | undefined> = process.env,
): EveNeedsApproval | undefined {
  // Dotted rather than `env[APPROVALS_ENV]`, for the reason on
  // {@link isSharedComposioIdentity}: a documented variable whose read the
  // env-names contract cannot see is reported as a switch that does nothing.
  const setting = env.EVESTACK_COMPOSIO_APPROVALS?.trim().toLowerCase();
  if (setting === "off" || setting === "0" || setting === "false" || setting === "none") {
    return undefined;
  }
  return requireApprovalForWrites();
}

/**
 * Wire Composio's 1,000+ toolkits into an eve agent.
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

  // Once per process, the first time a principal resolves to something other
  // than the installation identity. A self-hoster who adds SSO and is suddenly
  // asked to connect Gmail again deserves one line explaining why, and an
  // attacker cycling identities cannot turn that line into a log flood.
  let announcedIsolation = false;

  // The decision of WHICH session a step gets — no key, the live one for this
  // principal, or nothing while a failure cools off — lives in ./resolver.ts
  // with the network injected, because it is the only stateful logic here and it
  // was unreachable from a test while it sat inside this closure. WHO the step
  // is for stays here, next to the namespace it is built from.
  return defineComposioTools(
    createSessionResolver({
      apiKey: () => options.apiKey ?? process.env.COMPOSIO_API_KEY?.trim(),
      openTools: async (apiKey, identity) =>
        (await openSession(apiKey, identity, options, log)).tools(),
      identify: (context) => {
        const identityOptions = {
          namespace: options.namespace ?? options.userId,
          shared: options.sharedIdentity,
          sharedAuthenticators: options.sharedAuthenticators,
        };
        const identity = composioIdentity(context, identityOptions);
        // Compared against the installation's own identity rather than sniffed
        // for the separator, because a namespace can legitimately contain one:
        // `EVESTACK_COMPOSIO_USER_ID=team--a` would otherwise announce isolation
        // to an install that has none. The extra call is a pure function of the
        // env and only runs until the line has been printed once.
        if (!announcedIsolation && identity !== composioIdentity(undefined, identityOptions)) {
          announcedIsolation = true;
          log(
            "[evestack:composio] this caller has its own Composio identity, so it connects its own " +
              "accounts and cannot use anyone else's. Set " +
              `${SHARED_IDENTITY_ENV}=1 to share one set of connected accounts across every caller.`,
          );
        }
        return identity;
      },
      log,
      retryAfterMs: options.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS,
      maxIdentities: options.maxCachedIdentities,
    }),
  );
}

async function openSession(
  apiKey: string,
  identity: string,
  options: ComposioToolsOptions,
  log: (message: string) => void,
) {
  const composio = new Composio({
    apiKey,
    allowTracking: options.allowTracking ?? false,
    provider: new EveProvider(composioProviderOptions(options, log)),
  });

  const session = await composio.sessions.create(identity, {
    // The headline feature: the model can initiate its own OAuth flow and hand
    // the user a link, instead of an operator pre-provisioning every connector.
    // It is scoped to `identity`, so what it connects belongs to that principal.
    manageConnections: true,
    sandbox: { enable: options.remoteSandbox ?? false },
    ...(options.toolkits?.length ? { toolkits: options.toolkits } : {}),
    ...options.session,
  });

  for (const warning of session.warnings ?? []) {
    // The identity is in the line because a warning about a session is not
    // actionable without knowing whose session it was. The API key never is.
    log(`[evestack:composio] ${identity}: ${JSON.stringify(warning)}`);
  }
  return session;
}

/**
 * What `EveProvider` is actually constructed with.
 *
 * Exported for one reason: "an agent that does not configure approvals gets
 * them anyway" is a security rule, and a security rule nobody can assert on is a
 * wish. The only other way to observe this decision is to complete a Composio
 * handshake, which is exactly the dependency `./resolver.ts` was split out to
 * escape. `log` is optional so the assertion does not have to fake a logger.
 */
export function composioProviderOptions(
  options: ComposioToolsOptions = {},
  log: (message: string) => void = () => {},
): EveProviderOptions {
  const provider = options.provider ?? {};

  // `in`, not `?? `. A caller who writes `needsApproval: undefined` has said
  // "no approvals" out loud and must not have a default quietly put back — that
  // is the difference between an option and a suggestion. Everyone who simply
  // did not mention it gets the safe policy.
  const needsApproval = "needsApproval" in provider ? provider.needsApproval : composioApprovals();

  return {
    ...provider,
    ...(needsApproval ? { needsApproval } : {}),
    hooks: withConnectLinkHook(options, log),
  };
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
