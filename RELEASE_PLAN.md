# Evestack release candidate plan

Owner: release implementation in `codex/complete-security-remediation`.
Baseline: `0d0b83a` (September 15, 2026). The operator confirmed a 56-hour release window, approximately September 18 at 02:15 America/Toronto from the initial planning checkpoint. Publishing is a separate final action.

## Release outcome

A solo developer can connect a source, run useful work, inspect its result and evidence, respond to a decision, schedule a repeat, and understand a failure. Keep existing developer and diagnostic capabilities accessible. Never present a prompt instruction as an enforced permission or a successful request as proof of its external effect.

Status: `[ ]` queued, `[-]` in progress, `[x]` verified, `[~]` implemented awaiting verification. Each completed group records evidence below. Tasks that require real users or credentials remain explicit gates rather than invented results.

## 1. Preserve the release baseline

- [x] Prior security/compatibility fixes on a clean branch; exact baseline CI green.
- [x] npm trusted publishing, strongest publishing MFA, repository protection and private vulnerability reports configured.
- [ ] Keep additive schema changes restart-safe; document their rollback/data implications.
- [ ] Keep credentials, generated local data and test fixtures out of committed artifacts.
- [ ] Review each change for authentication, origin checks, bounded input and truthful failure states.

## 2. Task workspace and reliability

- [x] Preserve new-task and follow-up drafts when delivery fails; distinguish rejected from uncertain delivery.
- [x] Retain approvals on submission failure; prevent duplicate decision submissions.
- [~] Report cancellation failures and offer an explicit recovery action.
- [x] Render readable Markdown/code with safe links and no raw HTML execution.
- [~] Connect new task, recent tasks, conversation, result, cost and evidence.
- [~] Use task outcome as primary status; retain runtime lifecycle in details.
- [~] Fix session breadcrumb and preserve old deep links.
- [~] Add explicit reconnect/retry states without silently repeating side effects.
- [~] Provide result links and evidence using actual recorded data.
- [x] Support saving a task prompt as a routine.

## 3. Navigation, Today and mobile

- [x] Primary navigation: Today, Tasks, Routines, Connections, Knowledge.
- [~] Secondary Settings and Diagnostics preserve metrics, traces, monitors and sandbox inspection.
- [~] Today: pending decisions, blocked work, recent results, upcoming routines and readiness.
- [~] First-use checklist with a useful editable repository maintenance brief.
- [x] Mobile menu with keyboard support, visible sign out and no page overflow.
- [x] Mobile task cards; retain full table for detailed analysis.
- [ ] Empty/loading/error states with a concrete next action.
- [ ] Accessible labels, focus, live feedback, responsive layout and dark mode.

## 4. Decisions and audit

- [x] Real pending approval API/queue, including unreachable/unknown state.
- [x] Shared decision component in queue and task workspace.
- [x] Show exact proposed tool/input, request wording and available choices.
- [ ] Pending counts and links to the affected task.
- [x] Keep historical decisions and attribution provenance accessible.
- [x] Do not imply shared installation credentials identify individual teammates.

## 5. Routines

- [ ] Versioned additive routines/run schema and bounded queries.
- [x] Create/edit/archive/pause/resume, explicit timezone, next-three preview.
- [x] Daily, weekly and five-field cron schedules using one preview/dispatch evaluator.
- [x] DST gap/repeat behavior tested, including non-hour offsets.
- [x] Durable transaction claim before execution; no execution on database failure.
- [x] Multiple workers cannot claim the same occurrence; one active run per routine.
- [x] Revision snapshots and auditable changes; pause/edit/archive race handling.
- [x] Run now with request deduplication and active-run protection.
- [x] Bounded latest-occurrence catch-up; skipped occurrences visible.
- [x] Ambiguous dispatch stays visible and never automatically repeats.
- [x] Reconcile run state with the actual task; approvals keep a run active.
- [~] Explicit Node-only clock startup, build guard, shutdown and clock health.
- [~] Routine history, task/result links, error and next-action copy.
- [x] Editable read-only brief example; test before enabling unattended work.
- [x] Preserve code-authored schedules and heartbeat as separate execution paths.
- [x] Reuse configured notification delivery with deduplication; no arbitrary prompt-controlled destination.

