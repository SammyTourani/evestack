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

- [x] One readiness surface distinguishes verified, configured, unavailable and unknown results for database, agent, model, embeddings, connections and notifications.
- [x] Recheck individual setup items, label a previous result after a failed check and link to each remaining setup action.
- [~] Model/provider settings explain actual configuration source, capabilities and restart requirements.
- [x] Budget enforcement, remaining budget, unknown prices, per-principal scope and fail-open/closed policy visible.
- [x] Budget edits affect the enforcing process, with validation and a reported activation revision.
- [x] Provider/channel configuration has a terminal preview, fingerprint check, private backup, atomic env replacement and restore path; saving explicitly requires subsequent restart and verification.
- [x] Repository connection flow preserves the selected task, identifies its account and explains where scopes must be reviewed.
- [~] Disclose Composio's hosted OAuth dependency; expose health/reconnect/revoke where supported.
- [x] Read-only authorization check and repository brief draft; actual repository access remains a task-level verification.
- [x] Notification setup/test, delivery status and affected-task links.
- [x] Inbound channel setup, allow-list guidance, a manual receipt check and links to the selected task; no automated external receipt is implied.
- [x] Heartbeat editable examples, exact prompt/recipient preview, quiet delivery/quiet hours and execution-path explanation.
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
- [x] Show skill source/version/capabilities and changes since review when evidence exists.
- [x] Explain scanning versus enforcement; preserve scanner self-tests.

## 8. Recovery, evidence and regression improvement

- [x] Task failures link to relevant traces and recorded completed turns / explicitly successful tool spans, with coverage limits.
- [x] Read-only CLI doctor findings available on demand alongside recovery; live session diagnosis remains explicitly separate.
- [x] Safe reconnect distinguished from follow-up and replay that can repeat tools.
- [x] Replay preview and original/candidate comparison based on available evidence; unrecorded tools are not a promise about replay behavior.
- [x] User correction becomes a versioned regression case with immutable original evidence and stale-write protection.
- [x] Show original/candidate snapshots, exact-revision manual observations and explicit unknown execution provenance; no automated pass is implied.
- [x] Retain historical workflow/trace evidence while the agent is unavailable, including explicit partial-read failures.
- [x] Execution environment, network mode and lifetime observations distinguish known, unavailable and omitted coverage; custom policy remains unverified.
- [x] Keep Docker inspection read-only, bounded and explicitly opted in; no host mutation controls added.
- [x] Actionable incidents and external liveness-check guidance for unattended use.

## 9. Shared control plane and developer adoption

- [~] Paginated/searchable task API and complete task detail.
- [x] MCP uses real task APIs instead of the five-session approximation.
- [x] Read-only routine/decision views in MCP; mutation capabilities explicit and separately gated.
- [x] CLI links/actions share the dashboard API and preserve server credential boundaries.
- [ ] Attach change preview, compatibility/permissions summary and attach health checks.
- [x] Component release manifest with selected version combinations and storage guards; deployment verification remains separate.
- [x] Upgrade preview that preserves user configuration and reports manual conflicts.
- [x] Backup/restore procedure verified with disposable data, including pgvector in CI; service start/stop/state guidance.
- [x] Guided removal with explicit data choices and no implicit destructive defaults.
- [ ] Registry dry-run/install verification and standalone/component compatibility notes.

## 10. Public release and product promise

- [ ] Website shows the recurring-work use case, real prerequisites and a representative result.
- [ ] Update screenshots and walkthrough to the shipped interface.
- [ ] Fix README platform, runtime pin and verification-count drift.
- [ ] Version-matched docs and coding-agent pack; no claims beyond implemented behavior.
- [ ] Release notes cover features, security fixes, upgrade steps and limitations.
- [x] Bump changed published runtime packages; synchronize template/registry/CLI dependencies.
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

### Readiness and recovery checkpoint

