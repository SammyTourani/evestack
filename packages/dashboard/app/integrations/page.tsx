import styles from "./integrations.module.css";
import {
  type Category,
  type ConnectedAccount,
  type Toolkit,
  composioApiKey,
  composioUserId,
  countAuthConfigs,
  countToolkits,
  listCategories,
  listConnectedAccounts,
  listToolkits,
} from "./composio";

export const dynamic = "force-dynamic";

const fmt = (n: number) => n.toLocaleString("en-US");

function ago(iso: string | null): string {
  if (!iso) return "—";
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(s)) return "—";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Composio's status vocabulary onto the four status pills globals.css defines. */
function statusClass(status: string): string {
  switch (status.toUpperCase()) {
    case "ACTIVE":
      return "status-completed";
    case "INITIALIZING":
    case "INITIATED":
      return "status-running";
    case "FAILED":
    case "EXPIRED":
    case "REVOKED":
      return "status-failed";
    default:
      return "status-cancelled";
  }
}

function first(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

export default async function IntegrationsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const search = first(params.q).trim();
  const category = first(params.category).trim();
  const connected = first(params.connected).trim();
  const failure = first(params.error).trim();

  const apiKey = composioApiKey();
  if (!apiKey) return <NoKey />;

  let accounts: ConnectedAccount[];
  let catalog: Awaited<ReturnType<typeof listToolkits>>;
  let categories: Category[];
  let authConfigs: number;
  let totalApps: number;
  try {
    [accounts, catalog, categories, authConfigs, totalApps] = await Promise.all([
      listConnectedAccounts(apiKey),
      listToolkits(apiKey, { search, category }),
      listCategories(apiKey),
      countAuthConfigs(apiKey),
      countToolkits(apiKey),
    ]);
  } catch (error) {
    return (
      <div className="empty">
        <h2>Can&apos;t reach Composio</h2>
        <p className="dim">{error instanceof Error ? error.message : String(error)}</p>
        <p className="faint">
          Your agent is unaffected — it drops Composio tools and keeps running when the API is
          unreachable.
        </p>
      </div>
    );
  }

  const connectedSlugs = new Set(
    accounts.filter((a) => a.status.toUpperCase() === "ACTIVE").map((a) => a.toolkitSlug),
  );
  const filtered = Boolean(search || category);

  return (
    <>
      <h1>Integrations</h1>
      <p className="page-sub">
        One browser flow signs your agent into any of these. Grants are stored against{" "}
        <code className="mono">{composioUserId()}</code> and survive restarts.
      </p>

      {connected && (
        <div className={styles.notice}>
          <strong>{connected}</strong>
          <span className="dim">
            Returned from authorization. An active connection shows up below; if it does not, the
            grant was declined or is still settling.
          </span>
        </div>
      )}
      {failure && (
        <div className={`${styles.notice} ${styles.noticeFailed}`}>
          <strong>Couldn&apos;t start that connection</strong>
          <span className="dim">{failure}</span>
        </div>
      )}

      <div className="stat-row">
        <div className="stat">
          <div className="stat-label">Connected accounts</div>
          <div className="stat-value">{fmt(connectedSlugs.size)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Apps available</div>
          <div className="stat-value">{fmt(totalApps)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Auth configs</div>
          <div className="stat-value">{fmt(authConfigs)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Agent identity</div>
          <div className={styles.statText}>{composioUserId()}</div>
        </div>
      </div>

      <h2 className={styles.toolbarTitle}>Connected</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>App</th>
              <th>Status</th>
              <th>Auth</th>
              <th>Identity</th>
              <th className="num">Connected</th>
            </tr>
          </thead>
          <tbody>
            {accounts.length === 0 ? (
              <tr>
                <td colSpan={5} className={styles.inlineEmpty}>
                  Nothing connected yet. Pick an app below — or just ask the agent, which can start
                  the same flow itself.
                </td>
              </tr>
            ) : (
              accounts.map((account) => (
                <tr key={account.id}>
                  <td>
                    <div className={styles.app}>
                      <span className={styles.mark}>{account.toolkitSlug.slice(0, 2)}</span>
                      <div>
                        <div className={styles.appName}>{account.toolkitSlug}</div>
                        <div className="mono faint">{account.id.slice(0, 24)}…</div>
                      </div>
                    </div>
                  </td>
                  <td>
                    <span className={`status ${statusClass(account.status)}`}>
                      {account.status.toLowerCase()}
                    </span>
                    {account.statusReason && (
                      <div className="faint" style={{ fontSize: 11 }}>
                        {account.statusReason}
                      </div>
                    )}
                  </td>
                  <td className="dim">
                    {account.isComposioManaged ? "composio-managed" : "your credentials"}
                  </td>
                  <td className="mono dim">{account.userId ?? "—"}</td>
                  <td className="num dim">{ago(account.createdAt)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <form className={styles.toolbar} action="/integrations" method="get">
        <h2 className={styles.toolbarTitle}>Catalog</h2>
        <input
          className={styles.search}
          type="search"
          name="q"
          defaultValue={search}
          placeholder="Search 1,000+ apps"
          aria-label="Search apps"
        />
        <select className={styles.select} name="category" defaultValue={category} aria-label="Category">
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <button className={styles.buttonQuiet} type="submit">
          Filter
        </button>
      </form>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>App</th>
              <th className="num">Tools</th>
              <th>Auth</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {catalog.items.length === 0 ? (
              <tr>
                <td colSpan={4} className={styles.inlineEmpty}>
                  No apps match that search.
                </td>
              </tr>
            ) : (
              catalog.items.map((toolkit) => (
                <ToolkitRow
                  key={toolkit.slug}
                  toolkit={toolkit}
                  connected={connectedSlugs.has(toolkit.slug)}
                />
              ))
            )}
          </tbody>
        </table>
      </div>

      <p className={styles.footnote}>
        Showing {fmt(catalog.items.length)} of {fmt(catalog.totalItems)}
        {filtered ? " matching" : ""} apps.{" "}
        {filtered ? (
          <>
            <a href="/integrations">Clear the filter</a> to browse everything.
          </>
        ) : (
          "Search to narrow it down."
        )}{" "}
        Apps marked <span className={`${styles.chip} ${styles.chipManaged}`}>1-click</span> use
        Composio&apos;s own OAuth app, so connecting takes a browser round trip and nothing else.
        The rest need your own credentials — ask the agent and it will walk you through it.
      </p>
    </>
  );
}

function ToolkitRow({ toolkit, connected }: { toolkit: Toolkit; connected: boolean }) {
  const oneClick = toolkit.managedAuthSchemes.length > 0;

  return (
    <tr>
      <td>
        <div className={styles.app}>
          <span className={styles.mark}>{toolkit.name.slice(0, 2)}</span>
          <div>
            <div className={styles.appName}>{toolkit.name}</div>
            <div className={styles.desc}>{toolkit.description}</div>
          </div>
        </div>
      </td>
      <td className="num dim">{toolkit.toolCount ? fmt(toolkit.toolCount) : "—"}</td>
      <td>
        {toolkit.noAuth ? (
          <span className={styles.chip}>no auth</span>
        ) : oneClick ? (
          <span className={`${styles.chip} ${styles.chipManaged}`}>1-click</span>
        ) : (
          <span className={styles.chip}>{toolkit.authSchemes[0]?.toLowerCase() ?? "auth"}</span>
        )}
      </td>
      <td className="num">
        {connected ? (
          <span className="status status-completed">connected</span>
        ) : toolkit.noAuth ? (
          <span className="faint">ready</span>
        ) : oneClick ? (
          <form action="/integrations/connect" method="post">
            <input type="hidden" name="toolkit" value={toolkit.slug} />
            <button className={styles.button} type="submit">
              Connect
            </button>
          </form>
        ) : (
          <span className="faint">ask the agent</span>
        )}
      </td>
    </tr>
  );
}

function NoKey() {
  return (
    <>
      <h1>Integrations</h1>
      <p className="page-sub">
        One browser flow signs your agent into 1,000+ apps — Gmail, GitHub, Slack, Notion, Linear,
        and the rest of the catalog.
      </p>
      <div className="empty">
        <h2>No Composio API key yet</h2>
        <p>
          Grab a free key at <code>composio.dev</code>, then add it to the dashboard and the agent:
        </p>
        <p className="faint mono" style={{ marginTop: 14 }}>
          COMPOSIO_API_KEY=… &nbsp;→&nbsp; packages/dashboard/.env.local
          <br />
          COMPOSIO_API_KEY=… &nbsp;→&nbsp; templates/default/.env.local
        </p>
        <p className="faint">
          Until then the agent runs exactly as it does now, minus the connectors. Nothing here
          fails closed.
        </p>
      </div>
    </>
  );
}
