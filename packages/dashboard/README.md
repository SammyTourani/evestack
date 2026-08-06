# @evestack/dashboard

Self-hosted observability and control plane for eve agents: sessions, cost,
approvals with audit, memory, schedules and evals, read from your own Postgres.

```bash
pnpm --filter @evestack/dashboard dev     # http://localhost:4000
```

It needs `WORKFLOW_POSTGRES_URL` and the auth credentials below. Everything else
in [`.env.example`](./.env.example) is optional.

## Auth

**Every route is behind a credential, and the dashboard fails closed without
one.** That is not paranoia about a read-only viewer — this app starts agent
runs, replays sessions with real tool execution, approves gated shell commands,
pauses schedules and deletes memories, and the container binds `0.0.0.0`.

### The credential

`EVESTACK_AUTH_USER` and `EVESTACK_AUTH_PASSWORD` — the same pair the agent uses
and that `create-evestack` generates. One secret per deployment, not two that
drift apart.

With `EVESTACK_AUTH_PASSWORD` unset the dashboard serves nothing: every route
answers `503` naming the two variables, `/api/health` reports unhealthy, and the
sign-in page explains the problem. There is deliberately no bypass flag —
that is the switch nobody turns back on.

### Signing in

Browsers: `/signin`, which sets a signed, `HttpOnly`, `SameSite=Lax` session
cookie. The signature is an HMAC-SHA256 from `node:crypto` over `{user, iat,
exp}`; the key is derived from the password, so **changing the password
invalidates every outstanding cookie**. Default lifetime is seven days.

Scripts: HTTP Basic on any route.

```bash
curl -u "$EVESTACK_AUTH_USER:$EVESTACK_AUTH_PASSWORD" localhost:4000/api/fleet
```

Or exchange the credentials once for a cookie jar:

```bash
curl -c jar -H 'content-type: application/json' \
  -d "{\"user\":\"$EVESTACK_AUTH_USER\",\"password\":\"$EVESTACK_AUTH_PASSWORD\"}" \
  localhost:4000/api/auth/session
curl -b jar localhost:4000/api/approvals
```

### Where it is enforced

[`proxy.ts`](./proxy.ts) — Next 16's name for what used to be `middleware.ts`.
One gate in front of every request, so protection is the default and opening
something up requires writing it down. `tierFor()` in
[`lib/auth.ts`](./lib/auth.ts) returns the strictest tier for any path it does
not recognise, which means a route added later is protected before its author
has thought about auth.

| Tier | Paths | What it takes |
| --- | --- | --- |
| liveness | `/api/health` | nothing — Docker's HEALTHCHECK has no credential. Returns only `{ok, database}` |
| sign-in | `/signin`, `/api/auth/session`, `/api/auth/signout` | nothing, plus a same-origin check on the POSTs |
| ingest | `/api/ingest/v1/traces` | `EVESTACK_INGEST_TOKEN` header, or a session. See [app/api/ingest/README.md](./app/api/ingest/README.md) |
| session | **everything else**, pages and API alike | the session cookie or HTTP Basic |

Writes additionally refuse a cross-site `Origin` / `Sec-Fetch-Site`. Adding a
cookie added a CSRF surface that did not exist while everything was open;
`SameSite=Lax` is the first lock and that check is the second.

### Attribution: who approved what

`evestack.approvals` and `evestack.memory_deletions` record an identity and how
it was proved, in `approver_via` / `actor_via`:

| value | proves |
| --- | --- |
| `session` | a cookie this deployment signed |
| `basic` | Basic credentials whose password this deployment verified |
| `forwarded-user`, `forwarded-email`, `header` | a trusted proxy said so |
| `unidentified` | nothing |

`session` and `basic` name an **installation, not a person** — evestack ships one
shared credential. For per-person attribution, put a proxy that authenticates
people in front (OAuth2 Proxy, Cloudflare Access, Tailscale) and set
`EVESTACK_TRUSTED_PROXY`.

