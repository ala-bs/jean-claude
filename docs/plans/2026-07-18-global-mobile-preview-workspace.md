# Global Mobile Preview Workspace Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Add root-level mobile preview workspace that switches retained task-owned Expo/Metro runtimes and launches each on exact selected device.

**Architecture:** Keep Metro commands and worktree validation task-scoped. Add effective-port metadata to run-command status, Expo URL discovery/exact-device launch in main process, retained/replayable preview sessions, and root renderer workspace selecting runtime by task plus app path.

**Tech Stack:** Electron IPC, Node PTY, React 19, Zustand, TanStack Query/Router, TypeScript, Vitest, Tailwind CSS.

---

### Task 1: Mobile Runtime Command Metadata and Available Ports

**Files:**
- Modify: `shared/run-command-types.ts`
- Modify: `electron/services/run-command-service.ts`
- Modify: `electron/services/run-command-service.test.ts`
- Modify: `src/hooks/use-run-commands.ts`
- Create: `src/lib/mobile-preview-runtime.ts`
- Create: `src/lib/mobile-preview-runtime.test.ts`

**Steps:**
1. Add failing service tests proving ad-hoc `use-available-port` startup keeps configured port when free, selects next free port on conflict, launches with `--port {PORT}`, and reports effective `ports` in `CommandRunStatus`.
2. Add failing helper tests for mobile dev-server command ID creation/parsing and runtime key creation/parsing.
3. Run focused tests and confirm failures.
4. Extend ad-hoc start params with optional available-port override config; store effective ports on tracked process and status.
5. Reuse existing run-command free-port selection and command-argument substitution rather than duplicate port probing.
6. Move mobile command ID helpers from pane into shared renderer utility.
7. Update `useRunCommands.startAdHocCommand` typing and mobile starts to request available-port behavior.
8. Run focused tests and confirm pass.

### Task 2: Expo Exact-Device Runtime Launcher

**Files:**
- Modify: `shared/mobile-simulator-types.ts`
- Create: `electron/services/mobile-preview-expo-launch-service.ts`
- Create: `electron/services/mobile-preview-expo-launch-service.test.ts`
- Modify: `electron/ipc/handlers.ts`
- Modify: `electron/preload.ts`
- Modify: `src/lib/api.ts`

**Steps:**
1. Add failing tests for `GET /_expo/open`, `runtime=default`, current response validation, legacy `/_expo/link` redirect fallback, timeout/non-Expo errors, and device-open delegation.
2. Run focused test and confirm failure.
3. Define launch params/result containing task/project/app scope, platform, device ID, and actual Metro port.
4. Implement service that validates task/project/worktree scope through repositories/path resolver, fetches only loopback Metro endpoint, validates returned launch URL protocol, and delegates to existing exact-device `openDeeplink` adapter.
5. Add IPC, preload, and renderer API bindings.
6. Run focused test and TypeScript check for touched contracts.

### Task 3: Retained and Reattachable Preview Sessions

**Files:**
- Modify: `electron/services/mobile-preview-service.ts`
- Modify: `electron/services/mobile-preview-service.test.ts`
- Modify: `shared/mobile-simulator-types.ts`
- Modify: `electron/ipc/handlers.ts`
- Modify: `electron/preload.ts`
- Modify: `src/lib/api.ts`
- Modify: `src/hooks/use-mobile-preview.ts`
- Modify: `src/hooks/use-mobile-preview.test.ts`

**Steps:**
1. Add failing main-service tests for listing active sessions and attaching sender with replay of session plus bounded latest JPEG or H264 configuration/keyframe bootstrap.
2. Add failing hook tests proving global mode does not stop sessions on unmount/task switch and reattaches matching task/device session on mount.
3. Run focused tests and confirm failures.
4. Store bounded replay payload per active session and support sender attachment/listing.
5. Add typed IPC/preload/API methods for list and attach.
6. Add hook lifecycle option used by global workspace; preserve current task-local default until task host removal is complete.
7. Ensure explicit stop, task completion/deletion, and app shutdown still release sessions.
8. Run focused tests and confirm pass.

### Task 4: Global Workspace State and Runtime Index

**Files:**
- Create: `src/stores/mobile-preview-workspace.ts`
- Create: `src/stores/mobile-preview-workspace.test.ts`
- Create: `src/features/mobile-preview/utils-mobile-preview-runtimes.ts`
- Create: `src/features/mobile-preview/utils-mobile-preview-runtimes.test.ts`

**Steps:**
1. Add failing store tests for open/preselect, toggle/close, persisted last runtime, and invalid-selection fallback inputs.
2. Add failing runtime-index tests for running Metro filtering, disabled-but-running visibility, current eligible task insertion, multiple app paths, actual ports, and stable ordering.
3. Run focused tests and confirm failures.
4. Implement small persisted Zustand store with scalar selectors and runtime key.
5. Implement pure runtime-index helper from tasks, projects, command statuses, current task, and project mobile config.
6. Run focused tests and confirm pass.

### Task 5: Root Mobile Workspace UI

**Files:**
- Create: `src/features/mobile-preview/ui-mobile-preview-workspace/index.tsx`
- Create: `src/features/mobile-preview/ui-mobile-preview-workspace/runtime-rail.tsx`
- Modify: `src/routes/__root.tsx`
- Modify: `src/layout/ui-header/index.tsx`
- Modify: `src/features/task/ui-task-panel/index.tsx`
- Modify: `src/features/task/ui-task-panel/mobile-preview-pane/index.tsx`
- Modify: `src/stores/navigation.ts`

**Steps:**
1. Add component-level tests where existing test harness supports root/header/task actions; otherwise cover behavior through pure runtime/store tests from Task 4.
2. Build restrained industrial runtime rail matching existing dark glass/ink design, with task-first rows, app path, actual port, project/branch context, running state, and compact empty state.
3. Host workspace below header and replace sidebar/outlet only while open; preserve route state underneath.
4. Add header phone button and Metro-only running badge; register Escape close command.
5. Change task phone button/menu action to open global workspace preselected to task/app.
6. Remove task-local mobile content branch and obsolete persisted active-view behavior while safely migrating old `mobile` state to normal task content.
7. Add pane props for app-path override, actual Metro port, global retained-session mode, and launch-request feedback.
8. Change device preference key to task plus app path.
9. On runtime selection, restore device/platform, attach/start preview, discover Expo URL, launch exact device, and show retryable inline errors; do not mutate project app config.
10. Keep stopped current task context available without auto-starting Metro; explain vanilla React Native launch limit.
11. Run renderer-focused tests and TypeScript check.

### Task 6: Integration and Regression Verification

**Files:**
- Modify only files required by formatter, lint, or discovered test regressions.

**Steps:**
1. Run `pnpm install`.
2. Run `pnpm test`.
3. Fix failures with smallest scoped changes and rerun affected tests.
4. Run `pnpm lint --fix`.
5. Review formatter/lint edits; preserve unrelated worktree changes.
6. Run `pnpm ts-check`.
7. Fix TypeScript failures and rerun check.
8. Run `pnpm lint`.
9. Inspect `git status --short` and `git diff --check`.
10. Review final diff against validated design; do not create commit unless user requests one.
