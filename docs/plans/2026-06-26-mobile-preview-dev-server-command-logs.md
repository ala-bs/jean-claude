# Mobile Preview Dev Server Command Logs Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the custom Metro log path with Jean-Claude's existing run-command log system for mobile dev servers.

**Architecture:** Add an ad-hoc command entrypoint to `run-command-service` that accepts a command payload instead of loading a saved `ProjectCommand`. The mobile pane starts/stops a stable ad-hoc command id for the selected app and renders `InteractiveLog` from the existing task message store.

**Tech Stack:** Electron IPC, node-pty run command service, React, Zustand command log store, Vitest.

---

### Task 1: Add Ad-Hoc Run Command API

**Files:**
- Modify: `shared/run-command-types.ts`
- Modify: `electron/services/run-command-service.ts`
- Modify: `electron/ipc/handlers.ts`
- Modify: `electron/preload.ts`
- Modify: `src/lib/api.ts`

**Steps:**
1. Add `StartAdHocRunCommandParams` with `taskId`, `projectId`, `workingDir`, `runCommandId`, `name`, `command`, `ports`, `envVars`.
2. Add `runCommandService.startAdHocCommand(params)`.
3. Reuse existing `ProjectCommand` shape internally, with `createdAt`/`sortOrder` placeholders.
4. Wire IPC/preload/renderer API.
5. Verify ad-hoc command status/logs still key by `taskId` + `runCommandId`.

### Task 2: Refactor Mobile Dev Server UI

**Files:**
- Modify: `src/features/task/ui-task-panel/mobile-preview-pane/index.tsx`
- Modify: `src/hooks/use-mobile-preview.ts`
- Modify: `src/lib/api.ts`
- Modify: `electron/ipc/handlers.ts`
- Modify: `electron/preload.ts`
- Delete: `electron/services/mobile-preview-metro-service.ts`
- Delete: `electron/services/mobile-preview-metro-service.test.ts`

**Steps:**
1. Remove `useMobilePreviewMetro`.
2. Build stable dev server command id from app path.
3. Start ad-hoc command with configured dev server command and port.
4. Stop via `api.runCommands.stopCommand`.
5. Render `InteractiveLog` using `useTaskMessagesStore`.
6. Rename UI from `Metro` to `Dev server`.

### Task 3: Verify

**Commands:**
- `pnpm install`
- `pnpm test`
- `pnpm lint --fix`
- `pnpm ts-check`
- `pnpm lint`
