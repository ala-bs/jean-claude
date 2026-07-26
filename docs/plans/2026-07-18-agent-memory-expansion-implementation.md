# Agent Memory Expansion Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Replace narrow Preference Memory capture with structured Agent Memory that records user-authored interactions, extracts scoped project/global knowledge, and exposes read-only evidence, candidate, profile, project, and run views.

**Architecture:** Extend managed filesystem storage under `~/.jean-claude/memory`. Canonical JSON/JSONL stores events, structured items, state, and runs; Markdown remains generated projection. Project extraction sees raw local events, while global merge sees only validated project nominations.

**Tech Stack:** Electron, TypeScript, React 19, Kysely migrations/settings, Node `fs/promises`, Zod/JSON schema generation, Vitest, TanStack Query.

---

### Task 1: Canonical Contracts, Safe Storage, And Redaction

**Files:**
- Create: `shared/agent-memory-types.ts`
- Create: `shared/agent-memory-types.test.ts`
- Create: `electron/services/agent-memory-storage.ts`
- Create: `electron/services/agent-memory-storage.test.ts`
- Create: `electron/services/agent-memory-redaction.ts`
- Create: `electron/services/agent-memory-redaction.test.ts`
- Modify: `electron/services/preference-memory-storage.ts`

**Step 1: Write failing contract tests**

Cover event source/context unions, item categories/kinds/scopes/statuses, extraction runs, nominations, dashboard payloads, unique evidence IDs, and bounded finite confidence.

**Step 2: Run contract tests**

Run: `pnpm test -- shared/agent-memory-types.test.ts`

Expected: FAIL because new contracts/validators do not exist.

**Step 3: Implement shared contracts**

Define versioned `AgentMemoryEvent`, typed context-only payloads, `AgentMemoryItem`, `AgentMemoryNomination`, project/global proposal types, extraction state/run, dashboard page models, and validation helpers. Keep source types explicit: initial/follow-up/queued/new-step prompt, question answer, task review, PR comment, PR reply.

**Step 4: Write failing storage/redaction tests**

Cover exact global/project layout, project-key hashing, symlink rejection, atomic JSON/Markdown writes, safe JSONL append, duplicate source suppression, incomplete trailing-line handling, paging, event ranges, project/global locks, and recursive secret redaction with marker paths.

**Step 5: Run storage/redaction tests**

Run: `pnpm test -- electron/services/agent-memory-storage.test.ts electron/services/agent-memory-redaction.test.ts`

Expected: FAIL because services do not exist.

**Step 6: Implement minimal storage/redaction services**

Reuse safe path logic from `preference-memory-storage.ts`; keep old exports as compatibility facade for immutable migration 074. Use sibling temp files plus rename for canonical writes. Do not hold append locks during extraction model calls. Redact bearer tokens, credential assignments, private keys, credential URLs, and common provider token formats before disk.

**Step 7: Run focused tests**

Run: `pnpm test -- shared/agent-memory-types.test.ts electron/services/agent-memory-storage.test.ts electron/services/agent-memory-redaction.test.ts electron/services/preference-memory-storage.test.ts`

Expected: PASS.

---

### Task 2: Settings And Filesystem Migration

**Files:**
- Create: `electron/database/migrations/078_migrate_agent_memory.ts`
- Create: `electron/database/migrations/078_migrate_agent_memory.test.ts`
- Modify: `electron/database/migrator.ts`
- Modify: `shared/types.ts`
- Modify: `shared/types.test.ts`
- Modify: `electron/database/repositories/settings.ts`
- Modify: `electron/database/repositories/settings.test.ts`

**Step 1: Write failing settings tests**

Specify `AgentMemorySetting` with `enabled`, interval, backend, model, and thinking effort. Default disabled. Existing enabled Preference Memory maps to enabled Agent Memory while preserving generation configuration.

**Step 2: Run settings tests**

Run: `pnpm test -- shared/types.test.ts electron/database/repositories/settings.test.ts`

Expected: FAIL on missing Agent Memory setting.

**Step 3: Implement settings rename/mapping**

Replace runtime `preferenceMemory` settings access with `agentMemory`. Keep persisted old-key parsing only for concrete migration of shipped settings.

**Step 4: Write failing migration tests**

