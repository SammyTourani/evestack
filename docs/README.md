# evestack docs

Written for [Mintlify](https://mintlify.com), but `docs.json` here targets the schema as of
my knowledge cutoff — Mintlify has moved config formats before (`mint.json` → `docs.json`) and
may again. **Before connecting this to a live Mintlify workspace, open their dashboard,
create the site, and let it validate `docs.json` against whatever the current schema actually
is** — don't assume this file is correct without that check.

The navigation structure and page content underneath it are not schema-dependent and don't
need re-checking: Get started (introduction, quickstart, local setup) → How it works
(architecture, dashboard, Composio auth, memory) → Reference (registry, CLI, troubleshooting).

## Content policy

Every page here is written from the verified build in `../FINDINGS.md` and `../README.md` —
commands that were actually run, numbers that were actually measured (1,070 Composio apps,
the IVFFlat 2-results-at-LIMIT-3-vs-0-at-LIMIT-20 bug, ~90s cooperative cancellation delay).
No page should ever describe a capability that hasn't been exercised against the real stack.
If you're adding a page for something new, run it first.

## llms.txt

`llms.txt` at the repo root follows the emerging convention
([llmstxt.org](https://llmstxt.org)) for a plaintext summary an AI coding agent can ingest
directly, without crawling the full docs site. Keep it in sync with `docs.json`'s navigation —
it should never claim a capability the real docs don't cover, and vice versa.
