# iOS App Install Check Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Verify selected iOS app is installed, auto-run prebuild/build when needed, and support relaunch from mobile preview.

**Architecture:** Add iOS prebuild config beside Android config. Resolve bundle ID from Expo/native project files in main process, query and control selected simulator through `simctl`, expose typed IPC methods, then mirror Android setup state in renderer.

**Tech Stack:** TypeScript, Electron IPC, React, Vitest, Xcode `simctl`.

---

### Task 1: iOS prebuild configuration

**Files:**
- Modify: `shared/types.ts`
- Modify: `electron/services/mobile-preview-project-detector.ts`
- Modify: `electron/services/mobile-preview-project-detector.test.ts`
- Modify: `src/features/project/ui-project-settings/index.tsx`

1. Add failing detector tests for iOS-specific and generic Expo prebuild scripts.
2. Run focused detector tests and confirm failure.
3. Add `detectedIosPrebuildCommand` and `iosPrebuildCommand` config fields, defaults, detection, and settings input.
4. Run focused detector tests and confirm pass.

### Task 2: iOS app status and relaunch service

**Files:**
- Modify: `shared/mobile-simulator-types.ts`
- Modify: `electron/services/mobile-preview-ios-idb-adapter.ts`
- Modify: `electron/services/mobile-preview-ios-idb-adapter.test.ts`

1. Add failing tests for Expo/native bundle-ID resolution, `simctl get_app_container` status, and terminate/launch restart.
2. Run focused adapter tests and confirm failure.
3. Implement project-path validation, bundle-ID resolution, install status, and restart methods.
4. Run focused adapter tests and confirm pass.

### Task 3: Typed IPC bridge

**Files:**
- Modify: `src/lib/api.ts`
- Modify: `electron/preload.ts`
- Modify: `electron/ipc/handlers.ts`

1. Add typed `getIosAppStatus` and `restartIosApp` contracts and browser fallbacks.
2. Add preload methods and IPC handlers using validated task worktree path.
3. Run TypeScript check for contract errors.

### Task 4: Preview setup integration

**Files:**
- Modify: `src/features/task/ui-task-panel/mobile-preview-pane/index.tsx`
- Modify: `src/features/task/ui-task-panel/mobile-preview-pane/utils-setup-operation.ts`
- Modify: `src/features/task/ui-task-panel/mobile-preview-pane/utils-setup-operation.test.ts`

1. Add failing utility tests for platform-specific deferred prebuild behavior if extraction is needed.
2. Track iOS project existence and app status, refreshing after prebuild/build changes.
3. Use platform-specific prebuild IDs/commands and add iOS generated-project/install setup steps.
4. Auto-run iOS prebuild when Expo lacks `ios/`, then auto-run build when app is missing or identity unresolved.
5. Add restart action using new IPC method.
6. Run focused setup tests.

### Task 5: Full verification

1. Run `pnpm install`.
2. Run `pnpm test`.
3. Run `pnpm lint --fix`.
4. Run `pnpm ts-check`.
5. Run `pnpm lint`.
