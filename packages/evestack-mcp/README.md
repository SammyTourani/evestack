# @evestack/mcp

evestack's control plane, spoken as [MCP](https://modelcontextprotocol.io). Point Claude Code (or any MCP
client) at your self-hosted [eve](https://github.com/vercel/eve) fleet and ask it questions in English:

> *why did last night's run stop?*
> *what did we spend on gpt-5-mini today?*
> *turn that session into a regression test.*

**Read-only by default.** The tools that can act on a live agent are not merely refused — they are not
advertised at all — until you opt in. See [Safety](#safety-why-the-default-is-read-only).

```jsonc
// .mcp.json / claude_desktop_config.json
{
  "mcpServers": {
    "evestack": {
      "command": "npx",
      "args": ["-y", "@evestack/mcp"],
      "env": { "EVESTACK_MCP_DASHBOARD_URL": "http://localhost:4000" }
    }
  }
}
```

---

## What it is

A **thin client over the dashboard's HTTP routes**. It holds no database connection, no SQL, no price
table and no copy of eve's protocol. Every tool is a projection of a route `@evestack/dashboard` already
serves, because the alternative — a second implementation of the session query or the cost calculation —
drifts from the first one within a week and then quietly disagrees with the UI the operator is looking at.

The consequence is stated plainly rather than hidden: **if the dashboard has no route for something, this
package does not have a tool for it.** See [Missing routes](#missing-routes).

The protocol is hand-rolled against the spec — no SDK, no dependencies at all, `node:` builtins only. That
is the same bet the rest of evestack makes: a few hundred lines you can read beats a dependency you cannot.

## Tools

| Tool | Reads | Notes |
| --- | --- | --- |
| `list_sessions` | `/api/health/detail` | **Five most recent only** — that route's limit, not a choice made here. |
| `get_session` | `/api/control/sessions/:id/approve` + `/api/budget` + `/api/health/detail` | Live waiting state, pending approval requests, usage, and the verbatim budget-stop reason. |
| `list_approvals` | `/api/approvals` | **Route does not exist yet.** See below. |
| `get_costs` | `/api/budget` + `/api/health/detail` | Caps, per-principal daily spend, stops, lifetime totals. |
| `promote_session_to_eval` | `/api/evals/promote/:id` | Generates eval source and returns it. Writes nothing. |

Enabled only with `EVESTACK_MCP_ALLOW_CONTROL=1`:

| Tool | Calls | Effect |
| --- | --- | --- |
| `start_session` | `POST /api/control/sessions` | Starts a real run. Spends money. |
| `send_message` | `POST …/:id/message` | Another turn on a live session. Spends money. |
| `approve_or_deny` | `POST …/:id/approve` | **Runs the gated tool for real.** Audited. |
| `cancel_run` | `POST …/:id/cancel` | Cooperative stop between steps; the in-flight model call still bills. |

Read-only vs mutating is stated three ways, because different clients surface different ones: the first
word of every description, `annotations.readOnlyHint`, and whether the tool appears in `tools/list` at all.

## Safety: why the default is read-only

`approve_or_deny` lets one model approve a tool call that another model is parked on. That is the exact
gate a human was asked to stand at — the whole reason eve pauses the turn — so handing it to an agent by
default would quietly delete the human from human-in-the-loop.

So the mutating half is **withheld from `tools/list` entirely**, not just rejected on call. A model cannot
plan around a capability it has never been told exists, and there is no prompt that talks this server into
enabling itself: the gate is an environment variable read once at launch, before any client input is
parsed. Calling one anyway returns a JSON-RPC `-32602` whose message says who can turn it on (the
operator) and how.

Opting in is one line:

```jsonc
"env": {
  "EVESTACK_MCP_DASHBOARD_URL": "http://localhost:4000",
  "EVESTACK_MCP_ALLOW_CONTROL": "1",
  "EVESTACK_MCP_APPROVER": "sammy@example.com"
}
```

### Identity vs. provenance

evestack records **who** approved something, and always records **how** it learned that
(`packages/dashboard/lib/approvals.ts`). This server threads identity through by setting the header the
dashboard already reads:

| | Sent | Dashboard records |
| --- | --- | --- |
| `EVESTACK_MCP_APPROVER` set | `X-Forwarded-User: <value>` | `approverVia: "forwarded-user"` |
| …plus `EVESTACK_APPROVER_HEADER` set | that header instead | `approverVia: "header"` |
| **Unset (default)** | *nothing* | `approverVia: "unidentified"` |

Note what the default does **not** do: it does not invent an identity. An MCP server genuinely does not
know which human is at the other end of the conversation, and writing a plausible-looking name into an
audit log is worse than writing none. Set `EVESTACK_REQUIRE_APPROVER=1` on the dashboard to refuse
unattributed decisions outright.

What is *always* sent is **provenance**: `User-Agent: evestack-mcp/<version> (claude-code/2.1.0)`, taken
from the MCP `initialize` handshake and stored in `evestack.approvals.user_agent`. So even an unattributed
row still says the decision arrived through MCP, and from which client. The version is read from
`package.json` at run time (`src/version.ts`) and is deliberately not written down anywhere else — it was
typed twice as a literal once, and a published bump would have put a version that was never released into
the audit log permanently. This sentence is not the place to make that three.

Be clear-eyed about the trust here, the same way the dashboard's approvals page is: `X-Forwarded-User` is
a header a proxy is supposed to set. If your dashboard sits behind one that does OAuth, that proxy will
overwrite whatever this server sends, which is the correct outcome — the proxy knows and this server is
guessing. `EVESTACK_MCP_APPROVER` is for the case where nothing else is in front, and it is worth exactly
as much as the config file it lives in.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `EVESTACK_MCP_DASHBOARD_URL` | `http://localhost:4000` | Dashboard origin. |
| `EVESTACK_MCP_ALLOW_CONTROL` | unset | `1` advertises the mutating tools. |
| `EVESTACK_MCP_APPROVER` | unset | Identity recorded on approvals. |
| `EVESTACK_APPROVER_HEADER` | `x-forwarded-user` | Header to carry it in. Same variable the dashboard reads, so one line configures both ends. |
| `EVESTACK_MCP_DASHBOARD_AUTH` | unset | Verbatim `Authorization` value, if your dashboard is behind auth. |
| `EVESTACK_MCP_TIMEOUT_MS` | `30000` | Per-request timeout. |

> It is **not** `EVESTACK_DASHBOARD_URL`. That name is already taken by the agent's OTLP exporter and holds
> a full path to the ingest endpoint (`…/api/ingest/v1/traces`), so reusing it would silently aim this
> server at the trace collector for anyone with both in one `.env`.

## Protocol

Targets MCP revision **2025-11-25**, negotiating down to `2025-06-18`, `2025-03-26` and `2024-11-05`.
Implements `initialize`, `notifications/initialized`, `ping`, `tools/list` and `tools/call` over stdio,
line-delimited JSON-RPC 2.0.

Not revision `2026-07-28`. That one drops the `initialize` handshake for per-request `_meta` plus a
mandatory `server/discover`, and every client shipping today still opens with `initialize`. The spec's own
compatibility matrix says a modern client detects a legacy server by probing `server/discover` and falling
back on any error that is not a recognized modern one — so this server answers that probe with a plain
`-32601`, which is exactly the signal that triggers the fallback. Going dual-era is a real option later;
claiming it before it is tested would be worse than not claiming it.

`tools/list` and `tools/call` are refused with `-32600` until `initialize` has been answered. That check
existed as a field that was written and never read, so tool calls worked before the handshake; it matters
here beyond protocol tidiness, because the client's name and version arrive in that handshake and become
the `User-Agent` recorded against an approval. The gate is the initialize *request*, not
`notifications/initialized` — a client may legitimately pipeline its first real request behind the
initialize response without having sent the notification yet. `ping` is exempt, as the spec requires.

Two things worth knowing about the implementation:

- **stdout belongs to the protocol.** Everything human-readable goes to stderr. One stray `console.log`
  corrupts the stream and the client reports a parse error with no hint where it came from.
- **Requests are not serialized.** A tool call makes an HTTP round trip; awaiting it before reading the
  next line would deadlock a client that pipelines two calls. Ids exist so responses may return out of
  order, and they do.

Argument validation is a hand-rolled subset of JSON Schema (`src/schema.ts`) covering exactly the keywords
these tools declare. The server asserts at startup that no schema uses a keyword the validator does not
enforce, so the subset can never silently stop covering the schemas — an advertised constraint that is not
actually checked is a lie told to a model.

## Missing routes

`list_approvals` is advertised but **its route does not exist yet**. The data does: the rows are in
`evestack.approvals`, and `packages/dashboard/lib/approvals.ts` already exports `listApprovals()` and
`listApprovalsForSession()`. What is missing is a handler at
`packages/dashboard/app/api/approvals/route.ts` that calls them — today only the `/approvals` HTML page
reads that data, and this package does not get to add routes to the dashboard.

The tool is advertised anyway, and returns a tool-execution error naming exactly that file, because a
model that can tell its operator *"the audit log needs one route handler in the dashboard"* is more useful
than one that was never told the capability was intended. It will start working the moment the route
lands, with no change here.

Also owed by the dashboard, and the reason for the caveats above:

- `GET /api/sessions?limit=&offset=` — `lib/queries.ts` has `listSessions(limit, offset)`; only
  `/api/health/detail`'s hardcoded five are reachable over HTTP.
- `GET /api/sessions/:id` — `getSession()` and `getSessionTree()` exist and would give `get_session` real
  per-turn detail (durations, subagent tree, per-turn cost) instead of a budget-derived approximation.

## Build

```bash
pnpm --filter @evestack/mcp build      # tsc → dist/
pnpm --filter @evestack/mcp typecheck
pnpm --filter @evestack/mcp test       # node:test over the framer, the validator and the safety gate
```

The tests cover the three things here that are hand-rolled and pure: the JSON-RPC framer
(`src/jsonrpc.ts`), the JSON Schema subset (`src/schema.ts`), and the read-only gate — both halves of it,
because withholding a tool from `tools/list` and refusing it on call have to agree. None of them need a
dashboard, which is the point: a policy the operator set must not depend on one being reachable.

Apache-2.0.
