# @evestack/composio

One browser flow signs your agent into 1,000+ tools.

Vercel Connect ships four managed connectors. Composio's catalog is 1,000+ toolkits — we
counted 1,070 against `GET /api/v3/toolkits` on 2026-08-04 and it moves by ones, so every
evestack surface says 1,000+. This package wires that catalog into an
[eve](https://github.com/vercel/eve) agent through Composio's Tool Router, so the
model gets four meta-tools instead of ten thousand individual ones:

| Tool | What the model does with it |
| --- | --- |
| `COMPOSIO_SEARCH_TOOLS` | find tools by use case, across the whole catalog |
| `COMPOSIO_GET_TOOL_SCHEMAS` | pull the argument schema for a specific tool |
| `COMPOSIO_MANAGE_CONNECTIONS` | check auth state, and hand back a Connect Link when it needs one |
| `COMPOSIO_MULTI_EXECUTE_TOOL` | run one or many tools |

The router decides that set per session. Turn on the hosted sandbox and
`COMPOSIO_REMOTE_BASH_TOOL` / `COMPOSIO_REMOTE_WORKBENCH` join it.

## Install

```bash
pnpm add @evestack/composio
```

## Use

Default-export it from a file under your agent's `tools/` directory. eve resolves
it at the start of every step.

```ts
// agent/tools/composio.ts
import { composioTools } from "@evestack/composio";

export default composioTools();
```

That is the whole integration. Set `COMPOSIO_API_KEY` in `.env.local` and the
agent can reach every connected app; leave it unset and the agent still boots,
just without them.

### Connecting an account

Ask the agent. It calls `COMPOSIO_MANAGE_CONNECTIONS`, gets a Connect Link back,
and gives you a URL:

```
> connect my gmail
[evestack:composio] connect this account to continue: https://backend.composio.dev/s/...
```

Open it, authorize, and the grant is stored against your Composio user id — so it
survives restarts and applies to every later session. The dashboard's
`/integrations` page lists what is connected.

## Options

Everything is optional.

```ts
composioTools({
  apiKey,          // default: process.env.COMPOSIO_API_KEY
  userId,          // default: process.env.EVESTACK_COMPOSIO_USER_ID, then "evestack"
  toolkits,        // e.g. ["gmail", "github"] — omit for the full catalog
  remoteSandbox,   // default false; see below
  session,         // any other composio.sessions.create() config, merged last
  provider,        // EveProvider options: strict, needsApproval, hooks
  onConnectLink,   // (url, context) => void — default prints it
  logger,          // default console.warn
  retryAfterMs,    // default 60_000
  allowTracking,   // default false
});
```

**`userId` is the identity that owns every OAuth grant.** Keep it stable or the
agent forgets which accounts it is signed into.

**`remoteSandbox` is off on purpose.** evestack already hands the agent a real
bash shell in a local Docker container. Turning this on adds a second execution
environment on someone else's infrastructure, which is the thing this stack
exists to avoid.

### Requiring approval

The provider's approval hook works on the meta-tools, including individual
entries inside a batched `COMPOSIO_MULTI_EXECUTE_TOOL` call:

```ts
import { composioTools, requireApprovalForTools } from "@evestack/composio";

export default composioTools({
  provider: {
    needsApproval: requireApprovalForTools("GMAIL_SEND_EMAIL", "SLACK_SEND_MESSAGE"),
  },
});
```

## Also exported

Four things besides `composioTools`, each because something outside the agent has
to agree with it:

| Export | Why it is public |
| --- | --- |
| `DEFAULT_COMPOSIO_USER_ID` | `"evestack"`. The identity that owns every OAuth grant. Import it rather than retyping the literal — see the warning below. |
| `composioUserId(env?)` | The full resolution order: `EVESTACK_COMPOSIO_USER_ID` trimmed, else the default. A blank override falls back rather than connecting grants to `""`. |
| `isComposioConfigured(env?)` | Whether a usable `COMPOSIO_API_KEY` is set, without opening a session — for a UI deciding whether to show a connect flow or an explanation. |
| `COMPOSIO_META_TOOLS` | The meta-tool slugs, as the vocabulary for `requireApprovalForTools()`. It is not a guaranteed tool list: the router decides the subset per session. `COMPOSIO_EXECUTE_TOOL` is deliberately not in it — the current router never returns that slug, so gating it would look like approval coverage that does not exist. |

`EveProvider`, `requireApprovalForTools` and `denyEveToolCall` are re-exported from
`@composio/experimental/eve` so an agent needs one import, not two.

> **One definition, please.** `packages/dashboard/app/integrations/composio.ts`
> currently declares its own `DEFAULT_COMPOSIO_USER_ID = "evestack"` instead of
> importing this one. Two independent definitions of the identity that owns every
> OAuth grant is exactly the drift warned about above: change one and the
> dashboard lists accounts the agent cannot see, with no error anywhere.

## Failure behaviour

An agent that cannot reach a SaaS directory is still an agent, so nothing here
throws:

- **No `COMPOSIO_API_KEY`** — logs once, resolves to zero tools, agent boots.
- **Composio unreachable or key rejected** — logs the real error, resolves to zero
  tools, and waits `retryAfterMs` before trying again. Steps during the cooldown
  cost no network call.
- **Handshake succeeds** — the session is cached by identity, so later steps in
  the same process reuse it without another round trip.

## Build

```bash
pnpm --filter @evestack/composio build
pnpm --filter @evestack/composio typecheck
pnpm --filter @evestack/composio test
```

The tests cover the failure contract above rather than Composio itself: the
announce-once, cache-by-identity, cool-off-then-retry state machine lives in
`src/resolver.ts` with the network injected, so every branch of "an agent that
cannot reach a SaaS directory is still an agent" is checked without one.

## Stability

`@composio/experimental` is experimental and pinned to exactly `0.2.1`. Its
`EveProvider` and `defineComposioTools` are the only supported way to bridge
Composio into eve today, and the package's own README warns that APIs can change
between releases. Bump it deliberately.