## 6. Setup, settings, spend and connections

- [~] One readiness surface: database, agent, model, embeddings, connections and notifications.
- [ ] Resume incomplete setup and recheck individual failures.
- [~] Model/provider settings explain actual configuration source, capabilities and restart requirements.
- [x] Budget enforcement, remaining budget, unknown prices, per-principal scope and fail-open/closed policy visible.
- [x] Budget edits affect the enforcing process, with validation and a reported activation revision.
- [ ] Provider and channel configuration have a safe edit/activation path.
- [x] Repository connection flow preserves the selected task, identifies its account and explains where scopes must be reviewed.
- [~] Disclose Composio's hosted OAuth dependency; expose health/reconnect/revoke where supported.
- [x] Read-only authorization check and repository brief draft; actual repository access remains a task-level verification.
- [x] Notification setup/test, delivery status and affected-task links.
- [ ] Inbound channel setup, allow-list guidance, test receipt and task links.
- [ ] Heartbeat editable examples, preview, quiet delivery/quiet hours and execution-path explanation.
- [~] Data destinations and retention shown clearly; do not claim tenant isolation or team RBAC.

## 7. Knowledge and warning quality

- [x] Knowledge landing page distinguishes remembered facts and installed skills.
- [x] Memory owner/shared state, source session and retention semantics visible.
- [x] Append-only reviewed/stale/conflicting/correction-proposal history bound to the exact memory and owner; stale writes rejected.
- [x] Editable correction-task handoff preserves the proposal and original owner without changing recall or starting a task.
- [ ] Verify an applied correction and recomputed embedding through a real agent's scoped memory tools.
- [x] Explain removal from recall versus retained audit copies; expose supported retention controls.
- [x] Skill finding review bound to exact file hash; changes reopen review.
- [x] Resolve bundled safety-skill false positive without exempting quoted attacks globally.
- [ ] Show skill source/version/capabilities and changes since review when evidence exists.
- [x] Explain scanning versus enforcement; preserve scanner self-tests.

## 8. Recovery, evidence and regression improvement

- [ ] Task failures link to relevant traces and recorded last successful work.
- [ ] Read-only doctor findings available alongside recovery guidance.
- [ ] Safe reconnect/resume distinguished from replay that repeats tools.
- [ ] Replay preview and original/candidate comparison based on available evidence.
- [ ] User correction can become a versioned regression case.
- [ ] Show regression draft/results with explicit baseline/candidate and execution provenance.
- [ ] Retain historical evidence when the agent is unavailable where storage supports it.
- [ ] Execution environment, network policy and lifetime displayed only when known.
- [ ] Keep Docker inspection read-only; host controls require a narrowly authorized service.
- [ ] Actionable incidents and external liveness-check guidance for unattended use.

## 9. Shared control plane and developer adoption

- [~] Paginated/searchable task API and complete task detail.
- [x] MCP uses real task APIs instead of the five-session approximation.
- [x] Read-only routine/decision views in MCP; mutation capabilities explicit and separately gated.
- [ ] CLI links/actions share the dashboard API and preserve server credential boundaries.
- [ ] Attach change preview, compatibility/permissions summary and attach health checks.
- [ ] Component release manifest with supported version combinations.
- [ ] Upgrade preview that preserves user configuration and reports manual conflicts.
- [ ] Backup/restore procedure verified with disposable data; service start/stop/state guidance.
- [ ] Guided removal with explicit data choices and no implicit destructive defaults.
- [ ] Registry dry-run/install verification and standalone/component compatibility notes.

## 10. Public release and product promise