- Settings now separates a successful probe from configuration presence, exposes six individual checks, and preserves the last result with an explicit stale warning if rechecking fails. Checks do not invoke a model or send notifications. Model and embedding execution still need a real task.
- The task workspace reads bounded workflow and trace evidence directly from Postgres, independent of agent availability. It links recorded failures, completed turns and explicit successful tool spans, and exposes retained response text with coverage limits. Mobile recovery details are collapsible and the actual connection error appears first.
- Native PostgreSQL: six recovery tests pass, including missing trace schema without schema creation, cross-task separation, unknown versus successful tool status, missing model evidence and truncation. Configuration/HTTP readiness tests pass; the full dashboard suite passes 755 tests with three native suites separate. Production build and all 25 compatibility contracts / 623 assertions pass.
- Browser checks cover individual check failure/recovery, unknown/configured distinctions, offline-agent evidence access, desktop/mobile layout and no JavaScript errors.
- Regression downloads now refuse an incomplete transcript tail instead of generating a misleading replay. Export remains an unexecuted draft whose assertions require review.
- Memory checkpoint `c2d2881` passed the runtime-image build, but CI found an omitted registry rebuild and an old cancellation probe that demanded a minimum streaming tail. Registry output is synchronized. The probe and user-facing copy now allow immediate or delayed termination and require an acknowledgement plus readable history, without claiming a 202 proves termination. Verification of this correction in CI is pending.

### Configuration checkpoint

- Both CI and the runtime-image build passed on `83a79d6`, including the corrected cancellation probe and registry checks.
- `evestack configure` previews supported provider, memory, connection, notification and inbound-channel env settings. It redacts credentials, rejects stale previews across both env files, preserves unrelated content, refuses tracked/unignored files and takes an owner-protected backup outside the project before replacing the file. Restore is previewed and backed up too. A lock serializes CLI writers; external editors should not edit during apply.
- Secrets use a bounded JSON file instead of command-line values. Duplicate/multiline/interpolated settings need manual review. Wildcard channel access requires an explicit flag. The command reports shell overrides and leaves activation unverified until restart and an actual task or receipt test.
- CLI suite: 153 tests pass locally, including preview/apply/restore, stale and concurrent edits, Git protection, symlinks, redaction, UTF-8 validation, corrupted backups and literal shell text. Windows uses an explicit owner-only ACL; that platform path awaits CI execution.

### Regression case and data-preservation checkpoint

- Configuration commit `70963dd` passed the required checks but failed the advisory Windows job. `c7aaa90` added diagnostics and explicit creation ownership; the remaining error was Windows PowerShell loading an incompatible security module. `8add6d7` uses native Windows ACL APIs and the Windows job now passes, as does required CI. Permission protection was retained throughout.
- Saved corrections now capture actual task evidence and expected behavior. Later tasks can be selected by title and compared against the immutable original. Manual observations are tied to the exact case revision; editing the expectation leaves it unreviewed until a new observation. No task or eval is executed by this workflow.
- Regression writes validate current evidence fingerprints and serialize version edits; repeated create/review request IDs do not duplicate records. Schema guards follow the repository's transactional convention and running writers recheck the marker before saving. Health detects an unsupported regression schema.
- Native PostgreSQL recovery/regression suite: 12 tests pass for bounded evidence, separation between tasks, concurrent edits, stale candidates, retry deduplication, retained revisions, atomic rollback and downgrade refusal. Dashboard: 756 tests pass, three native suites separate; production build passes. Compatibility: 25 contracts / 627 assertions pass.
- Browser verification passed authenticated creation, retained fields after failed delivery, task-title selection, candidate preview changes, manual observation history, new-revision isolation, stale edits, mobile/dark layout and no JavaScript errors.
- Removed schema-wide deletion advice from trace/fact error messages and observability documentation. The evestack schema contains durable operator data, so repair guidance now requires a matching image and a backed-up component-specific procedure.

### Terminal and coding-agent access checkpoint

- All CI jobs, including Windows and macOS, and the runtime image passed on `ac25cf6`.
- Added authenticated `tasks`, `routines` and `readiness` CLI commands. Tasks support search/cursors, detail, saved recovery, explicit start/reply from a bounded message file and cooperative stop. Remote credentials require HTTPS, redirect following is disabled, unrelated flags are refused and mutations never retry. An accepted request is not reported as task completion.
- CLI: 163 tests pass, covering actual HTTP authentication, route encoding, flag/file validation, size limits, timeout/lost-response uncertainty and routing. Against the built fixture dashboard, the CLI read a paginated task list, detail, recovery fingerprints, routine history and all six setup checks. Offline agent/model uncertainty remained visible; no real provider call was made.
- MCP adds read-only recovery, readiness, memory/review and regression-case tools over the same routes. Ownership, pagination, evidence coverage, stale-review hashes and exact-revision manual observations are retained. Full MCP suite: 112 tests pass, including no-control access, route traversal and invalid-argument refusal.

