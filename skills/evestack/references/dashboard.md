# The dashboard

A Next.js app shipped as a container image, `ghcr.io/sammytourani/evestack-dashboard`, pinned in
the generated `docker-compose.yml` to the version tested with that template. Multi-arch
(`linux/amd64` + `linux/arm64`, ~204 MB compressed), so the same command works on Apple Silicon
and on an x86 server.

```bash
docker compose --profile dashboard up -d
```

It is a compose profile **in the generated project** — not a separate clone, no image to build,
no credential to copy across. To run a fork or a private build, set `EVESTACK_DASHBOARD_IMAGE`
in a `.env` beside the compose file.

## What it reads

`workflow.workflow_runs.attributes` (JSONB) directly over SQL. That column holds eve's own
`$eve.*` run tags — the same data behind Vercel's Agent Runs. **There is no ingest step for the
session list.** OTLP ingest at `/api/ingest/v1/traces` is a second tier used only for prompt
bodies and tool arguments, which do not exist in the SQL tags.

Cost is computed client-side from token counts (`lib/pricing.ts`), because eve only reports
`gen_ai.usage.cost` for AI-Gateway-routed calls, which a self-hosted agent never makes.

Two facts that trip people reading the data directly:

- **A failed turn still records `status='completed'`.** The absence of `$eve.model` is the only
  failure signal.
- **Rows without `$eve.type` are internal noise** and must be filtered out.

## Pages

`sessions` · `chat` · `costs` · `approvals` · `memory` · `skills` · `sandboxes` · `schedules` ·
`integrations` · `evals` · `monitors` · `traces` · `charts`

## Auth

Every route is behind `EVESTACK_AUTH_USER` / `EVESTACK_AUTH_PASSWORD` from `.env.local`. It
fails closed — the dashboard starts agent runs, approves gated shell commands and deletes
memories, so serving a viewer to anyone who reaches the port is not an acceptable default.

Scripts use HTTP Basic:

```bash
curl -u "$EVESTACK_AUTH_USER:$EVESTACK_AUTH_PASSWORD" localhost:4000/api/fleet
```

## HTTP API

Read:

| Route | Returns |
| --- | --- |
| `GET /api/health` · `/api/health/detail` | liveness; detailed state incl. the five most recent sessions |
| `GET /api/fleet` | fleet overview |
| `GET /api/budget` | caps, per-principal daily spend, stops, lifetime totals |
| `GET /api/approvals` | who decided what, and how identity was established |
| `GET /api/alerts` | alert state |
| `GET /api/metrics/query` | metrics |
| `GET /api/skills` · `/api/skills/[name]` | the scanned skills directory |
| `POST /api/evals/promote/[id]` | generates eval source from a session; writes nothing |

Mutating:

| Route | Effect |
| --- | --- |
| `POST /api/control/sessions` | starts a real run — spends money |
| `POST /api/control/sessions/[id]/message` | another turn — spends money |
| `POST /api/control/sessions/[id]/approve` | **runs the gated tool for real**; audited |
| `POST /api/control/sessions/[id]/cancel` | cooperative stop; the in-flight call still bills |
| `POST /api/control/sessions/[id]/fork` | fork a session |
| `DELETE /api/memories/[id]` | irreversible |

## The Skills page and its one honest caveat

The page scans a skills directory and reports which one it found and how. In the **published
image** the working directory is `/repo/packages/dashboard`, so `<cwd>/agent/skills` does not
exist and it falls back to the template's skills bundled inside the image. That bundled skill is
also called `memory-hygiene` — the same name the scaffolder writes into a real project — so the
page can look like it is reading the user's agent when it is not.

`resolvedBy: "bundled-template"` and the absolute path are both rendered, which is what keeps
this honest rather than silent. To scan the real one, mount it and set the env var — the
generated compose already gives the dashboard `env_file: .env.local`, so the mount is the
missing half:

```yaml
environment:
  EVESTACK_SKILLS_DIR: /agent-skills
volumes:
  - ./agent/skills:/agent-skills:ro
```

## `@evestack/mcp`

The same control plane spoken as MCP, so Claude Code or any MCP client can ask questions in
English. It is a **thin client over the dashboard's HTTP routes** — no database connection, no
SQL, no price table, no copy of eve's protocol. If the dashboard has no route for something,
this package has no tool for it.

```jsonc
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

Read-only tools: `list_sessions`, `get_session`, `list_approvals`, `get_costs`,
`promote_session_to_eval`.

**The four mutating tools — `start_session`, `send_message`, `approve_or_deny`, `cancel_run` —
are withheld from `tools/list` entirely** unless `EVESTACK_MCP_ALLOW_CONTROL=1`. A model cannot
plan around a capability it has never been told exists, and the gate is an environment variable
read once at launch, before any client input is parsed.

Never advise a user to set that flag without saying what it means: it lets a model approve a
gated tool call a human was asked to stand at, which is the entire reason eve pauses the turn.