- [ ] Website shows the recurring-work use case, real prerequisites and a representative result.
- [ ] Update screenshots and walkthrough to the shipped interface.
- [ ] Fix README platform, runtime pin and verification-count drift.
- [ ] Version-matched docs and coding-agent pack; no claims beyond implemented behavior.
- [ ] Release notes cover features, security fixes, upgrade steps and limitations.
- [ ] Bump every changed published package; synchronize template/registry/CLI dependencies.
- [ ] Verify packaged tarballs and clean generated-project installation.
- [ ] Check supported Node platforms, full tests/typecheck/build, workflow checks and dependency audit.
- [ ] Browser verification of new-task failure/retry, decision failure/retry, routine CRUD/run/pause, mobile and dark mode.
- [x] Native PostgreSQL concurrency/dispatch recovery verification.
- [ ] Live provider/source smoke run with bounded spend and explicit result inspection when credentials are available.
- [ ] Signed commits, current PR description and green CI on the final exact commit.
- [ ] Concrete release candidate summary; disclose any unmet gate before publishing.

## 11. Validation after candidate delivery

These are required product learning, not claims a coding session can prove.

- [ ] Have a first-time user install and complete the first useful task without coaching.
- [ ] Run the recurring example through its real scheduled occurrence and inspect the result.
- [ ] Observe a real approval, failure and recovery with the operator.
- [ ] Recruit a small supervised pilot and record task usefulness and repeat use.
- [ ] Use those observations to prioritize team identities, attachments/document storage, isolated eval execution and additional recurring-job templates. Each requires a real storage/security/identity contract before shipping.

## Verification log

- Baseline: all 11 required CI checks and image build green on `0d0b83a`; this does not verify subsequent changes.

### First implementation checkpoint (September 15)

- Added Today/Tasks navigation, pending decisions, Routines, Connections/Knowledge/Settings/Diagnostics surfaces, safe Markdown, recoverable chat delivery and skill content review.
- Browser checks against an isolated fixture passed for nine pages, new-task failure, question decisions and failed decision retry, audit warnings, routine preview/create/pause/enable rejection, and mobile keyboard navigation. Screenshots exposed a primary-button styling issue, corrected afterward; repeat visual verification remains pending.
- Dashboard: 736 tests passed plus one native-DB group run separately. Subsequent stream/skill changes are being rechecked.
- Native PostgreSQL 17.10: 10 tests passed, including independent-process claims, manual deduplication, pause before dispatch, ambiguous HTTP, crash recovery/resolution, pending approval reconciliation, cancelled test rejection and database outage.
- Six timezone tests and two untrusted Markdown rendering tests passed.
- MCP now reads paginated task APIs and routine/decision state. Approval authority requires a separate explicit flag; matching tests and documentation are being updated.
- This is an implementation checkpoint, not a release sign-off. Packaging, final CI, live-provider validation and the remaining backlog are still open.

### Second implementation checkpoint (September 15)

- Dashboard production build and 738 non-database tests passed; the native PostgreSQL suite passed 12 tests, including automatic pause/audit rollback and saved budget revisions reaching the actual hook before a model call.
- MCP: 110 tests passed, including task search/cursor encoding, bounded task history, budget configuration provenance, unavailable-data handling and separately gated approval authority. Response-size documentation matches measured output.
- Browser checks passed for safe Markdown, final partial stream lines, repeated identical messages, failed follow-up drafts, reconnection after accepted continuation, task-to-routine drafts, saved budget controls, unknown activation and stale-edit rejection. Skill review save/hash checks passed; a real-file-change check is being added.
- Visual inspection caught an anchor-specific primary-action text contrast issue. Corrected the CSS selector; the final rebuild and screenshot check remain pending.
- Added routines operation/rollback documentation. Contract checks identified two undocumented environment variables, now documented; rerun pending.

### Verified checkpoint before connection and recovery work

