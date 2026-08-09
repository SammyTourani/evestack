# evestack

One command for the whole self-hosted [eve](https://github.com/vercel/eve) stack.

Seven commands. Run `evestack` inside a project with no arguments and you get `status`.

```bash
npx evestack create my-agent    # scaffold an agent, a database and a dashboard
evestack status                 # is it up? and if not, what do I run?
evestack tour                   # a guided first run, on a stack that is already up
evestack open                   # the dashboard URL and its password, in a browser
evestack verify                 # check every part and name the fix for anything broken
evestack attach .               # add evestack to an eve project you already have
evestack doctor                 # a run stopped moving — read-only forensics
```

`status`, `tour`, `open` and `verify` all work from anywhere inside the project; they walk up to
find its root. Asking for help never writes, starts or opens anything.

`create` and `attach` are [`create-evestack`](https://www.npmjs.com/package/create-evestack),
imported rather than reimplemented — `npx create-evestack my-agent` is the same code under the
name npm's `create-*` convention leads people to, and it keeps working. The dependency points
this way round because the scaffolder is dependency-free and carries the agent template, while
`doctor` needs a Postgres driver; inverting it would put `pg` in front of every first scaffold.
See `src/scaffold.mjs`.

The rest of this file is about `doctor`, which is the part that is neither a wrapper nor a probe.

## `evestack doctor`

A self-hosted eve agent runs its durable sessions on
`@workflow/world-postgres`, which runs on [graphile-worker](https://worker.graphile.org/). When a
worker process is killed mid-turn, the job it was holding can become **permanently unclaimable** —
and through every supported surface it reads as healthy. This finds those, says which kind of dead
each one is, and prints the SQL.

---

## What it actually does

> **It explains. It does not fix.**
>
> There is no `--fix` and there will not be one. `@workflow/world-postgres` moved beta.31 → beta.38
> in two days, and the table that holds the answer is one graphile names `_private_jobs`. A tool that
> writes to that combination is a state corrupter waiting for a schema bump. `evestack doctor` opens
> a connection with `default_transaction_read_only = on`, prints remediation SQL, and stops.

That is the whole claim. Everything below is detail.

## The finding

graphile's `_private_jobs` has a generated column:

```sql
is_available boolean generated always as
  ((locked_at is null) and (attempts < max_attempts)) stored
```

and `getJob` spends an attempt in the **same statement that takes the lock**:

```sql
attempts = jobs.attempts + 1
```

So an attempt is charged at *claim* time, not at *failure* time — and `@workflow/world-postgres`
enqueues every message with `maxAttempts: 3`. Three process **deaths**, which were never retries in
any meaningful sense, exhaust the budget.

Three consequences, and they are why this is hard to diagnose by hand:

1. **Clearing the lock cannot work.** The term of `is_available` that went false is
   `attempts < max_attempts`, not `locked_at is null`. Clearing `locked_at`, bumping `run_at` and
   firing `pg_notify('jobs:insert','')` all do exactly nothing — *and each successful clear before
   the last one spends another attempt*, so the remediation is the mechanism.
2. **There is no error to find.** The process died rather than failed, so `failJob` never ran and
   `last_error` stays `NULL`.
3. **The row reads as healthy.** graphile's public `jobs` view does not expose `is_available`. Through
   the supported surface you see no error, no lock, and a `run_at` in the past.

Reproduced with real `SIGKILL`s in
[`contract/runtime/repro/graphile-crash-wedge.mjs`](../../contract/runtime/repro/graphile-crash-wedge.mjs)
(36 assertions, verified against graphile-worker 0.16.6 and `@workflow/world-postgres`
5.0.0-beta.31). Upstream: [vercel/eve#535](https://github.com/vercel/eve/issues/535).

There is a second, faster route to the identical row: re-enqueue under a job key a held job already
owns, and graphile deliberately retires the old one with
`set key = null, attempts = jobs.max_attempts`. One crash, same end state.

## Why this isn't already in your queue

Because everyone charges for it. "Crashed worker recovery" is the paid tier of **Graphile Worker
Pro**, **Sidekiq Pro**, **Oban Pro**, **Prefect Cloud**, **River Pro** and **DBOS Conductor**. Nobody
paywalls a dashboard.

## The three kinds of dead job

This is the distinction the tool exists for, and getting it wrong would be its first lie. All three
look identical in `select * from graphile_worker.jobs`:

| | Signature | What the doctor says |
| --- | --- | --- |
| **Process death** | `last_error` NULL, no other claimable job for the run | A fault. Remediation SQL is printed. |
| **Genuine failure** | `last_error` set | A warning. **No SQL** — it failed for a reason, and resetting `attempts` re-runs code that already failed three times. |
| **Retired leftover** | `last_error` NULL, but the run already has a claimable job | A note. Leave it: reviving it executes the same turn twice. |

Process-death jobs are split once more, by what the run is doing. A dead job whose run already
completed cost nobody anything; only a dead job blocking a `pending`/`running` run is a fault.

## Usage

```
evestack doctor [options]

  --schema=NAME     graphile-worker's schema      (default: graphile_worker)
  --workflow=NAME   eve's workflow schema         (default: workflow)
  --url=URL         Postgres                      (default: $WORKFLOW_POSTGRES_URL, then $DATABASE_URL)
  --agent-url=URL   the eve agent                 (default: $EVESTACK_AGENT_URL, then http://127.0.0.1:2000)
  --limit=N         max rows listed per section   (default: 50; counts are never capped)
  --probes=N        max sessions probed, 0 to skip (default: 25)
  --idle=MINUTES    quiet-session threshold       (default: 30)
  --timeout=MS      statement_timeout and HTTP    (default: 15000)
  --sql             print only the remediation SQL
  --json            the whole diagnosis as JSON
  --verbose         the raw rows behind each finding
```

Exit codes, matching the repro scripts in `contract/runtime/`:

| | |
| --- | --- |
| `0` | nothing is costing you a run |
| `1` | at least one fault — a stranded run, a wedged job, a wedged session |
| `2` | could not look — no database, wrong schema, bad arguments |

`--sql` writes SQL to stdout and nothing else, so `evestack doctor --sql | psql "$WORKFLOW_POSTGRES_URL"`
is a decision you make, deliberately, rather than one this tool makes for you.

## What it looks like

```
  FAULT  1 job died of process death and is blocking a live run
         Clear `attempts`, not `locked_at` — locked_at on these rows is already NULL and was
         never the term of is_available that went false — using the SQL printed below.

         job  attempts  last_error  run        run_status  session
         ---  --------  ----------  ---------  ----------  ---------
         1    3/3       NULL        wrun_live  running     wrun_sess

   WARN  1 job exhausted its attempts with a real error
         Fix the cause and re-enqueue: these are NOT the process-death case, and resetting
         `attempts` would only re-run code that has already failed on purpose.
```

Every finding carries exactly one action sentence. There is a test that asserts that.

## Safety

Pointing a diagnostic at production during an incident is the entire use case, so:

- **The connection is pinned read-only at the server** with `default_transaction_read_only = on`, not
  merely by our own care. If the `SET` does not stick — a pooler in transaction mode drops
  session-level `SET` — the report says so in its header rather than claiming a guarantee it lost.
- **Every statement is bounded** by `statement_timeout` (default 15s). The queue aggregates scan
  `_private_jobs` without an index to help them; the timeout is what keeps that from being a denial
  of service we caused.
- **Schema names are validated, not quoted.** They cannot be bind parameters, so anything that is not
  a bare identifier is refused.
- **Missing schemas degrade, they do not crash.** No `graphile_worker`? It says which flag to pass. No
  `workflow.workflow_runs`? Jobs are still reported, without run correlation, and the report says that
  is what happened.
- **The password never appears in output**, in the terminal or in `--json`.

## Known holes

- **It reads a private table.** `_private_jobs` is named that way for a reason. It is read anyway
  because the public `jobs` view omits `is_available`, and there is no way to answer "why is this job
  dead" without it. Every column is probed before use: if `is_available` disappears, the tool computes
  it from graphile's own definition and **says in the report that it derived it** rather than
  pretending it read it.
- **The runId is decoded, not joined.** `world-postgres` stores the workflow body base64-encoded
  inside the graphile payload and keeps no foreign key. The base64 shape is checked before `decode`
  runs and the id is pulled with a regex rather than a `::json` cast, because one malformed payload
  row would otherwise abort the whole diagnosis. Rows it cannot decode are reported as undecodable,
  never guessed at.
- **The tombstone is an inference.** A retired job has `key = NULL` — but so does a job enqueued with
  no job key at all. The tool only calls one retired when a *claimable sibling job for the same run*
  exists, which is the part that makes it safe to say.
- **Session health needs the agent.** `idle`, `awaiting-human` and `wedged` are indistinguishable in
  the workflow tables: eve leaves a session's run row `running` and its stream `waiting` for the life
  of the session. Only the event stream separates them. **When the agent is unreachable this tool
  refuses to classify** and says so, rather than guessing — `packages/dashboard/lib/fleet.ts` guessed
  from SQL alone in its first version and reported 22 healthy sessions as wedged.
- **The classifier is duplicated, not imported.** It is a port of the dashboard's `fleet.ts`; the
  dashboard is containerised from an isolated build context where a `workspace:*` dependency fails the
  image build, and this package publishes standalone. Same forced duplication as the pricing table in
  [`@evestack/budget`](../evestack-budget/README.md), and the same risk: change one, change both.
- **The enqueue ratio is a floor, not a count.** graphile `DELETE`s a job on success, so every
  duplicate that actually ran is already gone and cannot be counted.
- **It is a diagnosis, not monitoring.** It tells you the state of the queue at the moment you ran it.

## What has actually been verified

Stated precisely, because "tested" is doing a lot of work in most READMEs:

- **The mechanism**: reproduced with real `SIGKILL`s against a real graphile-worker in
  `contract/runtime/repro/graphile-crash-wedge.mjs` — 36 assertions, including a control run at
  graphile's default `maxAttempts: 25` that survives the identical three crashes.
- **The queries**: every query in `src/queue.mjs` and `src/sessions.mjs` has been executed against a
  real Postgres 17 over a fixture containing one of each row type — process death, genuine failure,
  retired duplicate, dead-but-completed, one-attempt-left, stale lock, healthy, and a payload that is
  not a workflow body at all. The generated column and the public view are recreated verbatim from
  graphile migration 000011.
- **The claim itself, executed**: in that fixture, applying the printed remediation makes the row
  claimable again, and clearing only `locked_at` on the same row does not.
- **The judgements**: 39 unit tests, including the regression that a session `waiting` with nothing
  outstanding is `idle` however long it has been quiet.

Not yet verified: a run against a long-lived production queue. The read-only auditor this tool grew
out of (`contract/runtime/repro/scan-wedged-jobs.mjs`) has been run against real data — 186 job rows,
95 runs, 2 genuinely dead jobs, 0 stranded runs — but that was the script, not this package.

## License

Apache-2.0
