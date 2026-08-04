import { composioTools } from "@evestack/composio";

/**
 * One browser flow signs this agent into ~1,000 apps.
 *
 * The model does not get ten thousand tools. It gets a handful of meta-tools —
 * search the catalog, check a connection, execute — and Composio's router
 * resolves the rest per session. When a tool needs an account the agent hands
 * back a Connect Link, the user authorizes once, and the token is refreshed
 * server-side from then on.
 *
 * With COMPOSIO_API_KEY unset this resolves to no tools and logs one line. The
 * agent still boots, still runs, still has its sandbox and memory — you just
 * don't get the connectors.
 */
export default composioTools();
