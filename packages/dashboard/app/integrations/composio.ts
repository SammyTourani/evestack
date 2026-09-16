/**
 * A hand-rolled Composio v3 client.
 *
 * @composio/core would do this too, but it drags a large dependency tree in for
 * these catalog reads and authorization requests. The agent uses the real SDK; the dashboard
 * only reads and starts auth flows.
 *
 * Every shape below was checked against the live API, not the docs.
 */

const API_BASE =
  process.env.COMPOSIO_BASE_URL ?? "https://backend.composio.dev";

/**
 * Composio ties OAuth grants to a user id, not a session. This must match the
 * agent's — `@evestack/composio` resolves it the same way — or the dashboard
 * will happily connect accounts the agent cannot see.
 *
 * DUPLICATED ON PURPOSE, and pinned by a test rather than an import.
 * `@evestack/composio` exports this same constant, so importing it would be the
 * obvious fix — but that package depends on `@composio/core` and
 * `@composio/experimental`, and this file's whole reason for existing (see the
 * header) is that the dashboard avoids the Composio SDK dependency tree.
 * Importing the constant would drag in the tree this client was hand-rolled to
 * avoid, to share nine characters.
 *
 * So the two literals stay separate and test/composio-identity.test.mjs reads
 * both files and fails if they ever diverge. That catches the drift — an agent
 * signed into accounts the dashboard cannot see — without the coupling.
 */
const DEFAULT_COMPOSIO_USER_ID = "evestack";

export function composioApiKey(): string | undefined {
  return process.env.COMPOSIO_API_KEY?.trim() || undefined;
}

export function composioUserId(): string {
  return (
    process.env.EVESTACK_COMPOSIO_USER_ID?.trim() || DEFAULT_COMPOSIO_USER_ID
  );
}

export class ComposioError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ComposioError";
    this.status = status;
  }
}

export interface Toolkit {
  slug: string;
  name: string;
  description: string;
  toolCount: number;
  categories: string[];
  authSchemes: string[];
  /** Non-empty means Composio owns the OAuth app, so connecting is one click and no credentials. */
  managedAuthSchemes: string[];
  noAuth: boolean;
}

export interface ConnectedAccount {
  id: string;
  toolkitSlug: string;
  status: string;
  statusReason: string | null;
  userId: string | null;
  authConfigId: string | null;
  isComposioManaged: boolean;
  createdAt: string | null;
}

export interface Category {
  id: string;
  name: string;
}

export interface ToolkitPage {
  items: Toolkit[];
  totalItems: number;
}