Cover conversion of only `task-review-comment` records, removal of snapshots/task prompt metadata, redaction, stable source IDs, discard of `pr-file-comment`, no old Markdown import, verification before activation, cleanup of all old files after success, and rollback preserving old files after any failure.

**Step 5: Run migration tests**

Run: `pnpm test -- electron/database/migrations/078_migrate_agent_memory.test.ts`

Expected: FAIL because migration is absent.

**Step 6: Implement and register migration 076**

Stage complete converted project trees, verify count/source uniqueness/digest, swap atomically, and clean old-format files only after activation. Do not modify migration 074.

**Step 7: Run focused tests**

Run: `pnpm test -- electron/database/migrations/078_migrate_agent_memory.test.ts electron/database/migrations/074_migrate_preference_memory.test.ts electron/database/repositories/settings.test.ts shared/types.test.ts`

Expected: PASS.

---

### Task 3: Capture Service, Prompt Sources, And Task Reviews

**Files:**
- Create: `electron/services/agent-memory-capture-service.ts`
- Create: `electron/services/agent-memory-capture-service.test.ts`
- Modify: `electron/database/repositories/agent-messages.ts`
- Modify: `electron/database/repositories/agent-messages.test.ts`
- Modify: `electron/services/agent-service.ts`
- Modify: `electron/services/agent-service.test.ts`
- Modify: `electron/ipc/handlers.ts`
- Modify: `electron/preload.ts`
- Modify: `src/lib/api.ts`
- Modify: `src/hooks/use-agent.ts`
- Modify: `src/features/task/ui-task-panel/index.tsx`
- Modify: `src/features/task/ui-task-panel/add-step-dialog.tsx`
- Modify: `src/routes/projects/$projectId/tasks/new.tsx`
- Modify: `src/stores/review-comments.ts`
- Modify: `src/routes/__root.tsx`

**Step 1: Write failing capture-service tests**

Cover opt-in check, pre-write redaction, deterministic source IDs, latest-20k context truncation, duplicate suppression, structured warning logs/events, and nonblocking safe capture.

**Step 2: Run capture tests**

Run: `pnpm test -- electron/services/agent-memory-capture-service.test.ts`

Expected: FAIL because service is absent.

**Step 3: Implement capture service and warning channel**

Expose nonblocking capture-warning event through preload/API and root toast. Primary operations must never reject because capture failed.

**Step 4: Write failing source tests**

Cover:

- Initial prompt after task/step creation using original user text.
- Immediate follow-up after session admission using client submission ID.
- Previous final/result context, latest 20k only.
- Queued prompt captured on dequeue, not enqueue/cancel; final edited text wins.
- New-step user prompt after step creation; generated continue/review boilerplate excluded.
- Task review captured only with submitted immediate/queued/new-step prompt.
- Stable review comment IDs and selected text/range context; no file snapshots.
- Attachments/images, prompt prefaces, retries, stops, and automation excluded.

**Step 5: Implement repository and source integration**

Add efficient latest-result lookup. Carry capture metadata through queued prompts and step creation. Remove renderer direct Preference Memory calls. Capture accepted prompt text in main process after each submission boundary.

**Step 6: Run focused tests**

Run: `pnpm test -- electron/services/agent-memory-capture-service.test.ts electron/services/agent-service.test.ts electron/database/repositories/agent-messages.test.ts src/features/task/ui-task-panel`

Expected: PASS.

---

### Task 4: Structured Ask-Question Capture

**Files:**
- Create: `src/features/agent/ui-question-options/question-response.ts`
- Create: `src/features/agent/ui-question-options/question-response.test.ts`
- Modify: `shared/agent-types.ts`
- Modify: `src/features/agent/ui-question-options/index.tsx`
- Modify: `electron/services/agent-service.ts`
- Modify: `electron/services/question-broker-service.ts`
- Modify: relevant question broker/service tests

**Step 1: Write failing response-shaping tests**

Verify each event contains question text, selected labels, custom answer, and notes only. Ensure unselected option labels/values never serialize into memory details.

**Step 2: Run focused tests**

Run: `pnpm test -- src/features/agent/ui-question-options/question-response.test.ts`

Expected: FAIL because structured helper is absent.

**Step 3: Implement structured memory details**

