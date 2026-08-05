# evestack docs

Content for https://evestack.vercel.app/docs, rendered by
[Fumadocs](https://fumadocs.dev) from inside `packages/website` — the same Next.js app as the
landing page, published in the same Vercel deployment. There is no docs vendor and no
second deploy: `pnpm --filter @evestack/website build` produces the whole site.

The pages live at the repo root rather than inside the website package (`source.config.ts`
points at `../../docs`) so they stay reviewable by people who never open the Next app. eve
arranges its own docs the same way.

Everything is wired in five places:

| File | Role |
| --- | --- |
| `meta.json` (+ `channels/meta.json`) | Sidebar order, section separators, and the links out to eve.dev |
| `packages/website/source.config.ts` | Points Fumadocs at this directory; restricts content to `**/*.mdx` |
| `packages/website/lib/docs-source.ts` | The loader; `baseUrl: "/docs"` |
| `packages/website/mdx-components.tsx` | Maps the Mintlify component names these pages were authored with onto Fumadocs components |
| `packages/website/app/docs/` | Route, layout, and route-scoped CSS |

## Why Fumadocs, and not Mintlify

These pages were originally written for Mintlify. Two things ruled it out. Mintlify hosts docs
itself — static export and self-hosting are both Enterprise-only — so the docs could never
share a deployment with the landing page, and would have lived on a separate domain behind a
"Powered by Mintlify" footer. And its `docs.json` navigation accepts only page paths, so the
**Upstream: eve** section below could not exist there at all.

The MDX was not rewritten. `mdx-components.tsx` maps `<Note>`, `<Warning>`, `<Card>` and
`<CardGroup>` onto Fumadocs equivalents (`<Steps>`/`<Step>` needed no mapping — the tag names
match), so these pages stay portable if the decision is ever revisited.

## Linking to eve

evestack is a distribution, not a fork, so these docs deliberately do **not** re-document the
framework. eve ships roughly two releases a day; a mirrored copy would be stale within a week
and wrong about auth defaults within a month. Framework concepts are linked, not copied:

```json
"---Upstream: eve---",
"external:[Agent config](https://eve.dev/docs/agent-config)"
```

Two rules follow:

1. **Write the seam, not the framework.** A page belongs here when self-hosting changes the
   answer — the Postgres world, the `@beta` pinning trap, auth off-platform, the Docker
   sandbox, reconstructing the run tree from your own database — or when eve has no page at
   all (memory).
2. **Say which eve version you mean.** For an installed project `node_modules/eve/docs/`
   matches the pinned version exactly, while eve.dev always documents latest. eve's own
   `llms.txt` recommends the same thing.

## Content policy

Every page here is written from the verified build in `../FINDINGS.md` and `../README.md` —
commands that were actually run, numbers that were actually measured (1,070 Composio apps,
the IVFFlat 2-results-at-LIMIT-3-vs-0-at-LIMIT-20 bug, ~90s cooperative cancellation delay).
No page should ever describe a capability that hasn't been exercised against the real stack.
If you're adding a page for something new, run it first.

MDX 3 is stricter than Mintlify's parser: a bare `<https://example.com>` autolink parses as
JSX and fails the build. Write `[text](url)`.

## llms.txt

`llms.txt` at the repo root follows the emerging convention
([llmstxt.org](https://llmstxt.org)) for a plaintext summary an AI coding agent can ingest
directly, without crawling the full docs site. Keep it in sync with `meta.json`'s navigation —
it should never claim a capability the real docs don't cover, and vice versa.
