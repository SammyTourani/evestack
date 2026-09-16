# Eve Stack release candidate

**Prepared for supervised first use. Live operation still needs verification.**

This candidate turns Eve Stack into a workspace for a solo operator to run a
useful task, inspect its evidence, respond to decisions and schedule a tested
repeat. It remains a technical, self-hosted product with real infrastructure and
provider setup. No claim of perfect safety, team isolation or proven retention
is made.

- Review: [draft PR #57](https://github.com/SammyTourani/evestack/pull/57).
- Scope and detailed evidence: [release checklist](RELEASE_PLAN.md).
- Package notes: [changelog](CHANGELOG.md).
- Publishing procedure: [release runbook](RELEASING.md).
- First-use walkthrough: [repository maintenance brief](docs/first-task.mdx).

The operator supplied a 56-hour window, approximately September 18, 2026 at
02:15 America/Toronto from the initial planning checkpoint. This preparation
does not merge the PR, push release tags or publish packages/images.

## Candidate versions

| Artifact | Version |
| --- | --- |
| CLI `evestack` | 0.7.0 |
| `create-evestack` | 0.13.0 |
| Dashboard image | 0.5.0 |
| `@evestack/budget` | 0.4.0 |
| `@evestack/composio` | 0.3.0 |
| `@evestack/mcp` | 0.4.0 |
| `@evestack/sandbox-opensandbox` | 0.4.1 |
| `@evestack/schedules` | 0.2.1, unchanged |

[The component manifest](release-manifest.json) selects Node 24 or later,
Eve `^0.54.3`, workflow Postgres `5.0.0-beta.42` and Postgres 17. Source CI uses
locked Eve 0.54.3; the September 16 clean npm installation resolved Eve 0.54.5.
A selected version is not proof it has been published or deployed.

## What is ready to review

- **Task workspace:** Today, searchable Tasks, safe readable results, cost and
  evidence, a shared decision interface, retained drafts and clear recovery paths.
- **Routines:** timezone previews, tested DST handling, a test-before-enable gate,
  durable claims, deduplication, revision history and visible uncertain dispatch.
- **Setup and costs:** readiness distinguishes configured from verified, connections
  preserve the intended repository, and budget controls show reported activation.
  CLI configuration has previews, protected backups, stale-write checks and restore.
- **Knowledge and improvement:** owner-aware memory review, correction proposals,
  skill provenance and changed-file review, plus versioned regression cases whose
  observations remain explicitly manual.
- **Operations:** bounded queue/container inspection, notification retry guidance,
  quiet heartbeats, additive schema guards and rehearsed database restoration.
- **Adoption:** current website/screenshots, a concrete first task, CLI/MCP access,
  offline version-matched setup instructions and verified component installation.

## Verification evidence

| Check | Result and boundary |
| --- | --- |
| Package archives | Seven pnpm tarballs checked for resolved dependencies, required files, template manifest, setup fingerprints and accidental private files/patterns |
| Installed CLI | CLI/scaffolder installed from tarballs; final CLI's five setup files installed without network and matched source |
| Generated project | Actual candidate packages installed; typecheck and production build passed; unpublished Eve Stack dependencies used a local registry fixture |
| Component registry | Seven items / ten matching files installed into a stock project; typecheck passed; provider/channel setup skipped |
| CLI tests | 176 passed on macOS; exact final platform results are in the PR |
| Dashboard | 770 non-database tests at the latest runtime checkpoint; six native database groups run separately in CI |
| PostgreSQL | Concurrent claims, stale writes, audited rollback and restore exercised; CI requires pgvector and HNSW backup/restore with no fallback skip |
| Browser | Nine dashboard surfaces and critical failure/retry flows exercised; mobile/keyboard/dark checks; 32 website tests passed |
| HTTP boundary | 24 changed routes reject anonymous requests; 14 write handlers reject foreign origins; applicable body-size limits reject oversized requests |
| Compatibility | 25 contracts / 656 assertions on locked Eve 0.54.3; 18 upstream contracts / 298 assertions on resolved Eve 0.54.5, with seven checkout-only groups explicitly skipped |
| Production audit | Zero reported advisories across 688 production dependencies on September 16 |

The PR's checks must all pass on the final candidate commit, including advisory
Windows/macOS jobs and the separate dashboard image build. Earlier checkpoint
results do not establish that a later commit passed. Local fixture results do
not establish a real provider, repository or external channel result.

## Remaining launch gates

No model or Composio credentials were available in the checkout, shell or scoped
Eve Stack workspaces. These checks need the intended configured installation.
Credentials belong in its private configuration, not in a chat or committed file.

1. **One real repository brief.** Use the [first-task guide](docs/first-task.mdx).
   Select one repository, inspect grants, choose a modest enforced budget and run
   the read-only prompt. Inspect actual tool results, source links and reported
   usage. A completed task with fabricated or inaccessible evidence fails this gate.
2. **One real scheduled occurrence.** Review the test result before enabling its
   routine. Leave the clock and agent running, then inspect the occurrence, task
   link and result. Confirm a pause prevents new dispatches; it does not cancel
   work already running.
3. **Actual delivery and recovery.** Observe a notification or channel receipt at
   its real destination. Exercise a harmless approval and a controlled failure;
   inspect the decision history and recover without repeating an uncertain write.
4. **Memory correction.** Complete a
   reviewed correction through the scoped agent tools, then verify changed recall
   and a recomputed embedding. The dashboard proposal alone does not pass.
5. **First-user rehearsal.** Have someone unfamiliar with the repository complete
   installation and the first useful task without coaching. Record each confusing
   step and whether the result was useful enough to repeat.
6. **Release decision and publication.** Review the full PR and exact CI result,
   then follow the runbook's dependency order. After publication, repeat the clean
   install against the public registry and pull the versioned dashboard image.

If those live checks cannot be completed before the deadline, ship only as an
explicitly supervised preview with the limitations stated. Do not present it as
validated unattended production software.

## Operating limits to preserve in release messaging

Shared dashboard credentials identify the installation, not individual teammates.
Prompt text is not an enforced permission. Composio is a hosted dependency; model,
embedding, infrastructure and integration usage may cost money. Budgets are
observed controls, not a prepaid billing system. Skill review is not a publisher
signature or sandbox guarantee. Regression comparisons do not run an isolated
evaluation automatically. Trace and audit history may retain data removed from
active recall; backups and restored pending work need deliberate handling.

Use the pilot to measure successful first tasks, inspected scheduled results,
usefulness and repeat use before expanding into team identities, document storage
or a broader catalog of autonomous workflows.