Extend response contract without changing backend flattened `answers`. Capture one event per answered question only after answer delivery succeeds. Use `question:<requestId>:<questionKey>` source IDs.

**Step 4: Run focused tests**

Run: `pnpm test -- src/features/agent/ui-question-options/question-response.test.ts electron/services/question-broker-service.test.ts electron/services/agent-service.test.ts src/features/agent/ui-question-options/index.test.tsx`

Expected: PASS.

---

### Task 5: Local PR Comment And Reply Capture

**Files:**
- Modify: `src/hooks/use-pull-requests.ts`
- Modify: `src/hooks/use-pull-requests.test.ts`
- Modify: `src/features/common/ui-file-diff/file-diff-content.tsx`
- Modify: `src/features/pull-request/ui-pr-diff-view/index.tsx`
- Modify: `src/features/pull-request/ui-pr-detail/index.tsx`
- Modify: `src/features/pull-request/ui-pr-comments/index.tsx`
- Modify: `electron/ipc/handlers.ts`
- Modify: `electron/services/azure-devops-service.ts`
- Modify: `electron/preload.ts`
- Modify: `src/lib/api.ts`
- Modify: `src/features/task/ui-task-pr-view/pr-creation-form.tsx`
- Modify: `src/features/task/ui-task-pr-view/pr-creation-form.test.ts`

**Step 1: Write failing PR capture tests**

Cover successful-post-only capture, returned provider thread/comment source IDs, exact selected lines for file comments, latest-20k prior thread for replies, user body without uploaded image Markdown, no remote-fetch standalone evidence, and capture failures preserving successful post result.

**Step 2: Run focused tests**

Run: `pnpm test -- src/hooks/use-pull-requests.test.ts src/features/task/ui-task-pr-view/pr-creation-form.test.ts`

Expected: FAIL on missing Agent Memory integration.

**Step 3: Implement local PR capture**

Pass local Jean-Claude project ID and selected text through comment APIs. Capture in main process only after Azure succeeds. Thread and selected code are context-only. Remove AI annotation evidence capture entirely.

**Step 4: Run focused tests**

Run: `pnpm test -- src/hooks/use-pull-requests.test.ts src/features/pull-request/ui-pr-comment-form/index.test.ts src/features/pull-request/ui-pr-inline-comment-thread/index.test.ts src/features/task/ui-task-pr-view/pr-creation-form.test.ts`

Expected: PASS.

---

### Task 6: Structured Project Extraction, Global Merge, And Markdown

**Files:**
- Create: `electron/services/agent-memory-extraction-service.ts`
- Create: `electron/services/agent-memory-extraction-service.test.ts`
- Create: `electron/services/agent-memory-extraction-eval.test.ts`
- Create: `electron/services/agent-memory-markdown.ts`
- Create: `electron/services/agent-memory-markdown.test.ts`
- Modify: `electron/services/ai-generation-service.ts` only if required for schema output

**Step 1: Write failing Markdown tests**

Cover deterministic grouped project/global projections, candidates, superseded omission from active sections, escaping, and empty states.

**Step 2: Write failing extraction validator tests**

Cover unknown evidence rejection, app-recomputed task/project counts, one-off task candidates, two-task project promotion, explicit project decision/constraint, contradiction supersession, semantic merge target validation, idempotent retry, and items-before-checkpoint ordering.

**Step 3: Write failing global merge tests**

Verify merge reads nominations only, requires two unique projects for confirmed global status, retains one-project candidates with blockers, rejects unknown nominations, and never receives raw event bodies.

**Step 4: Run focused tests**

Run: `pnpm test -- electron/services/agent-memory-markdown.test.ts electron/services/agent-memory-extraction-service.test.ts electron/services/agent-memory-extraction-eval.test.ts`

Expected: FAIL because services are absent.

**Step 5: Implement structured proposal flow**

Use schema-constrained generation without filesystem tools. Delimit events as untrusted evidence. Validate whole proposal before state changes. Write canonical items, then checkpoint, then Markdown projection; projection failure marks retry-needed without corrupting canonical state. Persist running/success/failed run records.

**Step 6: Add semantic fixtures**

Fixtures must verify known preferences, one-off rejection, project isolation, two-project promotion, contradictions, and mandatory citations. Inspect global prompt to prove raw project phrases are absent.