**`X-Forwarded-User`, `X-Forwarded-Email` and `EVESTACK_APPROVER_HEADER` are
ignored entirely until `EVESTACK_TRUSTED_PROXY` is set.** Without a proxy in
front, those headers are three words of `curl` away from anyone who can reach
the port, and an audit log that can be dictated to is worse than one that admits
it knows nothing. Rows written before that change carry `forwarded-*` values
that nothing verified; treat them as unidentified.

`EVESTACK_REQUIRE_APPROVER=1` still refuses any decision it cannot attribute.
Note what it buys you now: a request that reaches the approve route has already
proved the deployment credential, so pair it with `EVESTACK_TRUSTED_PROXY` if
you need a human name in the row rather than the installation's.

## Environment

Added by the auth work; the full list is in [`.env.example`](./.env.example).

| Variable | Default | Purpose |
| --- | --- | --- |
| `EVESTACK_AUTH_USER` | — | **Required.** Sign-in user; same value as the agent's. Not defaulted, because `lib/agent-client.ts` only sends Basic to the agent when both halves are set. |
| `EVESTACK_AUTH_PASSWORD` | — | **Required.** Either unset means the dashboard refuses every request. |
| `EVESTACK_SESSION_SECRET` | derived from the password | Set to rotate cookies without rotating the password, or to let replicas accept each other's cookies. |
| `EVESTACK_SESSION_TTL_HOURS` | `168` | Session cookie lifetime. |
| `EVESTACK_TRUSTED_PROXY` | unset | `1` when a proxy you control terminates every request and strips inbound `X-Forwarded-*`; or a comma-separated list of IPs/IPv4 CIDRs the nearest hop must match. Until set, forwarded identity headers are not read. |
| `EVESTACK_INGEST_TOKEN` | unset | Shared secret for `/api/ingest/v1/traces`, sent as `x-evestack-ingest-token`. Unset falls back to session auth, never to open. |
| `EVESTACK_APPROVER_HEADER` | unset | Name of the header carrying the approver's identity. Only read behind `EVESTACK_TRUSTED_PROXY`. |
| `EVESTACK_REQUIRE_APPROVER` | unset | `1` refuses approvals that cannot be attributed. |

If you export traces, the agent needs `EVESTACK_INGEST_TOKEN` alongside
`EVESTACK_DASHBOARD_URL`, holding the **same value** this dashboard has — its
exporter sends it as `x-evestack-ingest-token`. There is no working
configuration without it: unset on both sides, ingest falls back to session
auth, which an exporter cannot satisfy, so every span 401s.

`create-evestack` generates the token into the project's `.env.local`, and the
`docker-compose.yml` it writes hands that same file to the dashboard container
via `env_file:` — so a scaffolded project has one value in one place. Running
this dashboard from a clone instead (`pnpm dev`, or your own compose file) means
copying it into this package's `.env.local` yourself.

## Deployment notes

- The container binds `0.0.0.0` because nothing outside it could reach the port
  otherwise. If you want the dashboard on loopback only, publish it that way:
  `127.0.0.1:4000:4000` in compose, not `4000:4000`.
- Serve it over TLS if it is reachable from anywhere but your own machine. The
  session cookie is `Secure` when the request is https, when
  `EVESTACK_PUBLIC_URL` is https, or when a trusted proxy reports
  `X-Forwarded-Proto: https`.
- Set `EVESTACK_PUBLIC_URL` when the dashboard sits behind a different hostname
  than it sees on the request. It is used for OAuth callback URLs and for the
  cross-site write check.

## Layout

```
app/          pages and route handlers
lib/          Postgres access, the eve client, auth, skill scanning
sql/          schemas created on demand (approvals, memory audit, spans)
proxy.ts      the auth gate every request passes through
fixtures/     the malicious skill the scanner self-test scans
```
