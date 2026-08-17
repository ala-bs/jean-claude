# Archive Task Step Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add reversible-in-database task-step archiving from the Task Step Management flow bar, while preserving archived step data and showing archived steps muted.

**Architecture:** Store `archivedAt` on `task_steps`. Add a dedicated archive IPC operation so dependency validation and running-session stopping stay in the main process. Return archived steps through existing cache flows; style them muted in the flow bar and expose Archive through its context menu.

**Tech Stack:** Electron IPC, Kysely/SQLite migration, React, TanStack Query cache, existing context-menu hook.

---

### Task 1: Add archive persistence

**Files:**
- Create: `electron/database/migrations/077_task_step_archived_at.ts`
- Modify: `electron/database/migrator.ts`
- Modify: `electron/database/schema.ts`
- Modify: `shared/types.ts`
- Modify: `electron/database/repositories/task-steps.ts`
- Test: `electron/database/repositories/task-steps.test.ts`

1. Add nullable `archivedAt` migration and register it.
2. Add `archivedAt` to database/shared step types.
3. Map it in `toStep`, accept it in repository update/create paths.
4. Add repository test proving timestamp round-trips.

### Task 2: Add archive service and IPC

**Files:**
- Modify: `electron/services/step-service.ts`
- Modify: `electron/ipc/handlers.ts`
- Modify: `src/lib/api.ts`
- Modify: `src/hooks/use-steps.ts`
- Test: `electron/services/step-service.test.ts`

1. Add `archive(stepId)` service method.
2. Reject archive when another step depends on target; use actionable error.
3. Stop running sessions through the existing agent-service stop path before persisting archive.
4. Persist ISO timestamp, emit upsert, re-evaluate/sync task status.
5. Add `steps:archive` IPC/preload/API typing and cache mutation hook.
6. Test dependency rejection and successful archive behavior.

### Task 3: Add flow-bar context menu and muted rendering

**Files:**
- Modify: `src/features/task/ui-step-flow-bar/index.tsx`
- Modify: `src/features/task/ui-step-flow-bar/index.test.ts`

1. Add step-chip context-menu action labeled `Archive step`.
2. Invoke archive mutation and show existing error surface on rejection.
3. Render archived chips muted while preserving selection, graph position, and data.
4. Add component/style tests for archive action and archived presentation.

### Task 4: Verify

Run:

```bash
pnpm install
pnpm test
pnpm lint --fix
pnpm ts-check
pnpm lint
```

Fix failures, then review changed files for unintended behavior.
