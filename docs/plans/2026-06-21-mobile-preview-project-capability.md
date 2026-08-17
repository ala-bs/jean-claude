# Mobile Preview Project Capability Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Persist mobile preview project capability, detect mobile apps on project creation/manual scan, and show the task header phone button only when enabled.

**Architecture:** Store a `mobilePreviewConfig` JSON blob on projects. A main-process detector scans repo root plus shallow monorepo folders, and project settings exposes mode, scan, and selected app. Renderer gates the existing mobile preview pane entry from that config.

**Tech Stack:** Kysely migration, Electron IPC, React, TanStack Query, Zustand task pane state.

---

### Task 1: Persist Config

**Files:**
- Modify: `shared/types.ts`
- Modify: `electron/database/schema.ts`
- Create: `electron/database/migrations/070_project_mobile_preview_config.ts`
- Modify: `electron/database/migrator.ts`
- Modify: `electron/database/repositories/projects.ts`

**Steps:**
1. Add mobile preview config shared types.
2. Add nullable text column in schema/migration.
3. Parse/stringify config in project repository.

### Task 2: Detect Mobile Apps

**Files:**
- Create: `electron/services/mobile-preview-project-detector.ts`
- Create: `electron/services/mobile-preview-project-detector.test.ts`

**Steps:**
1. Scan root plus `apps/*`, `packages/*`, `mobile/*`, `clients/*`.
2. Detect Expo/RN/iOS/Android from package deps and native files.
3. Return config with detected apps, selected app when unique, timestamp.

### Task 3: Wire IPC

**Files:**
- Modify: `electron/ipc/handlers.ts`
- Modify: `electron/preload.ts`
- Modify: `src/lib/api.ts`
- Modify project creation handlers.

**Steps:**
1. Run detector during project create.
2. Add `projects.detectMobilePreview`.
3. Persist manual detection result.

### Task 4: Settings And Header

**Files:**
- Modify: `src/features/project/ui-project-settings/index.tsx`
- Modify: `src/features/task/ui-task-panel/index.tsx`

**Steps:**
1. Add Integrations/Mobile Preview settings section.
2. Add mode toggle, app selector, manual detect button.
3. Show task header/menu phone button based on config.

### Task 5: Verify

Run:
- `pnpm install`
- `pnpm test`
- `pnpm lint --fix`
- `pnpm ts-check`
- `pnpm lint`