async function request<T>(
  path: string,
  apiKey: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method: init?.method ?? "GET",
      headers: {
        "x-api-key": apiKey,
        ...(init?.body === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new ComposioError(
      init?.method === "POST"
        ? "The Composio connection request could not be confirmed. Check existing grants before starting it again."
        : "Could not reach Composio within 10 seconds. Check connectivity and try again.",
      0,
    );
  }

  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2 * 1024 * 1024)
        throw new ComposioError(
          "Composio returned a response larger than the 2 MB limit.",
          502,
        );
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ComposioError) throw error;
    throw new ComposioError(
      "The Composio response was interrupted. Check its status before repeating a connection request.",
      502,
    );
  } finally {
    await reader?.cancel().catch(() => {});
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!response.ok) {
    const detail = (
      readErrorMessage(text) ?? `HTTP ${response.status} from Composio`
    )
      .replaceAll(apiKey, "[redacted]")
      .replace(/https?:\/\/[^\s"']+/gi, "[URL redacted]")
      .slice(0, 300);
    throw new ComposioError(detail, response.status);
  }
  try {
    return text ? (JSON.parse(text) as T) : ({} as T);
  } catch {
    throw new ComposioError("Composio returned an unreadable response.", 502);
  }
}

function readErrorMessage(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: unknown; errors?: unknown };
    };
    const message = parsed.error?.message;
    const details = parsed.error?.errors;
    if (typeof message !== "string") return null;
    return Array.isArray(details) && details.length
      ? `${message}: ${details.join("; ")}`
      : message;
  } catch {
    return null;
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()}…`;
}

interface RawToolkit {
  slug?: string;
  name?: string;
  auth_schemes?: string[];
  composio_managed_auth_schemes?: string[];
  no_auth?: boolean;
  meta?: {
    description?: string;
    tools_count?: number;
    categories?: { id?: string; name?: string }[];
  };
}

export async function listToolkits(
  apiKey: string,
  options: { search?: string; category?: string; limit?: number } = {},
): Promise<ToolkitPage> {
  const params = new URLSearchParams({ limit: String(options.limit ?? 60) });
  if (options.search) params.set("search", options.search);
  if (options.category) params.set("category", options.category);

  const page = await request<{ items?: RawToolkit[]; total_items?: number }>(
    `/api/v3/toolkits?${params}`,
    apiKey,
  );

  return {
    totalItems: page.total_items ?? page.items?.length ?? 0,
    items: (page.items ?? []).map((raw) => ({
      slug: raw.slug ?? "",
      name: raw.name ?? raw.slug ?? "unknown",
      // Clamped in CSS to two lines; no reason to ship the other thousand characters.
      description: truncate(raw.meta?.description ?? "", 180),
      toolCount: raw.meta?.tools_count ?? 0,
      categories: (raw.meta?.categories ?? [])
        .map((c) => c.name ?? c.id ?? "")
        .filter(Boolean),
      authSchemes: raw.auth_schemes ?? [],
      managedAuthSchemes: raw.composio_managed_auth_schemes ?? [],
      noAuth: raw.no_auth ?? false,
    })),
  };
}

interface RawConnectedAccount {
  id?: string;
  status?: string;
  status_reason?: string | null;
  user_id?: string | null;
  created_at?: string | null;
  toolkit?: { slug?: string };
  auth_config?: { id?: string; is_composio_managed?: boolean };
}

export async function listConnectedAccounts(
  apiKey: string,
  limit = 100,
): Promise<ConnectedAccount[]> {
  return (await connectedAccountsPage(apiKey, limit)).accounts;
}

export async function connectedAccountsPage(
  apiKey: string,
  limit = 100,
  userId?: string,
) {
  const boundedLimit = Math.min(100, Math.max(1, Math.floor(limit)));
  const params = new URLSearchParams({ limit: String(boundedLimit) });
  if (userId) params.set("user_ids", userId);
  const page = await request<{
    items?: RawConnectedAccount[];
    next_cursor?: string | null;
    total_pages?: number;
  }>(`/api/v3/connected_accounts?${params}`, apiKey);
  if (!Array.isArray(page.items))
    throw new ComposioError(
      "Composio returned no account list. Authorization could not be checked.",
      502,
    );
  const accounts = page.items.map((raw) => ({
    id: raw.id ?? "",
    toolkitSlug: raw.toolkit?.slug ?? "unknown",
    status: raw.status ?? "UNKNOWN",
    statusReason: raw.status_reason ?? null,
    userId: raw.user_id ?? null,
    authConfigId: raw.auth_config?.id ?? null,
    isComposioManaged: raw.auth_config?.is_composio_managed ?? false,
    createdAt: raw.created_at ?? null,
  }));
  return {
    accounts,
    coverage: {
      scanned: accounts.length,
      limit: boundedLimit,
      complete:
        !page.next_cursor &&
        (page.total_pages ?? 1) <= 1 &&
        accounts.length < boundedLimit,
    },
  };
}

/** An account belonging to another identity cannot establish this agent's readiness. */
export async function inspectConnection(
  apiKey: string,
  toolkit: string,
  userId = composioUserId(),
) {
  const { accounts, coverage } = await connectedAccountsPage(
    apiKey,
    100,
    userId,
  );
  const matching = accounts.filter(
    (account) =>
      account.toolkitSlug.toLowerCase() === toolkit &&
      account.userId === userId,
  );
  const active = matching.some(
    (account) => account.status.toUpperCase() === "ACTIVE",
  );
  return {
    configured: true,
    identity: userId,
    toolkit,
    checkedAt: new Date().toISOString(),
    status: active
      ? "active"
      : matching.length
        ? "attention"
        : coverage.complete
          ? "missing"
          : "unknown",
    accounts: matching,
    coverage,
    otherIdentityAccounts: accounts.filter(
      (account) =>
        account.toolkitSlug.toLowerCase() === toolkit &&
        account.userId !== userId,
    ).length,
    scopes: "unavailable",
    repositoryAccess: "not_checked",
  };
}

/** The whole catalog, independent of whatever the user is filtering by. */
export async function countToolkits(apiKey: string): Promise<number> {
  const page = await request<{ total_items?: number }>(
    "/api/v3/toolkits?limit=1",
    apiKey,
  );
  return page.total_items ?? 0;
}

export async function countAuthConfigs(apiKey: string): Promise<number> {
  const page = await request<{ total_items?: number }>(
    "/api/v3/auth_configs?limit=1",
    apiKey,
  );
  return page.total_items ?? 0;
}

/** Composio has hundreds of near-duplicate categories, which is unusable as a dropdown. */
const CATEGORY_LIMIT = 48;

export async function listCategories(apiKey: string): Promise<Category[]> {
  const page = await request<{ items?: { id?: string; name?: string }[] }>(
    "/api/v3/toolkits/categories?limit=200",
    apiKey,
  );

  // The endpoint enumerates per toolkit, not per category, so it repeats itself.
  // Taking the first distinct ones keeps the categories of the best-known apps
  // rather than whatever sorts first alphabetically.
  const seen = new Map<string, Category>();
  for (const item of page.items ?? []) {
    const id = item.id;
    if (!id || seen.has(id)) continue;
    seen.set(id, { id, name: item.name ?? id });
    if (seen.size >= CATEGORY_LIMIT) break;
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Find or create the auth config a Connect Link hangs off.
 *
 * `use_composio_managed_auth` means Composio's own OAuth app is used, so the
 * user never registers anything — that is what makes this one click. Toolkits
 * without a managed scheme need credentials, which is the agent's job via
 * COMPOSIO_MANAGE_CONNECTIONS, not the dashboard's.
 */
export async function resolveAuthConfigId(
  apiKey: string,
  toolkitSlug: string,
): Promise<string> {
  // `?toolkit_slug=` is sent, but Composio ignores it: `bananaslug`,
  // `nonexistenttoolkit123` and 50 random characters all came back 200 with the
  // account's single github config. Taking the first enabled item on trust is
  // therefore how "Connect Notion" sends someone to a GitHub authorization
  // page — and creates a real INITIATED connected_account for the wrong app.
  // The server filter stays as a hint; the match is decided here.
  const existing = await request<{
    items?: {
      id?: string;
      is_disabled?: boolean;
      status?: string;
      toolkit?: { slug?: string };
    }[];
  }>(
    `/api/v3/auth_configs?toolkit_slug=${encodeURIComponent(toolkitSlug)}&limit=100`,
    apiKey,
  );
  // `status` is what the live API returns ("ENABLED"); `is_disabled` is not a
  // field on this resource, so testing it alone accepts a disabled config.
  const usable = (existing.items ?? []).find(
    (item) =>
      item.id &&
      !item.is_disabled &&
      (item.status === undefined || item.status.toUpperCase() === "ENABLED") &&
      item.toolkit?.slug?.toLowerCase() === toolkitSlug,
  );
  if (usable?.id) return usable.id;

  const created = await request<{ auth_config?: { id?: string }; id?: string }>(
    "/api/v3/auth_configs",
    apiKey,
    {
      method: "POST",
      body: {
        toolkit: { slug: toolkitSlug },
        auth_config: { type: "use_composio_managed_auth" },
      },
    },
  );
  const id = created.auth_config?.id ?? created.id;
  if (!id)
    throw new ComposioError(
      `Composio created no auth config for ${toolkitSlug}`,
      502,
    );
  return id;
}

/** Returns the URL the user opens to authorize. */
export async function createConnectLink(
  apiKey: string,
  options: { authConfigId: string; userId: string; callbackUrl: string },
): Promise<string> {
  const created = await request<{
    connectionData?: { val?: { redirectUrl?: string } };
    connection_data?: { val?: { redirect_url?: string; redirectUrl?: string } };
    redirect_url?: string;
  }>("/api/v3/connected_accounts", apiKey, {
    method: "POST",
    body: {
      auth_config: { id: options.authConfigId },
      connection: {
        user_id: options.userId,
        callback_url: options.callbackUrl,
      },
    },
  });

  const url =
    created.connectionData?.val?.redirectUrl ??
    created.connection_data?.val?.redirectUrl ??
    created.connection_data?.val?.redirect_url ??
    created.redirect_url;

  if (!url) {
    throw new ComposioError(
      "Composio returned no authorization URL for this app",
      502,
    );
  }
  return url;
}