**Step 7: Run focused tests**

Run: `pnpm test -- electron/services/agent-memory-markdown.test.ts electron/services/agent-memory-extraction-service.test.ts electron/services/agent-memory-extraction-eval.test.ts`

Expected: PASS.

---

### Task 7: Dashboard, IPC, Settings UI, And Scheduler

**Files:**
- Create: `electron/services/agent-memory-dashboard-service.ts`
- Create: `electron/services/agent-memory-dashboard-service.test.ts`
- Create: `electron/services/agent-memory-scheduler-service.ts`
- Create: `electron/services/agent-memory-scheduler-service.test.ts`
- Create: `src/features/settings/ui-agent-memory-dashboard/index.tsx`
- Delete: `src/features/settings/ui-preference-memory-dashboard/index.tsx`
- Modify: `electron/ipc/handlers.ts`
- Modify: `electron/preload.ts`
- Modify: `src/lib/api.ts`
- Modify: `electron/main.ts`
- Modify: `src/hooks/use-settings.ts`
- Modify: `src/features/settings/ui-general-settings/index.tsx`
- Modify: `src/features/settings/ui-settings-overlay/index.tsx`

**Step 1: Write failing dashboard-service tests**

Cover grouped global/project items, candidates with blockers, paged raw events, separate context labels, run detail, disabled readable state, manual extraction, and failed-run retry without checkpoint changes.

**Step 2: Write failing scheduler tests**

Use fake timers/clock. Cover startup daily sweep, once-per-calendar-day behavior, configured interval, disabled no-op, per-project `allSettled`, one global merge after projects settle, overlap prevention, failed retry timing, and idempotent start/stop.

**Step 3: Run service tests**

Run: `pnpm test -- electron/services/agent-memory-dashboard-service.test.ts electron/services/agent-memory-scheduler-service.test.ts`

Expected: FAIL because services are absent.

**Step 4: Implement services and IPC rename**

Replace `preferenceMemory:*` runtime channels with `agentMemory:*`. Manual action runs selected project extraction then global merge. Scheduler skips projects absent from database.

**Step 5: Implement read-only five-view dashboard**

Views: Global Profile, Project Memory, Candidates, Raw Evidence, Extraction Runs. Keep established settings visual language. Disable Extract Now when master setting is off. Explain forever retention, redaction, and configured backend transmission.

**Step 6: Run focused tests**

Run: `pnpm test -- electron/services/agent-memory-dashboard-service.test.ts electron/services/agent-memory-scheduler-service.test.ts src/features/settings`

Expected: PASS.

---

### Task 8: Legacy Runtime Cleanup And Full Verification

**Files:**
- Delete: `shared/preference-memory-types.ts`
- Delete: `electron/services/preference-memory-service.ts`
- Delete: `electron/services/preference-memory-service.test.ts`
- Modify: `electron/services/builtin-skills-service.ts`
- Modify: `electron/services/builtin-skills-service.test.ts`
- Modify: `electron/services/project-deletion-service.ts`
- Modify: `electron/services/project-deletion-service.test.ts`
- Modify: all remaining runtime Preference Memory references

**Step 1: Write failing cleanup/retention tests**

Verify project deletion keeps Agent Memory, scheduler ignores missing DB projects, managed `user-preference-memory` skill is removed, and no runtime old channels/types/files remain except migration 074 compatibility symbols.

**Step 2: Remove legacy runtime**

Remove old service/types/dashboard/API/channels and AI-writable memory skill. Keep migration 074 unchanged and storage facade only where it imports it. Do not edit changelogs.

**Step 3: Run focused regression tests**

Run: `pnpm test -- electron/services/project-deletion-service.test.ts electron/services/builtin-skills-service.test.ts electron/database/migrations/074_migrate_preference_memory.test.ts electron/database/migrations/078_migrate_agent_memory.test.ts`

Expected: PASS.

**Step 4: Run required repository verification**

Run in order:

```bash
pnpm install
pnpm test
pnpm lint --fix
pnpm ts-check
pnpm lint
```

Expected: all commands succeed. Report existing warnings separately.

**Step 5: Inspect final diff**

Run: `git status --short && git diff --stat && git diff --check`

Confirm only Agent Memory implementation, tests, and plan docs changed. Confirm no changelog edits.
