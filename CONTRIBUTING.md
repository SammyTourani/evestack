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
docker compose up -d postgres
cd templates/default && cp .env.example .env.local   # add a model API key
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
cd templates/default && pnpm exec eve eval
```

Both must be clean. The eval suite drives a real agent turn through a real Docker sandbox —
it needs Docker running and a model key in `.env.local`, same as normal development.

If you touch `packages/dashboard`, load the pages you changed in a browser and check them
against real data — a session that only exists in your head doesn't catch layout bugs.

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
- Match the existing dark-first CSS in `packages/dashboard/app/globals.css` — no CSS
  frameworks, no external fonts or CDNs. The whole point of this project is a stack that runs
  with zero network calls; a dashboard that phones a font CDN breaks that.

## Reporting bugs

Include: what you ran, what you expected, what happened, and — if it's dashboard-related —
whether `pnpm exec tsc --noEmit` was clean at the time. A repro against a fresh
`npx create-evestack` project is worth more than a description.
