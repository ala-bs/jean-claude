# Global Preference Memory Storage Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Relocate per-project preference memory from each repository into `~/.jean-claude/memory/projects/<project-id>/` without changing memory behavior.

**Architecture:** Add one storage helper as source of truth for global paths, project metadata, and cleanup. Add Kysely filesystem migration following migration 062: copy legacy memory through staging, activate with rename, then remove source. Preference capture and consolidation use global project folders; shared global memory remains future work.

**Tech Stack:** Electron, Node.js `fs/promises`, Kysely migrations, TypeScript, Vitest, React.

---

### Task 1: Global memory storage helper

**Files:**
- Create: `electron/services/preference-memory-storage.ts`
- Create: `electron/services/preference-memory-storage.test.ts`

1. Write tests for root path, project-ID folder, metadata creation, successful cleanup, and ignored cleanup failure behavior at caller.
2. Run focused test; verify failure before implementation.
3. Implement global path helpers, `project.json` creation, and recursive project-memory cleanup.
4. Run focused test; verify pass.

### Task 2: Legacy filesystem migration

**Files:**
- Create: `electron/database/migrations/074_migrate_preference_memory.ts`
- Create: `electron/database/migrations/074_migrate_preference_memory.test.ts`
- Modify: `electron/database/migrator.ts`

1. Write migration tests: legacy source moves to project-ID destination, metadata is written, existing destination leaves source untouched, missing source is ignored.
2. Run focused test; verify failure before implementation.
3. Implement `up()` using destination-side staging, recursive copy, atomic rename, and source removal only after activation. Implement no-op `down()`.
4. Register migration 074 after migration 073.
5. Run focused migration tests; verify pass.

### Task 3: Preference-memory service path switch

**Files:**
- Modify: `electron/services/preference-memory-service.ts`
- Modify: `electron/services/preference-memory-service.test.ts`
- Modify: `electron/services/builtin-skills-service.ts`

1. Update tests to expect `~/.jean-claude/memory/projects/<project-id>/...` paths.
2. Replace project-relative path construction with storage helper paths keyed by project ID.
3. Ensure metadata exists before first evidence write.
4. Run consolidation with project memory directory as `cwd`; allow read/write/edit only within that directory.
5. Update built-in skill instructions to accept explicit global project-memory paths.
6. Run focused tests; verify pass.

### Task 4: Project deletion and settings copy

**Files:**
- Modify: `electron/ipc/handlers.ts`
- Modify: `src/features/settings/ui-general-settings/index.tsx`
- Test: relevant IPC/service tests found during implementation

1. Attempt global project-memory cleanup during project deletion.
2. Log cleanup failure and continue project deletion.
3. Replace project-local path descriptions with global project-folder descriptions.
4. Run affected tests.

### Task 5: Full verification

1. Run `pnpm install`.
2. Run `pnpm test`.
3. Run `pnpm lint --fix`.
4. Run `pnpm ts-check`.
5. Run `pnpm lint`.
6. Inspect `git diff` and confirm no changelog or unrelated files changed.