### Spend monitoring consistency

- The daily spend monitor now follows Settings' saved daily cap and timezone, preserving an explicitly configured installation alert threshold. It labels the saved revision, the difference between installation spend and a per-principal cap, and unknown current enforcement.
- A failed or partial policy read reports unknown instead of falling back to an obsolete environment value. A pre-controls installation retains a labelled environment fallback. Both local-day boundaries use the selected timezone.
- Dashboard suite: 760 tests pass, three native suites separate. Typecheck passes. Focused tests cover saved-versus-environment values, explicit alert thresholds, missing/partial storage and timezone query parameters.

### Channel and heartbeat setup checkpoint

- Connections now guides Telegram, Slack and Discord setup with channel-specific signatures, allowed senders and endpoint instructions. A generated test marker survives navigation; failed history reads preserve it. Operators can select a recorded task and acknowledge their own observed channel receipt. That acknowledgement is explicitly local to the browser view, not an automated verification or durable audit.
- The heartbeat uses one prompt builder, bounded file reader and quiet-hour gate for both execution and `npm run heartbeat:preview`. The preview contacts no agent or channel and shows the recipient, host-timezone cron samples and a separately configured quiet timezone. Quiet hours skip new dispatches, including catch-up checked during that window, without cancelling in-flight work.
- A fresh HEARTBEAT.md contains only commented examples and triggers no model work. Missing/empty/comment-only files are inactive; read errors, invalid UTF-8, oversized files and invalid quiet settings fail explicitly. Supported env changes use the existing protected configure/restore workflow.
- Template: 122 tests pass and typecheck passes. Tests cover overnight boundaries, both repeated DST readings, a spring gap, a half-hour zone, bounded files, actual no-dispatch behavior and executable preview parity. CLI: 163 tests pass. Dashboard production build passes. Compatibility: 25 contracts / 631 assertions pass.
- Built-dashboard browser checks passed the three setup guides, marker retention, failed/retried history reads, task links, stale selection reset, mobile/dark layout and no script errors. The receipt acknowledgement was simulated; no real Telegram, Slack or Discord message was sent.

### Upgrade preview and version coordination

- `evestack upgrade` compares the installed CLI's bundled template against a project without writing files or reading environment secrets. It reports hashes, declared dependency ranges and manual merge requirements, refuses symlinks/oversized files, bounds total reads, and leaves extra project files alone. A recorded manifest is not proof of installed or running versions.
- The generated release manifest checks component versions, template dependencies, Postgres image majors and storage guards. It ships in new projects and is checked in CI. Candidate versions are CLI 0.7.0, scaffolder 0.13.0, dashboard 0.5.0, budget 0.4.0, Composio 0.3.0, MCP 0.4.0 and OpenSandbox 0.4.1; schedules stays 0.2.1 because its runtime is unchanged. No artifact is published by this checkpoint.
- CLI: 168 tests pass. Scaffolder: 246 pass, one optional runtime test skipped. Compatibility: 25 contracts / 632 assertions pass. Template sync, registry generation, lockfile resolution and manifest consistency pass.
- CI on `69b1e61` found a missing budget build before dashboard unit tests and a fleet probe that reopened its fixture while the engine could still finish it. The job now builds the dependency first; the probe waits for the real turn to settle before reopening it. These corrections await verification on the next exact commit.

### Backup, restore and removal preparation

- All CI jobs, including Windows/macOS, and the runtime image passed on `a8014a4`. This verifies the dashboard build ordering and fleet fixture corrections.
- Added a whole-database archive/restore guide covering configuration, roles/extensions, data inventory, paused activation and component compatibility. Restored databases remain disconnected from workers until pending tasks, uncertain dispatches and notification receipts are reviewed. Removed advice to delete a database volume for password rotation.
- Rehearsed `pg_dump`/`pg_restore` against disposable PostgreSQL 17.10 using 17.11 clients: all rows across 22 tables, eight sequences, indexes and constraints match; additive operator SQL preserves the restored history. A truncated archive fails and leaves no partial tables. The test imports no agent, scheduler or delivery worker.
- The native fixture lacks pgvector, so this local rehearsal uses numeric arrays for its memory values. CI runs the same test with a required vector extension and HNSW index; that result remains pending.
- Removal guidance now starts with stopping work and retaining data, distinguishes generated from attached Compose files, explains standalone dashboards and configuration backups, and requires exact resource identification before permanent removal.

