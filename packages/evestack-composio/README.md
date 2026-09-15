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

Two defaults come with it, and both can be turned off by name: connected accounts
belong to the principal who connected them rather than to everyone
([who owns the connected accounts](#who-owns-the-connected-accounts)), and a
human approves before Composio writes anything ([approvals](#approvals)).

### Connecting an account

Ask the agent. It calls `COMPOSIO_MANAGE_CONNECTIONS`, gets a Connect Link back,
and gives you a URL:

```
> connect my gmail
[evestack:composio] connect this account to continue: https://backend.composio.dev/s/...
```

Open it, authorize, and the grant is stored against the Composio user id of the
principal who asked — so it survives restarts and applies to every later session
of theirs. Which id that is, and who else can then use the account, is the next
section.

## Who owns the connected accounts

Composio binds an OAuth grant to a user id, not to a session. This package used
to hand every step the same user id, so the Gmail account one person connected
through the agent was executable by every other principal that ever reached it —
every member of a Slack workspace, every holder of a JWT, one inbox. Nothing in
the tool call said so.

**The default is now one Composio identity per principal**, derived from the
caller eve authenticated:

| Who is calling | Composio user id |
| --- | --- |
| `eve dev` on your machine (`local-dev`) | `evestack` |
| The dashboard, or anything using `EVESTACK_AUTH_USER` (`http-basic`) | `evestack` |
| A scheduled run (`app` / `eve:app`) | `evestack` |
| No authenticated principal at all | `evestack` |
| A person from SSO, a JWT, Slack, Discord, GitHub, … | `evestack--<who>-<digest>` |

The first four are the installation rather than a person — they are one shared
credential, or no credential — so they keep the bare namespace. **A single-user
install therefore resolves to exactly the id it resolved to before, and nothing
about its connected accounts changes.** Add real per-person auth and each person
connects their own accounts and cannot execute anyone else's.

Two consequences worth knowing:

- The dashboard's `/integrations` page manages the **installation's** accounts,
  since it has no eve principal to speak for. A person with their own identity
  connects their own accounts through the agent's Connect Link instead.
- If your auth chain cannot tell your callers apart — `none()`, or one shared
  Basic password — neither can this. Isolation is only ever as good as the
  principals eve resolves.

Environment:

| Variable | Effect |
| --- | --- |
| `EVESTACK_COMPOSIO_USER_ID` | The namespace every identity is built under. Default `evestack`. Unchanged in meaning for a single-user install. |
| `EVESTACK_COMPOSIO_SHARED_IDENTITY=1` | Puts every principal back on one identity — the behaviour before this existed. Set it only when every caller is the same person, because it makes one person's accounts executable by all of them. |

## Options

Everything is optional.

```ts
composioTools({
  apiKey,               // default: process.env.COMPOSIO_API_KEY
  namespace,            // default: process.env.EVESTACK_COMPOSIO_USER_ID, then "evestack"
  userId,               // the older name for namespace
  sharedIdentity,       // default: EVESTACK_COMPOSIO_SHARED_IDENTITY=1
  sharedAuthenticators, // default: ["local-dev", "http-basic", "none", "app"]
  maxCachedIdentities,  // default 64
  toolkits,             // e.g. ["gmail", "github"] — omit for the full catalog
  remoteSandbox,        // default false; see below
  session,              // any other composio.sessions.create() config, merged last
  provider,             // EveProvider options: strict, needsApproval, hooks
  onConnectLink,        // (url, context) => void — default prints it
  logger,               // default console.warn
  retryAfterMs,         // default 60_000
  allowTracking,        // default false
});
```

**`namespace` is the base every OAuth grant hangs off.** Keep it stable or the
agent forgets which accounts it is signed into. `userId` is the name this option
had when it was the whole Composio user id rather than the base of one; both
still work and mean the same thing.

**`maxCachedIdentities` bounds the live sessions.** An identity can be derived
from something a caller supplies — a JWT subject, a Slack user id — so the cache
is a bounded LRU rather than a map that grows forever. Evicting costs that
principal one handshake next time it is seen; grants live on Composio's side,
against the user id, not in the session.

**`remoteSandbox` is off on purpose.** evestack already hands the agent a real
bash shell in a local Docker container. Turning this on adds a second execution
environment on someone else's infrastructure, which is the thing this stack
exists to avoid.

### Approvals

**A human approves before Composio writes.** That is the default, installed
whenever you do not pass a `needsApproval` of your own:

- reads pass — searching the catalog, fetching mail, listing issues;
- writes park the turn and wait for a person, including a write buried inside a
  batched `COMPOSIO_MULTI_EXECUTE_TOOL` call;
- `COMPOSIO_MANAGE_CONNECTIONS` always asks, because it is the call that binds a
  new OAuth grant to the agent;
- anything the rule cannot read — an unknown slug, a batch in an unexpected
  shape — asks.

It exists because of an asymmetry that could not be defended: deleting one row of
the agent's local memory parked the turn and waited for a human, while
`COMPOSIO_MULTI_EXECUTE_TOOL` could send mail from your account with nothing in
the loop at all, because `needsApproval` was never set.

Read and write are judged from the slug's verb — Composio slugs are
`TOOLKIT_ACTION` in caps, and with 1,000+ toolkits no hand-written list of tool
names can be complete. So the allowlist is the *read* verbs (`GET`, `LIST`,
`FETCH`, `SEARCH`, …) and everything else asks. A read verb the list is missing
costs one unnecessary prompt; a write verb it is missing would send the email.
Only one of those is worth being wrong about.

```ts
import { composioTools, requireApprovalForWrites } from "@evestack/composio";

export default composioTools({
  // The default, plus a read this install considers sensitive.
  provider: { needsApproval: requireApprovalForWrites("GMAIL_FETCH_EMAILS") },
});
```

**A scheduled run has nobody to ask.** eve's approval parks the turn and waits
for a human decision, which is the right behaviour for a person at a keyboard and
the wrong one for a 6am cron job that sends a digest: the turn sits unresolved
until someone answers it. If your agent writes on a schedule, either set
`EVESTACK_COMPOSIO_APPROVALS=off` or narrow the policy to the tools a person
really should see — `requireApprovalForTools("GMAIL_SEND_EMAIL")` gates a list
instead of every write.

`EVESTACK_COMPOSIO_APPROVALS=off` turns it off for an unattended agent. So does
passing `provider: { needsApproval: undefined }` explicitly — an option written
out is a decision, and nothing puts a default back over it.

`requireApprovalForTools(...)` from the SDK is still re-exported for the narrower
"gate exactly these slugs" policy, and it also matches entries inside a batched
call:

```ts
import { composioTools, requireApprovalForTools } from "@evestack/composio";

export default composioTools({
  provider: {
    needsApproval: requireApprovalForTools("GMAIL_SEND_EMAIL", "SLACK_SEND_MESSAGE"),
  },
});
```

## Also exported

Each of these is public because something outside the agent has to agree with it,
or because a security rule nobody can assert on is a wish:

| Export | Why it is public |
| --- | --- |
| `DEFAULT_COMPOSIO_USER_ID` | `"evestack"`. The namespace every grant hangs off. Import it rather than retyping the literal — see the warning below. |
| `composioUserId(env?)` | The namespace's full resolution order: `EVESTACK_COMPOSIO_USER_ID` trimmed, else the default. A blank override falls back rather than connecting grants to `""`. |
| `composioIdentity(ctx?, options?, env?)` | The whole identity rule in one pure function, for a UI or a script that has to name the same id the agent will use. |
| `isSharedComposioIdentity(env?)` | Whether `EVESTACK_COMPOSIO_SHARED_IDENTITY` is asking for the old single identity. |
| `SHARED_CREDENTIAL_AUTHENTICATORS` | The authenticators that mean "the installation" rather than a person, with the reasoning for each written out in the source. |
| `isComposioConfigured(env?)` | Whether a usable `COMPOSIO_API_KEY` is set, without opening a session — for a UI deciding whether to show a connect flow or an explanation. |
| `COMPOSIO_META_TOOLS` | The meta-tool slugs, as the vocabulary for `requireApprovalForTools()`. It is not a guaranteed tool list: the router decides the subset per session. `COMPOSIO_EXECUTE_TOOL` is deliberately not in it — the current router never returns that slug, so gating it would look like approval coverage that does not exist. |
| `requireApprovalForWrites(...slugs)` | The default approval policy, so you can extend it instead of rewriting it. |
| `composioApprovals(env?)` | That policy, or `undefined` when `EVESTACK_COMPOSIO_APPROVALS=off`. What the scaffolded `agent/tools/composio.ts` names. |
| `isReadOnlyComposioTool(slug)` | The verb rule on its own, for anyone auditing what their agent can do unattended. |
| `composioProviderOptions(options?, log?)` | What `EveProvider` is actually constructed with — the seam that lets "an agent that configures nothing still gets approvals" be a test rather than a claim. |

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
  cost no network call. The cooldown is process-wide, because an unreachable
  endpoint or a bad key is a property of the installation and not of one caller —
  but it never closes a session that is already open for someone.
- **Handshake succeeds** — the session is cached per Composio identity, so later
  steps by that principal reuse it without another round trip, up to
  `maxCachedIdentities` principals at once.

## Build

```bash
pnpm --filter @evestack/composio build
pnpm --filter @evestack/composio typecheck
pnpm --filter @evestack/composio test
```

The tests cover this package's own contracts rather than Composio itself, and
none of them needs a network:

- `test/resolver.test.mjs` — the announce-once, cache-per-identity,
  cool-off-then-retry state machine, plus the isolation and the LRU bound. It
  lives in `src/resolver.ts` with the network injected, so every branch of "an
  agent that cannot reach a SaaS directory is still an agent" is checked without
  one.
- `test/identity.test.mjs` — who gets which Composio user id, including the one
  that matters most: every install-wide principal still resolves to the bare
  namespace, so a single-user install keeps the accounts it has connected.
- `test/approvals.test.mjs` — what runs unattended, including a write hidden
  inside a batched `COMPOSIO_MULTI_EXECUTE_TOOL` call.

## Stability

`@composio/experimental` is experimental and pinned to exactly `0.2.1`. Its
`EveProvider` and `defineComposioTools` are the only supported way to bridge
Composio into eve today, and the package's own README warns that APIs can change
between releases. Bump it deliberately.
