# Security

evestack runs your agent's model provider keys, Composio credentials, and Postgres access
locally, on your own machine. There is no evestack-operated service that sees any of it.

## Reporting a vulnerability

Open a [GitHub security advisory](../../security/advisories/new) rather than a public issue —
it stays private until a fix ships. If that's not available, email the maintainer directly
(see the repo's commit history for contact). Please include:

- The affected package (`templates/default`, `packages/dashboard`, `packages/evestack-composio`,
  `packages/create-evestack`, or `registry/`)
- A minimal reproduction
- What you'd expect to happen instead

We'll acknowledge within 72 hours and aim to ship a fix or mitigation before any public
disclosure.

## What's in scope

- The dashboard's control API (`packages/dashboard/app/api/control/**`) — it can start, message,
  and cancel agent sessions, so an auth bypass there is high severity
- The trace-ingest endpoint (`/api/ingest/v1/traces`) — it takes `EVESTACK_INGEST_TOKEN` in an
  `x-evestack-ingest-token` header, and with that variable unset falls back to ordinary session
  auth rather than to open (`ingestAuthorized()` in `packages/dashboard/lib/auth.ts`). A bypass
  is in scope, and so is data it should never accept: stored spans carry system prompts and tool
  arguments, and anything accepted here is rendered as a real conversation
- Anything that could exfiltrate `.env.local` contents, a Composio token, or a model API key
- The `create-evestack` scaffolder — it generates the route-auth password and the trace-ingest
  token; a weak or predictable generator for either is in scope

## What's out of scope

- Vulnerabilities in `eve` itself — report those to [vercel/eve](https://github.com/vercel/eve)
- Vulnerabilities in Composio's platform — report those to Composio
- Issues that require an attacker to already have shell access to the machine running evestack

## Known posture, not bugs

- **The dashboard fails closed, and its reachability is decided by the port mapping — two
  separate controls.** Every route requires `EVESTACK_AUTH_USER` and `EVESTACK_AUTH_PASSWORD`;
  with either unset it answers 503 on everything including the sign-in page, and there is no
  bypass flag (`packages/dashboard/proxy.ts`). The process *inside* the container binds
  `0.0.0.0` — it has to, or nothing outside its network namespace could reach it, Docker's own
  `HEALTHCHECK` included — so what keeps it off the network is `docker-compose.yml` publishing
  `127.0.0.1:4000:4000`. `docker run -p 4000:4000` on the image by hand puts the control plane
  on every interface the host has. And one shared secret per deployment is not per-person auth:
  there is no lockout, no rate limit and no second factor, so still put something you already
  trust (reverse-proxy OAuth, Tailscale, a VPN) in front before it leaves loopback.
- **Postgres is the surface that is still published on every interface.** Both the repo's
  `docker-compose.yml` and the one `create-evestack` generates map `5433:5432` with no host
  address, and both default the password to `evestack` (`${POSTGRES_PASSWORD:-evestack}` and a
  literal, respectively). That database holds every prompt, tool call and result the agent has
  produced. `create-evestack attach` is the one path that gets this right — it generates a
  password and publishes on `127.0.0.1` — so on the other two, set `POSTGRES_PASSWORD` and
  narrow the mapping before running anywhere but a laptop.
- **Composio's managed OAuth** shows users a Composio-branded consent screen and shares rate
  limits across all Composio customers. Fine for personal use and prototypes; read Composio's
  own docs on registering your own OAuth app before onboarding other people's accounts in
  production.
- **`EVESTACK_AUTH_PASSWORD` is generated per project**, never defaulted, specifically so a
  shipped default password can never be the only thing standing between a stranger and your
  agent. Rotate it if `.env.local` is ever exposed.
- **The local-dev grant is decided from the process, not the request.** `agent/channels/eve.ts`
  calls `eve`'s `localDev()` directly, and from eve 0.30.0 that grants only inside an `eve dev`
  / `vercel dev` process. Nothing a client sends — `Host` header, URL hostname — can obtain it.
  A built server (`eve build && eve start`) therefore grants nothing implicitly: every request,
  **including one from `127.0.0.1`**, must present the `httpBasic` credentials. That is the
  intended posture, not a misconfiguration.

  On eve 0.29.x this was reversed and exploitable: `localDev()` matched an unanchored `/^127\./`
  against the attacker-controlled `Host` header, so `127.evil.com` — a name anyone can register
  and point at your agent — received a full local-dev principal with no credentials (measured:
  `Host: 127.evil.com` answered 200 where `Host: evil.example.com` answered 401). evestack
  shipped a `strictLocalDev()` wrapper to narrow it; Vercel fixed it upstream in 0.30.0, at
  which point the wrapper stopped adding protection and started rejecting legitimate local-dev
  access over a LAN IP or a container hostname, so it was deleted. **Pin `eve` `>=0.30.0`** —
  the peer range on every publishable evestack package enforces this, and
  `contract/contracts/07-auth.contract.mjs` fails the build if the guarantee ever regresses.
