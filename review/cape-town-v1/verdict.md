# verdict.md — Part 11

Stranger test, cape-town-v1. `create-evestack@0.9.2`, `eve@0.30.8`, dashboard `0.3.1`, on the
$0 Ollama/qwen3 path. macOS 26.5.2, Node 26 — both of which the README says are untested.

---

**1. Time from zero to a working dashboard with real data?**

**68 seconds** for scaffold → Postgres → schema → dashboard, plus one command and ~40 seconds
to a first real turn with a tool call and a stored memory. So under three minutes of machine
time.

That number is honest about the product and dishonest about the experience. Getting *to* the
first command took me about 50 minutes, all of it corporate network: npm's registry IPs were
blocked at TCP, the package was 2 hours old against a 5-day mirror floor, and macOS had cached
a negative DNS result. None of that is evestack's fault. But it is worth knowing that the
product's first instruction, `npx evestack create`, gives **zero output for two and a half
minutes** when the registry is unreachable, and a stranger has nothing to go on.

**2. Where did I get stuck, and did the product unstick me?**

Three times, and the product unstuck me twice.

- `evestack doctor` failing on a healthy stack. **It did not unstick me** — it told me to run
  `docker compose up -d postgres` when Postgres was already up and healthy. I only got past it
  by diffing two generated files and passing the URL by hand. A stranger stops here.
- The empty session page. **It half-unstuck me**: it said the tool count was "unknown, not
  zero" and explained that payloads live on spans, which is what sent me to `/traces` where
  everything was. Good copy rescued a broken join.
- The wedged run after I killed the agent. **`doctor` unstuck me completely** — it named the
  run, the reason, and the fix in one screen. The dashboard, meanwhile, said everything was
  fine.

**3. What did I not trust?**

The aggregate health numbers. Not the raw data — every number I checked against Postgres was
exactly right — but the summaries that go quiet when the thing they summarise is unreachable.
`Failure rate 0%` while the agent was dead and a run was stranded is the single thing that
would stop me leaving this unattended.

I also stopped trusting cross-page agreement after one session reported 12 spans, 90 spans and
no spans on three different pages.

**4. What's missing that I expected?**

- Local time. Every absolute timestamp is UTC. Correctly labelled, never local.
- A way to see tool calls on the session page, which is where you look for them.
- An `unknown` health state that actually gets used. The field exists in `/api/fleet` and stayed
  `0` while the dashboard was blind.
- Nothing else. The feature surface is broader than I expected, not narrower.

**5. Would I run this against something that matters?**

**Not yet, and not far off.** Two things block it, both narrow:

The fleet panel reporting calm while blind is disqualifying for unattended use — that is the
exact scenario self-hosting is for. And `doctor` being dead on arrival matters more than a
normal broken command, because it is the tool you reach for at 3am, and it is *excellent* once
it connects.

Everything underneath is sound. Data survived a `kill -9` mid-turn, a container restart, and a
full `down`/`up` without losing a row. Two projects coexisted with no port collision and no
data bleed. Ports are loopback-only by default and auth fails closed. Nothing left the machine.

**6. One sentence: what is this?**

A self-hosted control plane for eve that installs in about a minute, keeps every run in a
Postgres you own, and is unusually honest about what it does not know — except in the one place
where that honesty matters most.

**7. Of the 20 claims in Part A, how many are TRUE?**

**10 TRUE · 1 FALSE · 7 CAN'T TELL · 2 not reached.**

- **TRUE (10):** 1, 2, 3, 7, 8, 11, 12, 16, 19, 20
- **FALSE (1):** 4 — sessions do not show tool counts. They show `—`. The count exists, on
  another page.
- **CAN'T TELL (7):** 5, 6, 10, 14, 15, 17, 18
- **Not reached (2):** 9, 13

Claim 18 is not false so much as **stale** — the docs no longer make it.

Two FALSE verdicts I reported earlier do **not** belong in this count, because they are rows I
added rather than claims from Part A: sessions-vs-traces disagreement (my row 31) and the
dev-path port binding (my row 28). Both findings stand on their own; they are just not part of
the 20.

Claim 17 sits in CAN'T TELL rather than TRUE, on a technicality I only caught on review: I
verified "never writes" (run/memory/span counts identical across every invocation, and it opens
with `default_transaction_read_only=on` at the server), but I **never actually saw it print
SQL**. Running `doctor --sql` after the agent restart returned *"Nothing to remediate: no job is
both dead and blocking a live run"* — boot recovery had already routed around the dead job, so
the remediation path had nothing to emit. The SQL half is unexercised, not disproven.

Claim 14 likewise: `/evals` listed my real session as promotable and named the file it would
generate, but I never downloaded the draft, never ran it, and never produced a **failed**
session — which is the specific thing the claim emphasises.

**8. Top 5 things to fix before anyone else sees it**

1. **`evestack doctor` must read `.env.local`.** One command, dead out of the box, on the one
   thing the README singles out by name. It is also the only command with no project awareness.
2. **`/api/fleet` must distinguish "nothing is wrong" from "I could not look."** It already has
   an `unknown` field. When `checked == 0` because the agent is unreachable, say so and show
   the banner. This is the finding I would fix first if only one got fixed.
3. **Join the session page's turns to spans on the key spans actually carry** (`turn_0`, not
   the turn's workflow run id). That one join restores the transcript, the tool count, time to
   first token, and arguments and results on the page where people look for them.
4. **Reconcile the numbers in the docs.** Four questions vs two (`quickstart.mdx:24`, npm
   README), ~400 MB vs ~200 MB (npm README), 1,070 vs 1,000+ (npm README, `/integrations`,
   runtime log), and four different command counts on the landing page.
5. **Fix the finish diagram's `"the only thing that leaves this machine"` line for Ollama.**
   Nothing leaves. It is a one-line change that makes the strongest claim in the product true
   at the exact moment a new user is looking at it.

---

## What I did not reach

Parts 5.1–5.5 (mobile width, light/dark, second browser, keyboard-only — the pages were read
over HTTP and through Playwright, not audited visually), 6.1 alerts, 6.5 schedules, 6.7 sandbox
egress, 6.8 channels, 6.9 broken ingest token, 6.10 running a promoted eval, 6.11 MCP and
Composio, 8A's remaining failure paths (wrong ingest token, no-schema database, full disk),
8B's physical network cut, 8E scale, 9A `attach`, 9C the clone path, 9D upgrade, 9E uninstall,
and Part 10 the second reader.

Needs a human or a credential: a paid key (claim 6), a webhook (6.1), a bot token (6.8), a
Composio account (6.11), a phone (5.1), a second machine (8C, though loopback binding settles
it structurally), and a reboot (4.5, 7.4).
