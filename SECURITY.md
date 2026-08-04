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
- The OTLP ingest endpoint — it's unauthenticated by design (an exporter has nowhere to put a
  credential), so the relevant risk is data it should never accept, not auth
- Anything that could exfiltrate `.env.local` contents, a Composio token, or a model API key
- The `create-evestack` scaffolder — it generates a route-auth password; a weak or predictable
  generator is in scope

## What's out of scope

- Vulnerabilities in `eve` itself — report those to [vercel/eve](https://github.com/vercel/eve)
- Vulnerabilities in Composio's platform — report those to Composio
- Issues that require an attacker to already have shell access to the machine running evestack

## Known posture, not bugs

- **The dashboard binds to `127.0.0.1` by default** and has no authentication of its own. It is
  a control plane that can start and cancel agent runs — do not expose it to a network without
  putting real auth in front of it (a reverse proxy, a VPN, `httpBasic`).
- **Composio's managed OAuth** shows users a Composio-branded consent screen and shares rate
  limits across all Composio customers. Fine for personal use and prototypes; read Composio's
  own docs on registering your own OAuth app before onboarding other people's accounts in
  production.
- **`EVESTACK_AUTH_PASSWORD` is generated per project**, never defaulted, specifically so a
  shipped default password can never be the only thing standing between a stranger and your
  agent. Rotate it if `.env.local` is ever exposed.
- **The loopback bypass is decided from the `Host` header**, because that is the only thing an
  HTTP request carries about where it thinks it is going. `agent/channels/eve.ts` therefore
  matches literal loopback names only — `localhost`, `::1`, and addresses inside `127.0.0.0/8`
  — rather than calling `eve`'s `localDev()` directly, whose `/^127\./` and `*.localhost` tests
  also accept hostile names such as `127.evil.com` and `evil.localhost` (measured against eve
  0.29.5: `Host: 127.evil.com` was answered 200 where `Host: evil.example.com` was 401). This
  is a real bypass in `eve` and out of scope above, so evestack narrows it locally instead of
  relying on it.