- 25 compatibility contracts / 623 assertions pass against Eve 0.54.3. All workspace typechecks pass. Dashboard: 738 tests pass, with the native database group run separately. MCP: 110 tests pass. Budget: 54 tests pass.
- Native PostgreSQL: 13 tests pass. The additional long-task fixture verifies the API returns and labels its latest 500 runs without loading an unbounded diagnostic tree first.
- Extended browser verification passed, including a real skill-file change reopening its content review. Desktop/mobile captures confirm primary-action text is visible, safe Markdown renders, and the task-to-routine draft survives navigation. No browser script errors were recorded.
- Added runtime-image checks for shared budget settings and routine preview, and expanded the image workflow to watch changes in its budget dependency. Their first CI execution remains pending.
- This checkpoint is still a draft: notifications, guided setup/recovery, package version coordination, clean-install validation and final CI remain open.

### Notification and browser reliability checkpoint

- Routine state changes and their destination records commit in one transaction. Competing workers claim deliveries once, successful destinations are retained, and bounded retries preserve a receiver deduplication ID. Exhausted delivery needs an audited manual retry; receivers that do not deduplicate can receive a duplicate after an ambiguous response.
- Native PostgreSQL: 14 tests pass, including concurrent notification claims, a lost acknowledgement, exhausted/manual retries and removed destinations. Dashboard: 741 tests pass and one native group runs separately; typecheck and production build pass.
- A real local HTTP receiver accepted the dashboard's synthetic test and an explicitly retried routine notification. Browser checks verified the failed state, acknowledgement gate, stable delivery ID and refreshed accepted state, with no script errors or mobile overflow.
- Notification payload tests cover mention suppression and credential-bearing dashboard URLs. Transport tests verify error bodies are bounded and URLs redacted before storage.
- Website: all 32 browser tests pass after full-size menu placement, resize/font remeasurement and removal of the hero's hidden scroll container. A regression covers keyboard access after viewport resize. Escape verification now targets the same DOM node after it leaves the accessibility tree. CI retains failure screenshots/traces and uses Metal only on macOS.
- Checkpoint `57d307f` passed the image, runtime and platform checks; its general test job failed on the website hover interaction. The next signed checkpoint must verify these fixes in CI.
- The Linux trace for `222ba33` showed the remaining hover failure came from the automation helper centering an already visible menu item, scrolling 361 pixels and triggering the hero scrub. The gap test now moves the pointer directly and asserts scroll position stays unchanged; all 14 agent-menu tests pass locally. Keyboard and resize reachability remain separately tested. CI verification is pending.

### Guided connection checkpoint

- CI and runtime-image checks both passed on signed commit `c1d8f10`; the Linux menu issue is resolved in that checkpoint.
- Connections now preserves a repository choice through authorization, checks grants against the configured identity, distinguishes active/expired/missing/unknown results and prepares an editable request with evidence requirements. The check does not verify repository access, scopes or custom agent configuration.
- Ten connection tests cover foreign identities, incomplete/malformed responses, size limits, secret redaction, ambiguous writes, return-path restrictions, cross-site/oversized forms and unsafe redirects. Dashboard: 751 tests pass, with the native database group separate. All 25 contracts / 623 assertions pass.
- Browser verification against a local Composio fixture passed for failed/repeated checks, OAuth-return draft preservation, an editable task handoff without repository text in the URL, and mobile layout. No actual GitHub authorization or repository execution is claimed.

### Memory review checkpoint

- Guided connection commit `31e2d9e` passed CI and runtime-image checks.
- Remembered facts now show ownership, sharing, source tasks and retention. Review history is append-only and tied to the current record, including owner and row version. A proposed correction prepares an editable agent task; it does not silently replace text or embeddings.
- Dashboard removal locks and checks the current record and records the original owner in the same transaction. An audit write failure rolls the removal back. The interface keeps stale-review drafts and explains uncertain removal responses.
- Native PostgreSQL: seven tests pass for legacy ownership, proposal isolation, concurrent changes/deletes, vector-only changes, audit rollback and retained history. These tests are included in CI alongside routine durability.
- Dashboard: 752 tests pass, two native suites run separately; production build passes. Browser verification of the built memory page passed proposal handoff, stale review/delete rejection, deletion ownership/audit, mobile layout and no JavaScript errors. Template memory tests: 24 pass. Memory documentation and template error messages now prescribe backup and re-embedding instead of dropping the memory table.
