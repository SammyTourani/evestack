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
| `list_approvals` | `/api/approvals` | Who decided what, and how the identity was established. |
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
| `EVESTACK_MCP_MAX_OUTPUT_BYTES` | `65536` | Ceiling on one tool result. See [Output cap](#output-cap). Minimum 1024; a value below that is rejected at startup rather than clamped. |

> It is **not** `EVESTACK_DASHBOARD_URL`. That name is already taken by the agent's OTLP exporter and holds
> a full path to the ingest endpoint (`…/api/ingest/v1/traces`), so reusing it would silently aim this
> server at the trace collector for anyone with both in one `.env`.

## Output cap

Every tool result is capped at **64 KiB** of pretty-printed JSON (`EVESTACK_MCP_MAX_OUTPUT_BYTES`), because
the size of one was otherwise a property of your deployment's history rather than of anything this server
decided.

Run `node test/measure-output-sizes.mjs` (after `npm run build`) and it prints this table. Every figure comes
from a real `tools/call` through this server, over a socket, against a dashboard applying each route's real
`LIMIT`; only the row *contents* are synthetic, field-for-field from the interfaces the real readers return.
Treat them as representative sizes for a busy deployment, not as a ceiling:

| Tool | Uncapped | ≈ tokens |
| --- | --- | --- |
| `list_sessions` | 1,489 B | 0.4k |
| `promote_session_to_eval` (40-turn session) | 15,592 B | 3.9k |
| `get_session` (one pending `write_file` approval) | 39,861 B | 10k |
| `get_costs` (200 principals) | 81,942 B | 20k |
| `list_approvals` (no arguments — 200 rows) | 113,289 B | 28k |
| `list_approvals` `limit=500` | 283,123 B | 71k |
| `list_approvals` `sessionId`, no limit (1000 rows) | 566,182 B | **142k** |

The last row is one tool call consuming most of a 200k-token window. Note *which* call it is: `/api/approvals`
defaults the whole-log arm to 200 rows and the `?sessionId=` arm to `MAX_APPROVALS`, so 1000 rows comes from
asking about **one session** without a limit, not from omitting arguments.

The measured results fall into two groups with a wide gap between them — three that stay small on any
deployment, topping out at 39,861 B, and four whose size tracks how much history you have, starting at
81,942 B. 64 KiB (~16k tokens) is the only power of two in that gap: 32 KiB would cut `get_session`, and
128 KiB would wave a 28k-token audit log through on a call with no arguments.

**A shortened result never passes for a whole one.** The payload stays valid JSON, and a `_truncated` object
is inserted as its *first* key — so a model reading the text block top-down meets the warning before it
reads a single row of the partial data. This is the last row of the table above, at the default cap:

```jsonc
{
  "_truncated": {
    "reason": "This result was 566182 bytes and this server caps a tool result at 65536 …",
    "limitBytes": 65536, "originalBytes": 566182, "returnedBytes": 65413, "droppedBytes": 500769,
    "cuts": [{ "path": "approvals", "unit": "items", "kept": 114, "dropped": 886 }]
  },
  "count": 1000,
  "approvals": [ /* 114 rows */ ]
}
```

`cuts` names every array and string that lost content and by how much; a clipped **string** additionally
carries a marker inline, because an array that lost its tail still looks like an array while a generated
eval clipped mid-file looks exactly like a small generated eval. The cut is sized by bisecting for the
largest prefix that fits rather than by dividing bytes by element count — the arithmetic estimate ignores
the indentation a node picks up once it is nested in the result, so it always over-cuts, and under-filling
the cap costs real audit rows.

**`promote_session_to_eval` fails instead of truncating.** It is the one tool whose result is a file you are
told to save rather than data to read, and half a TypeScript file does not compile — a 72,080-character eval
came back clipped inside a string literal inside an unclosed function body. If the generated eval will not
fit, you get an error naming its size, the exact value to raise `EVESTACK_MCP_MAX_OUTPUT_BYTES` to, and the
dashboard URL that serves the same file as a download without passing through this cap.

Both `content[0].text` and `structuredContent` carry the same fitted payload; the spec prefers the latter,
and it must not be the one field the cap does not apply to. The consequence, said plainly: the JSON-RPC
frame on the wire is up to twice the cap, because the payload is deliberately sent twice.

Truncation is also logged to stderr with the tool name and both byte counts, since the operator — not the
model — is the one who can raise the ceiling.

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

## When a route is missing

This section used to say `list_approvals` had no route. **It has one** —
`packages/dashboard/app/api/approvals/route.ts`, added in `5c49f3a` on 2026-08-05, before the first
published dashboard image — so the tool works against any build you can actually pull. The paragraph
outlived the gap it described by four days, which is the failure mode this whole package is built to
avoid: a confident statement about another component that nobody re-checked.

The mechanism it describes is still real and still worth keeping, because this package and the
dashboard version independently. Every tool that depends on a route degrades the same way: a 404 comes
back as a tool-execution error that names the missing handler, rather than as an empty result. An empty
approval log and an absent approval log are opposite answers to *"who approved this?"*, and a model
handed the first when the second is true will tell its operator that nobody did.

Also owed by the dashboard, and the reason for the caveats above:

- `GET /api/sessions?limit=&offset=` — `lib/queries.ts` has `listSessions(limit, offset)`; only
  `/api/health/detail`'s hardcoded five are reachable over HTTP.
- `GET /api/sessions/:id` — `getSession()` and `getSessionTree()` exist and would give `get_session` real
  per-turn detail (durations, subagent tree, per-turn cost) instead of a budget-derived approximation.

## Build

```bash
pnpm --filter @evestack/mcp build      # tsc → dist/
pnpm --filter @evestack/mcp typecheck
pnpm --filter @evestack/mcp test       # node:test over the framer, the validator, the gate and the cap
```

The tests cover the three things here that are hand-rolled and pure: the JSON-RPC framer
(`src/jsonrpc.ts`), the JSON Schema subset (`src/schema.ts`), and the read-only gate — both halves of it,
because withholding a tool from `tools/list` and refusing it on call have to agree. None of them need a
dashboard, which is the point: a policy the operator set must not depend on one being reachable.

Three later files do stand up a loopback `node:http` server, because what they assert is only true end to
end. `truncate.test.mjs` proves the cap survives the whole `tools/call` path rather than only holding
inside the helper; `tools.test.mjs` records exactly what the dashboard was sent, which is how "an explicit
`null` argument means the same thing as an omitted one" gets checked at the wire rather than at the
validator; and `injection.test.mjs` pins the encoding of `sessionId` — a model can put anything in that
argument, and it is spliced into a route path. There is no SQL and no shell here to inject into (this
package holds no database connection and spawns no process), so URL construction is the whole surface, and
it is tested rather than assumed.

`test/measure-output-sizes.mjs` is not a test — it is the measurement behind the [Output cap](#output-cap)
table, checked in so those figures can be re-derived instead of believed. `truncate.test.mjs` runs it and
fails if the numbers in this README and in `src/truncate.ts` have drifted from what it prints.

Apache-2.0.
