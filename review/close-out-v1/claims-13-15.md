# Claims 13, 15 and 6 — closed, corrected, and blocked

Three claims survived every earlier round because each needed something no amount of
reading could supply: a running clock, a third-party account, or a real bill. This is
what happened when they were finally run.

---

## Claim 13 — "Schedules: history of every fire + pause with no redeploy"

**TRUE.** Verified end to end on 2026-08-19 against a project scaffolded from the
published `create-evestack@0.10.0`.

The earlier ledger recorded this as needing a Telegram token. **That was wrong**, and it
is worth saying plainly because it nearly sent someone to get a credential they did not
need. Telegram, Slack and Discord are channels for the *heartbeat* schedule specifically.
Claim 13 is about the schedules feature, which needs no channel at all — so the test used
a purpose-built schedule that depends on nothing external:

```ts
const run = tracked("claimcheck", "* * * * *", async () => {
  appendFileSync("/tmp/claimcheck-fires.log", `${new Date().toISOString()} handler-ran\n`);
});
```

The log file is the point. `evestack.schedule_runs` is the product's *claim* about what
happened; the file is what *actually* happened. A pause that stopped writing rows while
still running the handler would look identical if you only read the table.

One process throughout — PID 39318, start time `Wed Aug 19 20:39:21 2026`, checked before
the pause and after the resume and identical both times. Nothing was restarted, rebuilt or
redeployed. `pause()` was called from a *separate* node process so the agent was never
even touched.

| fire_at | status | duration_ms | handler actually ran |
|---|---|---|---|
| 00:40 | completed | 2 | yes |
| 00:41 | completed | 4 | yes |
| 00:42 | **skipped** | 4 | **no** |
| 00:43 | completed | 9 | yes |

Three `completed` rows, three `handler-ran` lines. The table and independent reality agree
exactly.

Two things the claim understates:

- **A paused tick is still recorded**, as `status = 'skipped'`. The history covers fires
  that did not run, not just the ones that did — so a schedule that goes quiet leaves
  evidence of *why*, which is the failure mode a bare "history of every fire" would miss.
- **`fire_at` is truncated to the minute** and carries a unique index with `name`, so a
  tick genuinely cannot be recorded twice. Two dispatches inside one minute produce one
  row. That is the documented at-most-once guarantee, observed rather than assumed.

One gap worth noting: `schedule_state.paused_by` was empty after `pause()`. The column
exists, so the intent is there, but the helper as called records no actor. That matters to
claim 10 ("audit log of who decided what"), not to claim 13.

---

## Claim 15 — "Integrations: one-click OAuth into 1,000+ toolkits"

**The capability is real. The sentence is false.** Both halves matter.

### What was measured

The full catalog was paged with the account's own key on 2026-08-19 — 14 pages, every
toolkit, counting `composio_managed_auth_schemes`:

| | count |
|---|---|
| toolkits in the catalog | **1,326** |
| declare an OAuth scheme at all | 217 |
| **Composio-managed OAuth — genuinely one click** | **121** |
| authenticate with an API key you fetch yourself | 1,126 |
| need no auth | 32 |

`1,326` is stable across page sizes (1326/20 → 67 pages, 1326/100 → 14), so it is a real
total and not a pagination artifact.

### The defect

"One-click OAuth into 1,000+ toolkits" attaches the **catalog size** to a capability
**121** of them have. The other 1,126 are API-key toolkits: you go to the vendor, generate
a key, and paste it — which is neither OAuth nor one click, and is the very burden the
Composio section of the docs is written to contrast against. A further 96 support OAuth
but require you to register your own OAuth client.

This is not pedantry about a round number. The claim as written promises that one browser
flow removes credential work across the whole catalog, and for 85% of it the credential
work is exactly what remains.

### What is genuinely true, and is worth saying

- A single `authorize()` call returned a working Composio-hosted Connect Link in **1.76s**,
  status `INITIATED`, over HTTPS, with no OAuth-client registration of any kind.
- **Every app the scaffolder names by name — Gmail, Slack, Notion, Linear, Google Calendar,
  GitHub — is inside the 121.** The path most people actually take really is one click.
- 121 managed connectors is a strong number *on its own terms* when the thing it is being
  compared against in `docs/index.mdx` offers 4.

The honest claim is stronger than the inflated one, because it survives being checked.

### Surfaces corrected

`README.md`, `docs/index.mdx`, `docs/composio-auth.mdx`, `llms.txt`,
`packages/create-evestack/README.md`, `packages/create-evestack/create.mjs`,
`templates/default/.env.example`, `templates/default/agent/tools/composio.ts`, and the log
line in `packages/evestack-composio/src/resolver.ts`.

`docs/composio-auth.mdx` already reasoned well about *drift* — it explains why every
surface says "1,000+" rather than an exact figure that ages. It simply never separated
catalog size from one-click capability. That separation is now written down there with the
measurement and the command to re-derive it.

**Not corrected:** `packages/website/lib/copy.ts` still says "1,070 tool integrations",
which is now 256 short. That is landing-page copy and out of scope by standing instruction,
so it is flagged rather than edited. Note its claim is the *catalog* kind, so it is stale
rather than wrong in kind.

### Still open

Completing an OAuth flow requires signing into a real Google/Slack account, which an agent
must not do. A pending `INITIATED` connection exists under Composio user id
`evestack-claim15-test` (`ca_7SQstDhWEzRN`) from this verification; it was left in place
rather than deleted.

### One forward risk

The pinned `@composio/core` is `0.14.1`; `0.17.0` is current. Calling `toolkits.authorize()`
on 0.14.1 emits a deprecation naming a sunset date of **2026-07-03 — which has already
passed**. `@evestack/composio` does not call that method itself, so this is a risk in the
pinned SDK rather than a proven break in evestack's own path, and it is recorded here at
that strength deliberately.

---

## Claim 6 — "Cost accuracy vs the provider's own bill"

**Still CAN'T TELL, and not for want of trying.**

There is no paid provider key on this machine. `OPENAI_API_KEY` appears in no shell
profile, no `.env`, and no scaffolded project — the only matches anywhere are
documentation examples and old session transcripts.

More to the point, the shell exports:

```
OPENAI_BASE_URL="http://127.0.0.1:8787/v1"
```

which is a local `headroom-ai` process. Anything inheriting that environment sends its
"OpenAI" traffic to localhost and generates no bill at all. A cost-accuracy run that
inherited it would compare evestack's arithmetic against a proxy and *pass*, which is worse
than not running it. Whoever closes this claim must override that variable explicitly.

Closing it needs two things: a key that actually spends, and a way to read what was spent.
A normal `sk-proj-…` key gives only the first — reading `/v1/organization/costs` needs an
**Admin** key. Failing that, a human reading the figure off the usage dashboard closes the
claim just as honestly.
