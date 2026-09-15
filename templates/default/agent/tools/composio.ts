import { composioApprovals, composioTools } from "@evestack/composio";

/**
 * One browser flow signs this agent into an app, for any toolkit Composio holds an
 * OAuth client for. The catalog is 1,000+; the one-click subset is smaller.
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
 *
 * ─ Why the approval policy is written out here ─
 *
 * `composioTools()` installs exactly this policy when you leave `needsApproval`
 * out, so the line below changes nothing by itself. It is here because this is
 * YOUR file, and a security decision you cannot see is one you cannot change:
 * the connectors are the one part of this agent that reaches outside the box,
 * and the place to widen or narrow that should be in the scaffold rather than
 * three levels down a dependency.
 *
 * What it does: a human approves before Composio writes. Reads pass — searching
 * the catalog, fetching mail, listing issues. Writes park the turn and wait for a
 * person, including a write buried in a batched COMPOSIO_MULTI_EXECUTE_TOOL call,
 * and so does COMPOSIO_MANAGE_CONNECTIONS, which is the call that binds a new
 * OAuth grant to this agent.
 *
 * It exists because of an asymmetry that was impossible to defend. `forget.ts`
 * parks the turn to delete one row of local memory; `COMPOSIO_MULTI_EXECUTE_TOOL`
 * would send mail from your account and post to your Slack with nothing in the
 * loop at all. Deleting a note asked. Sending the email did not.
 *
 * Three ways to change it, in the order you are likely to want them:
 *
 *  - add reads you consider sensitive:
 *      `requireApprovalForWrites("GMAIL_FETCH_EMAILS")`
 *  - approve one tool for a whole session instead of every call: wrap it, and
 *    fall back to eve's `once()` for the tools you trust after the first yes;
 *  - turn it off for an unattended agent: `EVESTACK_COMPOSIO_APPROVALS=off` in
 *    .env.local. Nothing will ask, which is the behaviour this template shipped
 *    before and is only safe when nobody else can reach the agent.
 *
 * The third one is not hypothetical. An approval parks the turn and waits for a
 * person, so a 6am scheduled run that sends a digest has nobody to answer it and
 * sits unresolved — the same shape `forget.ts` has always had, but far likelier
 * to come up, because a cron job that writes is the normal reason to have one. If
 * this agent writes on a schedule, turn approvals off or narrow them to a named
 * list with `requireApprovalForTools("GMAIL_SEND_EMAIL")`.
 *
 * ─ And who the accounts belong to ─
 *
 * Composio binds an OAuth grant to a user id, and `composioTools()` derives that
 * id from the principal eve authenticated for the request. On a single-user
 * install that is one id — `eve dev`, the dashboard's Basic credential, and
 * scheduled runs all resolve to the same one, and nothing about your connected
 * accounts changes. Add real per-person auth (SSO, or a channel like Slack) and
 * each person connects their own accounts and cannot execute anyone else's.
 * `EVESTACK_COMPOSIO_SHARED_IDENTITY=1` puts everybody back on one shared set of
 * accounts, which is worth doing only when every caller is already the same
 * person.
 */
export default composioTools({
  provider: { needsApproval: composioApprovals() },
});