### Read-only queue diagnosis

- All CI jobs and the runtime image passed on `0877285`. The restore rehearsal ran with zero skipped tests and pgvector/HNSW in CI; the local numeric-array fallback is no longer the only storage evidence.
- Task recovery and Diagnostics now offer an on-demand queue diagnosis using the CLI's existing query and finding modules. Postgres enforces a read-only repeatable snapshot, individual statements and the overall query sequence are bounded, and candidate/display truncation is explicit. Missing or changed schemas return unavailable; no agent call or repair module runs.
- The interface summarizes next actions and keeps full CLI explanations/evidence expandable. An exhausted row with a replacement is distinguished from a stranded run. Live session health is not inferred from the database snapshot, and a failed recheck preserves the prior result as stale.
- Six native PostgreSQL tests pass, including exact finding parity with the CLI, optional migration-table failure, unchanged queue rows, bounded output, unsupported schemas and enforced read-only transactions. Dashboard: 760 tests pass, five native suites run separately. Typecheck and production build pass; 25 contracts / 640 assertions pass.
- Built-browser checks pass anonymous refusal, on-demand dispatch, shared findings, stale failure/retry, recovery integration, mobile/dark layouts and no script errors. Visual inspection led to a clearer action button, concise guidance and expandable technical detail; repeated captures passed. Runtime-image checks now exercise the bundled shared modules and their authenticated route.

### Bounded environment inspection and unattended operation

- All CI jobs and the runtime image passed on `a4d92c3`, including the shared queue diagnosis route from the built image.
- Docker inspection now caps each response at 2 MiB with an absolute three-second deadline, limits inspection to 24 containers and uses six workers. Inventory/ID validation prevents malformed responses becoming API paths; all requests remain GETs. Omitted containers are counted and keep otherwise healthy network/lifetime alerts unknown.
- Resource samples reject malformed/nonfinite data. CPU requires two valid readings and a reported core count; missing metrics stay unknown. Network mode is labelled as configuration evidence, not a verified outbound policy. Long names wrap on mobile. Inspection failures replace the result with an explicit unavailable state.
- Transport, sandbox and alert checks: 57 tests pass against a local fixture socket, including sustained trickle/size limits, bounded concurrency, GET-only operation, unreadable data and omission propagation. Dashboard: 769 tests pass, five native suites separate; typecheck and production build pass. Compatibility: 25 contracts / 640 assertions pass. Website/docs build passes.
- Built-browser checks pass a 28-container fixture with 24 displayed/four omitted, long names, network/lifetime flags, unavailable/recovered inventory, desktop/mobile/dark layouts and no script errors. No real host Docker socket was mounted or inspected. Visual review found and corrected duration rollover (for example, 1h 60m → 2h 00m); 12 time-formatting tests pass.
- External monitoring guidance now distinguishes quiet transition alerts from liveness, explains status-versus-body checks and documents incident actions. It does not claim an external monitor was deployed. Replay acknowledgement no longer promises model-only cost when prior tools were unrecorded.

### Skill provenance and review changes (September 16)

- Skills expose installed source, declared version/license/metadata and ignored permission-looking frontmatter. Author declarations do not authenticate publishers or grant access.
- New reviews append per-file fingerprints without file contents. Added/changed/removed paths compare against the last review; legacy rows retain their whole-content hash and explicitly lack a per-file baseline. Schema update is additive under the existing transaction lock.
- Native PostgreSQL: four migration/history checks and the database archive/restore rehearsal pass. Local restore uses the documented numeric-array fallback; the preceding pgvector CI rehearsal passed without skips.
- Dashboard production build, 770 non-database tests and 25 compatibility contracts / 640 assertions pass. Six native database groups are excluded from that fast-test count and run separately.
- Browser checks use actual disposable file changes: stale saves reject with the draft retained; additions/edits/removals are visible; source metadata and permissions caveats remain readable on desktop/mobile/dark views. No browser script errors.
- Exact CI and dashboard-image builds passed for the preceding queue (`a4d92c3`) and execution-environment (`e4d12c1`) checkpoints. This new checkpoint awaits its own CI verification.
