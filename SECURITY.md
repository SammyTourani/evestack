# Security

evestack runs your agent's model provider keys, Composio credentials, and Postgres access
locally, on your own machine. There is no evestack-operated service that sees any of it.

## Reporting a vulnerability

Open a [GitHub security advisory](../../security/advisories/new) rather than a public issue —
it stays private until a fix ships. If that's not available, email the maintainer directly
(see the repo's commit history for contact). Please include:

- The affected package. Everything in this repository is in scope: any directory under
  `packages/`, plus `templates/default`, `contract/` and `registry/`. (This line used to name
  three of the nine directories under `packages/`, which reads as though the other six were
  excluded. They are not.)
- A minimal reproduction
- What you'd expect to happen instead

We'll acknowledge within 72 hours and aim to ship a fix or mitigation before any public
disclosure.

## Which versions get the fix

The newest published version of the affected package, and nothing else. Everything here is
pre-1.0; fixes land on `main` and go out in that package's next release. There is no
long-term-support line and nothing is backported, so "upgrade" is the whole of the remediation
advice, every time. [docs/support.mdx](docs/support.mdx) states that in full, along with the
platforms this is actually tested on; [docs/upgrading.mdx](docs/upgrading.mdx) is how you move an
existing project forward.

Two consequences worth knowing before you need them. A dashboard fix arrives as a **new image
tag** — a scaffolded project pins one (`ghcr.io/sammytourani/evestack-dashboard:<version>`), so
nothing changes until you repoint and repull. And an agent-side fix arrives in
`templates/default`, which is copied into your project at scaffold time and never touched again;
you apply those by hand.

## What's in scope

- The dashboard's control API (`packages/dashboard/app/api/control/**`) — six routes that start,
  message, stream, cancel, **fork** and **approve** agent sessions. Forking replays a
  conversation and re-executes its tools; approving releases a gated shell command. An auth
  bypass there is high severity
- The trace-ingest endpoint (`/api/ingest/v1/traces`) — it takes `EVESTACK_INGEST_TOKEN` in an
  `x-evestack-ingest-token` header **or as a `Bearer` token**, and with that variable unset falls
  back to ordinary session auth rather than to open (`ingestAuthorized()` in
  `packages/dashboard/lib/auth.ts`). A bypass is in scope, and so is data it should never accept:
  stored spans carry system prompts and tool arguments, and anything accepted here is rendered as
  a real conversation
- Anything that could exfiltrate `.env.local` contents, a Composio token, or a model API key
- The `create-evestack` scaffolder — it generates the route-auth password and the trace-ingest
  token; a weak or predictable generator for either is in scope

## What's out of scope

- Vulnerabilities in `eve` itself — report those to [vercel/eve](https://github.com/vercel/eve)
- Vulnerabilities in Composio's platform — report those to Composio
- Issues that require an attacker to already have shell access to the machine running evestack

## Known posture, not bugs

- **The dashboard fails closed, with two deliberate exceptions; its reachability is decided by
  the port mapping; and the sign-in throttle does not cover the path an attacker would use.**
  Three separate things. The previous version of this bullet ran them together and got two of
  them wrong, so they are separated here.

  `tierFor()` in `packages/dashboard/lib/auth.ts` sorts every path into one of four tiers and
  returns `session` — the strictest — for anything it does not recognise, so a route added
  tomorrow is guarded before its author has thought about auth. `packages/dashboard/proxy.ts` is
  the single gate, and there is no bypass flag. Its matcher is an exclusion list of exactly two
  entries — `_next/` and `favicon.ico`, compiled assets, which have to be reachable or the
  sign-in page cannot load its own stylesheet — so forgetting to list something fails closed.

  With `EVESTACK_AUTH_USER` or `EVESTACK_AUTH_PASSWORD` unset — measured by importing `proxy.ts`
  and calling it with both variables deleted from `process.env`:

  | request | what the gate does |
  |---|---|
  | `GET /`, and every other page or API route | 503, naming the two variables to set |
  | `POST /api/auth/session`, and every other POST | 503 — the exception below is GET-only, so signing in is refused too |
  | `GET /signin` | **passes through**, so the page renders (200) and explains the misconfiguration |
  | `GET /api/auth/session`, `GET /api/auth/signout` | **pass through** — the exception is the whole sign-in tier, and both routes export POST only, so Next answers a bare 405 |
  | `GET /api/health` | **passes through** — the handler then answers 503 `{"status":"unconfigured"}` by its own check (`app/api/health/route.ts`) |

  This bullet used to say the dashboard "answers 503 on everything including the sign-in page".
  It does not, and the exception is intentional: `proxy.ts` lets a GET on the sign-in tier
  through so that an operator sees prose in a browser instead of a bare 503 with no form and no
  explanation. It is written as a tier-and-method test rather than a path test, which is why the
  other two members of `PUBLIC_PATHS` answer 405 instead of 503 on a GET. Nothing is exposed by
  any of the three — with no credentials configured, `app/signin/page.tsx` renders the error and
  no form at all, and a bare 405 has no body.

  **`GET /api/health` is unauthenticated even when everything is configured**, because Docker's
  `HEALTHCHECK` has no credential to offer. It answers
  `{"ok":true,"database":"connected","version":"…"}`, so anyone who can reach the port learns
  that the dashboard is up, that its database is reachable, and which version it is. It is the
  only route that discloses anything about the deployment without a credential: the other three
  paths that are reachable without one (`/signin`, `POST /api/auth/session`,
  `POST /api/auth/signout` — the `PUBLIC_PATHS` set in `lib/auth.ts`) are the sign-in machinery
  itself and say nothing. The operational detail that used to be on the health route — session
  ids, turn and token counts, dollar cost, model names — is on `/api/health/detail`, which is in
  the `session` tier.

  The process *inside* the container binds `0.0.0.0` — it has to, or nothing outside its network
  namespace could reach it, that `HEALTHCHECK` included — so what keeps it off the network is
  the published port mapping. Both compose files publish loopback only: this repo's
  `docker-compose.yml` uses `127.0.0.1:${DASHBOARD_PORT:-4000}:4000` and the one
  `create-evestack` writes uses `127.0.0.1:${DASHBOARD_PORT:-<a port it found free>}:4000`.
  `docker run -p 4000:4000` on the image by hand puts the control plane on every interface the
  host has.

  **One shared secret per deployment is not per-person auth, and the throttle that exists is
  narrower than it looks.** There is no lockout and no second factor. There *is* a delay on the
  browser sign-in form — `POST /api/auth/session` doubles a process-wide penalty from 150 ms to
  a 2 s ceiling on consecutive failures, decaying after five idle minutes. Measured over ten
  wrong passwords in a row: 155, 302, 602, 1202, then 2002 ms each. **HTTP Basic gets none of
  it.** The same ten guesses sent as `Authorization: Basic` through `proxy()` each answered 401
  in under 3 ms, because `authenticate()` verifies the header and returns with nothing counting
  failures — and Basic is accepted on every guarded route. The delay is also one counter for the
  whole process, not one per client. So it is a speed bump on the form, not brute-force
  protection: still put something you already trust (reverse-proxy OAuth, Tailscale, a VPN) in
  front before this leaves loopback.
- **Signing out clears your browser; it does not revoke a cookie somebody already has.** The
  session cookie is a signed value with an expiry and no server-side record, so there is nothing
  to invalidate. Measured, not assumed: a cookie that answered **200** on `/api/health/detail`
  answered **200** again after `POST /api/auth/signout` returned 303 with
  `Set-Cookie: evestack_session=; Path=/; Max-Age=0; HttpOnly; SameSite=lax`. Against a live
  stack, `contract/runtime/probes/15-sign-in.probe.mjs` records which way it went — as a note
  rather than an assertion, deliberately, because both designs are correct and the code has
  chosen one. (That probe skips itself unless `EVESTACK_PROBE_DASHBOARD_URL` points at a running
  dashboard, so "every run" means every run that has one.) This is the ordinary trade-off of a
  stateless session and it is fine for a control plane sitting behind something else; it is
  worth knowing before you treat "Sign out" as a response to a leak.

  **What does end every session at once is changing `EVESTACK_AUTH_PASSWORD`**, and that is by
  design rather than by accident — `signingKey()` in `packages/dashboard/lib/auth.ts` derives
  the HMAC key from `user\0password` precisely "so that changing the password invalidates every
  outstanding cookie". Measured on the default configuration: a cookie that verified before the
  password changed was **rejected** after.

  One exception, and it is the reason to read this bullet rather than skim it. Setting
  `EVESTACK_SESSION_SECRET` — which you would do to run several dashboard replicas that accept
  each other's cookies — moves the key off the password, so **rotating the password no longer
  revokes anything**. Measured the same way and in the same run as the line above: with the
  secret set, the cookie issued under the old password was still accepted under the new one. If
  you have set it, rotate the secret too.
- **Postgres is on loopback by every path, and the repo's own compose still has a weak default
  password.** That database holds every prompt, tool call and result the agent has produced, so
  it is worth being exact about:
  - `create-evestack` generates `127.0.0.1:<port>:5432` and a per-project password from
    `randomBytes(18)`. Nothing to change.
  - `create-evestack attach` does the same.
  - The repo's own `docker-compose.yml` publishes `${POSTGRES_BIND:-127.0.0.1}:${POSTGRES_PORT:-5433}:5432`
    — loopback unless a contributor deliberately overrides `POSTGRES_BIND` — but still defaults
    to `POSTGRES_PASSWORD=evestack`. That is a contributor's dev database on loopback, which is
    why it is a default at all; set `POSTGRES_PASSWORD` if you widen the bind.

  This bullet used to say Postgres was "still published on every interface" by both compose
  files, with `attach` as "the one path that gets this right". That was true when it was
  written and had been fixed in all three paths by the time anyone read it. It is left
  described rather than silently rewritten because a security document that overstates an
  exposure is not harmlessly cautious: the first false claim a reader checks is the one that
  costs every true claim beside it its weight.
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
  access over a LAN IP or a container hostname, so it was deleted. **Pin `eve` `>=0.30.0`.**

  Two machine checks stand behind that sentence, and one thing it used to claim does not.
  `@evestack/budget`, `@evestack/composio`, `@evestack/schedules` and
  `@evestack/sandbox-opensandbox` each declare `peerDependencies.eve` as `>=0.30.0 <1.0.0`, and
  `templates/default/package.json` pins `eve` at `^0.30.8`, so npm refuses an install that would
  put an exploitable eve under them. `contract/contracts/01-version.contract.mjs` checks that one
  installed eve satisfies every range this repo declares, and
  `contract/contracts/07-auth.contract.mjs` fails if `localDev()` ever grants on something the
  caller controls again. This bullet previously said the peer range was on "every publishable
  evestack package"; it is not, and could not be — `create-evestack`, `evestack` and
  `@evestack/mcp` are published and import no eve at all, so they declare no peer range and
  nothing about them is weakened by that.
