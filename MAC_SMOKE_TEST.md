# Mac live workflow test — September 16, 2026

**Real workflow testing found release blockers that the earlier checks missed.**
The fixes are included in this release candidate. The tested local installation
now supports supervised repository reads, durable memory, decisions and routines.
This is not evidence that tiny models are reliable autonomous operators.

## Installation and scope

- Fresh installation from the candidate npm archives, using a temporary local
  registry for unpublished Eve Stack dependencies. No globally installed package
  was replaced. The generated project passed typecheck and production build.
- An 8 GB Mac running Node 25.2.1, Eve 0.54.5, PostgreSQL 17.10 and real pgvector
  0.8.6. The database timezone was set to UTC.
- Ollama Qwen 3 0.6B with thinking enabled, an 8,192-token context, a 1,024-token
  generation limit and temperature zero. Eve session limits were 40,000 input
  tokens, 3,000 output tokens and 20 minutes. Nomic Embed Text supplied real
  768-dimensional memory vectors. No hosted model API was used.
- A `just-bash` virtual filesystem held copies of four real Eve Stack source
  files from commit `c1d5e83e68b150cba256cfe8f2505ae20bdc6439`. Hashes were recorded.
  The agent had file reading and the template's scoped memory tools. It could
  not change the original repository or run real Git/Node binaries.
- The dashboard ran as a production build on loopback. The test used its actual
  browser interface and authenticated API, plus the installed candidate CLI.

This lightweight setup avoids Docker's VM. It does not validate the default
Docker deployment on this Mac or a hosted repository account connection.

## What passed live

| Workflow | Observed result |
| --- | --- |
| Repository read | The model called `read_file`, read the real dashboard package file and correctly reported `@evestack/dashboard` version `0.5.0`. Tool output and usage were recorded. |
| Browser task | A new task submitted in the browser recalled a fact from an earlier conversation and displayed the correct fact and ID. |
| Memory | `remember` saved Cedar as memory 1 with a real vector. A separate task's `recall` found it. |
| Restart | The agent, dashboard and PostgreSQL were stopped and restarted. Saved history, the fact and the original pending approval survived. |
| Decisions | Cancel and Approve worked in the real browser after the transport fix. Accepted decisions had audit records. Denials left the original fact intact. Multiple requests remained independently answerable. |
| Guided correction | A proposal was recorded. The agent saved Maple as memory 2. Its vector differed and its owner matched. Only after confirming that replacement did an approved `forget` delete memory 1. A fresh `recall` returned only Maple, ID 2. |
| Routine | A manual test completed with a real file read and correct answer. Repeating its submission ID returned the same run. After review and enabling, one actual clock occurrence completed correctly. Pausing prevented further scheduling. |
| Notification | A real local HTTP receiver accepted the manual and clock-run notifications. This was not a Slack, Telegram, Discord or email receipt. |
| CLI and replay | The installed CLI started a conversation and sent two follow-ups. ALPHA, BETA and GAMMA appeared in order. A three-turn replay created a new conversation and returned the same three replies. |
| Cancellation | Cancellation was requested during observed generation. A durable `turn.cancelled` event confirmed it stopped; the user's input remained in history. |
| Browser rendering | Today, Tasks, Routines, Memory, Costs and the task workspace loaded without browser script errors or horizontal overflow at the tested desktop size. |

## Bugs found and fixed

1. **Finished routines stayed active.** Reconciliation compared a PostgreSQL enum
   with an unsupported `errored` value. The query failed for real completed tasks.
   It now uses the supported failed/cancelled states. The routine tests now apply
   the pinned world's actual migrations instead of using a text status column.
   The new test reproduced the failure before the fix and passed afterward.
2. **Follow-ups and decisions were rejected by Eve 0.54.** The dashboard sent a
   legacy continuation token to an endpoint that explicitly rejects it. Commands
   now use the durable session ID. Tests validate their bodies with the pinned
   Eve runtime's own parser. Unknown or busy sessions still fail before sending.
3. **Replay waited for a token that no longer changed.** Sequential replay now
   waits for a new turn ID, preserving the guard against a stale waiting snapshot.
4. **Pending decisions could disappear.** A new turn previously cleared pending
   approvals, and one resolution cleared all browser cards. The server and browser
   now retain unrelated requests and remove only explicitly resolved IDs.
5. **Approval presentation was misleading.** A gated tool now says it is waiting
   for a decision, and Eve's Cancel option uses the decline styling.

The quickstart, architecture notes, local-model guidance and MCP tool description
were updated to match the observed behavior.

Local verification after the fixes: 774 dashboard tests passed; the six database
groups are separate from that run. The selected native PostgreSQL groups passed
44 tests with no skips. All 112 MCP tests and 25 compatibility contracts with
656 assertions passed. Dashboard typecheck, dashboard production build and the
website production build passed. Final-commit CI and the image build are recorded
on the release PR; earlier green checks do not cover later commits.

## Model limitations observed

Llama 3.2 1B made a simple argument-free tool call, but failed the actual file
workflow: it produced malformed arguments and invented an answer. Qwen 0.6B
with thinking disabled also invented file contents. With thinking enabled it
completed the narrow workflows above, but an unrelated question while deletion
was pending caused another deletion request. The approval gate prevented it
from executing without a decision.

Keep these failed attempts in the assessment. They demonstrate why a completed
run, a model's claim of success or an advertised tools capability is insufficient
proof. The correction was guided through separate inspected steps; it was not
an autonomous multi-step success claim.

The Qwen runner used about 1.5 GB while loaded with this context. Download size
is not a RAM estimate. The native setup and small tool set were intentional
choices for this machine.

## Still outside this test

The intended production model, hosted repository permissions, external channel
receipt, Docker deployment on the Mac, long unattended operation, multi-user
isolation and an uncoached first-user experience remain separate checks. Nothing
was merged, tagged or published by this test. Repeat the clean installation from
the public registry and the published image after release.
