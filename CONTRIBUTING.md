# Contributing to evestack

Thanks for looking at this. A few things that'll save you a round trip.

## Before you write code

For anything beyond a small fix, open an issue first describing what you want to change and
why. evestack has one hard rule that shapes most design decisions: **it stays additive to
`eve`, never a fork.** New capability should ship as an `@evestack` registry item
(`eve add @evestack/<name>`) wherever that's possible, not as a change to how the runtime
itself works.

## Setup

```bash
git clone https://github.com/<you>/evestack
cd evestack
pnpm install
pnpm -r --if-present run build   # workspace packages publish from dist/, which is gitignored;
                                 # without this the template cannot resolve @evestack/budget
docker compose up -d postgres
cd templates/default && cp .env.example .env.local   # pick a provider; see below for the $0 one
pnpm run db:bootstrap                                # creates the workflow schema
```

Then, in separate terminals:

```bash
cd templates/default && pnpm run dev      # the agent, on :2000 (auto-increments if taken)
cd packages/dashboard && cp .env.example .env.local && pnpm run dev   # the dashboard, on :4000
```

## Before opening a PR

```bash
pnpm -r typecheck
cd templates/default && pnpm run eval
```

Both must be clean. The eval suite drives a real agent turn through a real Docker sandbox, so
it needs Docker running.

`pnpm run eval`, not `pnpm exec eve eval`. The Setup above leaves an agent running on :2000,
and `eve eval` boots its own dev server and refuses to boot a second one for a project that
already has one — so the bare command exits 1 with *A dev server is already running for this
eve agent* and runs nothing. The script hands eve `--url` for the recorded port and runs the
same preflight `pnpm run dev` does; a `--url` you pass yourself is left alone.

**It does not need a paid model key.** The `$0` Ollama path runs the whole suite — this said
otherwise for a while, which is the wrong thing for this project of all projects to be wrong
about. Two lines in `.env.local`, and **two** pulls — the embedding model is a different model
from the chat one, and without it `remember` fails on the first call and `memory 5/5` below is
unreachable:

```bash
ollama pull qwen3                # the chat model
ollama pull nomic-embed-text     # embeddings, 274 MB — `npm run eval` checks for it by name
cd templates/default && pnpm run eval
# EVALS 4 — smoke 1/1, deny-survives 4/4, sandbox 3/3, memory 5/5 — 13 gates, 37.6s
```

Measured on qwen3 with no `OPENAI_API_KEY` and no `ANTHROPIC_API_KEY` set anywhere, including
the sandbox eval, which really does start a container (and really does start it with no
network — `docker ps --filter label=eve.sandbox` shows `none`). A hosted key is faster and
better at tool calling; it is not a prerequisite for running the gate.

### The negative control is part of the gate

A green suite means the fixes still work only if the suite can still go red. `evals/deny-survives`
has a documented vacuous failure mode — the model answers in prose, never calls the gated tool,
and the assertions never reach their subject — so before trusting a green, prove it can fail:

```bash
BROKEN="$(node contract/runtime/negative-control.mjs /tmp/agent-without-the-fix)"
cd "$BROKEN"
pnpm install
npx eve dev --port 2998 &
until curl -sf -o /dev/null http://127.0.0.1:2998/eve/v1/health; do sleep 1; done
npx eve eval deny-survives --url http://127.0.0.1:2998/   # MUST fail
```

That builds the real template with `approval: always()` removed from the `forget` tool, so the
call never parks and the eval's first gate fails. On Ollama the pair is unambiguous: 4/4 against
the real agent, 0/1 against the sabotaged one, same model and same eval — which is what shows the
model is genuinely reaching the human-in-the-loop path rather than passing for some other reason.

`.github/workflows/evals.yml` runs the control first for this reason, and will not publish a
green suite without it.

If you touch `packages/dashboard`, load the pages you changed in a browser and check them
against real data — a session that only exists in your head doesn't catch layout bugs.

### If you touch the Dockerfile, or anything the image carries

You do not have to build it — `.github/workflows/dashboard-image.yml` builds the image on
every PR that touches something inside it, starts the container against a real Postgres, and
exercises each file the runtime stage copies through the code that reads it. That job exists
because the failure it catches is invisible everywhere else: `sql/*.sql` is read with
`readFileSync` at **request** time, so an image missing one builds green, pushes green, starts,
answers the health probe, and 500s on the first real request.

To run it yourself, from the repository root — note the context is the root, not
`packages/dashboard`, because `@evestack/schedules` is a `workspace:*` dependency:

```bash
docker build -f packages/dashboard/Dockerfile -t evestack-dashboard .
```

It is a full `next build` inside the container and wants a few GB of RAM; on a small machine,
let CI do it.

## Where things live

| You want to... | Look at |
| --- | --- |
| Add a registry item (memory, auth, sandbox backend) | `registry/build.mjs`, then `templates/default/` for the source files it inlines |
| Change the dashboard's data model | `packages/dashboard/lib/queries.ts` — read the comment block at the top before touching the SQL; it documents the exact `$eve.*` attribute contract |
| Change agent pricing | `packages/dashboard/lib/pricing.ts` |
| Change the scaffolder | `packages/create-evestack/index.mjs` — keep it dependency-free |
| Change Composio wiring | `packages/evestack-composio/src/index.ts` |

## Style

- Comments explain *why*, not *what* — if removing a comment wouldn't confuse a future reader,
  don't add it.
- No `any`, no `@ts-ignore`, no weakening `strict` to make a type error go away. Fix the actual
  cause or don't merge it.
- Don't add abstraction for a hypothetical second use case. Three similar lines beats a
  premature helper.
- Match the design system in `packages/dashboard/app/globals.css`, and **no external fonts,
  stylesheets or CDNs of any kind**. The whole point of this project is a stack that runs with
  zero network calls; a dashboard that phones a font CDN breaks that.

  This rule used to read "no CSS frameworks", and the dashboard has been built on Tailwind 4
  since the design-system work — `tailwindcss ^4.1.0`, with `theme.css`, `preflight.css` and
  `utilities.css` imported at the top of `globals.css`. A contributor following the rule
  literally would have been told to avoid the thing every page in the dashboard is written in.

  The reason behind it survives intact, which is why the rule narrowed instead of going away:
  Tailwind is a build-time dependency that emits plain CSS and opens no socket at runtime. A
  font CDN, a hosted stylesheet or a script tag pointing anywhere is still a hard no.

## Reporting bugs

Include: what you ran, what you expected, what happened, and — if it's dashboard-related —
whether `pnpm exec tsc --noEmit` was clean at the time. A repro against a fresh
`npx create-evestack` project is worth more than a description.
