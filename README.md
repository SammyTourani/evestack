<div align="center">

# evestack

### Run AI agents on your own machine.

An open source workspace for recurring AI work. Run a task, check its evidence,
and schedule a repeat on infrastructure you control.

[![CI](https://github.com/SammyTourani/evestack/actions/workflows/ci.yml/badge.svg)](https://github.com/SammyTourani/evestack/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/evestack?color=2563eb&label=evestack)](https://www.npmjs.com/package/evestack)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)

**[Product walkthrough](https://evestack.vercel.app)** · **[Docs](https://evestack.vercel.app/docs)** · **[Changelog](./CHANGELOG.md)**

</div>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/dashboard-dark.webp">
  <img alt="Eve Stack Tasks page showing recent work, outcomes and estimated spend. Example data from a local release test instance." src=".github/dashboard-light.webp">
</picture>

*The shipped dashboard with example data from a local release test instance.*

## Start with one useful job

A repository maintenance brief is a small, checkable first task: what changed this week,
what needs attention, and links supporting each finding. Connect one repository, inspect
the result, then save the request as a routine and run a test before enabling repeats.

[Follow the first-task walkthrough](https://evestack.vercel.app/docs/first-task).

Eve Stack is built for a technical operator willing to run the services. It packages the
[eve](https://github.com/vercel/eve) agent framework with a task workspace and operational
controls. It is a distribution, not a fork of the runtime.

## Quickstart

You need **Node 24+**, **Docker running**, and a model API key, or a local model with enough
memory. Model usage, connected services, hardware and hosting may cost money.

```bash
npx evestack create my-agent
```

The CLI asks for a directory, model provider, tools and whether to start services. It creates
project credentials and offers to start Postgres, bootstrap its schema and pull the dashboard,
then offers to run the agent. If you decline startup, use `--yes`, or Docker is unavailable,
it prints the remaining commands:

```bash
cd my-agent
docker compose up -d postgres
npm run db:bootstrap
docker compose --profile dashboard up -d
npm run dev
```

Open the dashboard at the printed address; ports are selected from those available on your
machine. Sign in with the project credentials, then check **Settings**. A configured provider
is not yet proof of a working model call. [Quickstart details](https://evestack.vercel.app/docs/quickstart).

In another terminal, from inside the project:

```bash
npx evestack status       # service state and next actions
npx evestack verify       # setup checks
npx evestack dashboard    # open the dashboard
npx evestack tour         # guided first message
```

`npx create-evestack my-agent` uses the same scaffolder. Install `evestack` globally if you
want the CLI on your PATH. `npm run dashboard` also opens an existing project's dashboard.

## Your workspace

| Area | What it helps you do |
| --- | --- |
| **Today** | Find pending decisions, recent results, routine state and setup checks |
| **Tasks** | Start work, read Markdown results, continue a conversation and inspect recorded evidence |
| **Routines** | Preview schedules in your timezone, test a run, enable repeats and investigate uncertain dispatch |
| **Connections** | Check account authorization and prepare a task for the selected repository |
| **Knowledge** | Inspect memory ownership, propose corrections and review skill changes |
| **Settings** | Check readiness, manage opted-in budgets and inspect notification delivery |
| **Diagnostics** | Investigate queue health, traces, estimated costs and execution environments |

Task and decision drafts survive failed submissions. Ambiguous delivery is shown so you can
inspect existing work before repeating it. Routine dispatch uses durable claims and request
deduplication; an unknown dispatch pauses for investigation. Regression cases preserve
versioned evidence and manual observations, without claiming an automated correctness verdict.

[Dashboard guide](https://evestack.vercel.app/docs/dashboard) ·
[Routines](https://evestack.vercel.app/docs/routines) ·
[CLI](https://evestack.vercel.app/docs/cli) ·
[MCP](https://evestack.vercel.app/docs/mcp)

## Data, cost and operating boundaries

Eve Stack has no software subscription fee. Your Postgres database stores workflow history
and configured memory/trace data. You own its retention, backups and access controls.

- Prompts reach your configured model provider. A local provider keeps model calls local;
  optional Composio and external tools can still send data outside your network.
- Composio is hosted and holds OAuth tokens for connected accounts. It is off until configured.
  Review consent and account scopes before running a connected task.
- Approvals apply to tools configured to request them. Read-only wording in a prompt is not an
  enforced permission profile. Sandbox isolation depends on backend, mounts, network and tools.
- Budgets apply to agents that load the budget hook. Unknown prices and unobserved activation
  are explicit; in-flight calls can still incur charges.
- Cancellation is cooperative. A successful cancellation request does not prove the call stopped.
- Shared installation credentials do not identify individual teammates or provide tenant isolation.
- Notifications can be delivered twice after an uncertain acknowledgement. Confirm actual receipt.

[Connections and data access](https://evestack.vercel.app/docs/composio-auth) ·
[Operations](https://evestack.vercel.app/docs/operations) ·
[Backup and restore](https://evestack.vercel.app/docs/backup-restore)

### Local models and memory

`EVESTACK_PROVIDER=ollama` selects a local model. Check available RAM before loading it alongside
Docker, Postgres and the dashboard. Do not assume an 8 GB laptop can run a useful chat model
and embeddings at the same time.

Memory needs a separate embeddings model. For Ollama, pull `nomic-embed-text` as well as the
chat model; for Anthropic chat, configure a supported embeddings provider separately.
[Local setup](https://evestack.vercel.app/docs/local-setup) and
[memory](https://evestack.vercel.app/docs/memory) describe the configuration.

## Adopt one component

Existing eve projects can preview a dashboard attachment with the CLI, or install individual
registry components:

```bash
eve registry add @evestack=https://raw.githubusercontent.com/SammyTourani/evestack/main/registry/r/{name}.json
eve add @evestack/memory
```

The registry includes `memory`, `instrumentation`, `docker-sandbox`, `basic-auth`, and Slack,
Telegram and Discord channels. [Registry guide](https://evestack.vercel.app/docs/registry).

## Versions and verification

[release-manifest.json](./release-manifest.json) records the selected component versions for
this source checkout, including Eve `^0.54.3`, exact Workflow Postgres `5.0.0-beta.42`, PostgreSQL
17 and the dashboard image. It is not proof of publication or deployment. Packages and the
container image are versioned independently; check actual registry versions before upgrading.

Keep the Workflow Postgres dependency exact. Its beta tag can change runtime compatibility.
Use `npm run db:bootstrap` rather than calling the upstream bootstrap CLI without the generated
environment-loading script. Back up the database before an upgrade; never drop the `evestack`
schema to bypass a version guard.

| Platform | Verification scope |
| --- | --- |
| Linux x86-64 | Required CI, native PostgreSQL, runtime checks and dashboard image |
| Linux arm64 | Dashboard image build; full CLI/runtime suite is not run on arm64 |
| macOS | Node 24 build/typecheck/contracts and platform tests in a non-blocking CI job; local browser checks |
| Windows | Node 24 build/typecheck and CLI/scaffolder platform checks, including native ACL tests, in a non-blocking CI job; interactive wizard and full Docker runtime not covered |
| Node | Minimum 24; selected Linux checks run on 24 and 26 |
| PostgreSQL | PostgreSQL 17 with pgvector; backup/restore rehearsal in CI |

[Support](https://evestack.vercel.app/docs/support) explains limits.
[RELEASE_PLAN.md](./RELEASE_PLAN.md) records exact-commit checks and remaining launch gates.
Local browser fixtures do not prove live provider, repository or external message delivery.
A first-time installation and useful scheduled occurrence remain real-user validation steps.

## Repository layout

```text
templates/default/             generated agent project
packages/evestack-cli/         evestack CLI
packages/create-evestack/      scaffolder
packages/dashboard/            task workspace and operator controls
packages/evestack-budget/      opted-in model spend caps
packages/evestack-schedules/   code-authored durable schedules
packages/evestack-composio/    hosted connection integration
packages/evestack-mcp/         dashboard APIs as MCP tools
packages/sandbox-opensandbox/  optional sandbox backend
packages/website/              product website and docs
contract/                      runtime compatibility checks
registry/                      installable eve components
skills/evestack/               coding-agent setup pack
```

See [RELEASING.md](./RELEASING.md) for publication order,
[CONTRIBUTING.md](./CONTRIBUTING.md) for development and [SECURITY.md](./SECURITY.md) for reporting.

## License

Apache-2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

eve is a trademark of Vercel. Eve Stack is an independent project, not affiliated with or
endorsed by Vercel.
