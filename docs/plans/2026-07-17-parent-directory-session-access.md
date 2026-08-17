# Parent Directory Session Access Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let users grant recursive session access to a parent of an externally requested directory.

**Architecture:** Provider adapters normalize trusted directory metadata into root-excluding ancestor choices. Permission response carries selected ancestor; `AgentService` validates choice, persists an `external_directory` task-session rule, then resumes provider with updated in-memory permission state.

**Tech Stack:** Electron, TypeScript, React, Claude Agent SDK, OpenCode SDK, Vitest

---

### Task 1: Shared contract and path validation

**Files:**
- Modify: `shared/normalized-message-v2.ts`
- Modify: `shared/agent-types.ts`
- Modify: `shared/agent-backend-types.ts`
- Create: `electron/services/directory-access.ts`
- Test: `electron/services/directory-access.test.ts`

1. Add normalized directory request metadata and selected-directory response field.
2. Test absolute path normalization, parent-only choices, root exclusion, home marking, and invalid selections.
3. Implement minimal ancestor builder and selection validator.
4. Run focused tests.

### Task 2: Provider adapters and persistence

**Files:**
- Modify: `electron/services/agent-backends/claude/claude-code-backend.ts`
- Modify: `electron/services/agent-backends/opencode/normalize-opencode-message-v2.ts`
- Modify: `electron/services/agent-backends/opencode/opencode-backend.ts`
- Modify: `electron/services/agent-service.ts`
- Modify: `electron/services/permission-settings-service.ts`
- Test: provider and service test files beside implementations

1. Preserve Claude `blockedPath` and `addDirectories` suggestions.
2. Preserve OpenCode `parentDir`, `patterns`, and `always` metadata.
3. Validate and persist selected ancestor as `external_directory: { "<dir>/**": "allow" }` before provider response.
4. Update Claude SDK permissions/additional directories and OpenCode runtime rules.
5. Await OpenCode replies so failed replies remain retryable.
6. Run focused tests.

### Task 3: Task Detail permission UI

**Files:**
- Modify: `src/features/agent/ui-permission-bar/index.tsx`

1. Add specialized external-directory request display.
2. Add accessible ancestor dropdown using existing UI primitives.
3. Require confirmation when selected ancestor is home directory.
4. Keep one-shot Allow; omit project/worktree/global directory grants.
5. Run TypeScript and lint checks.

### Task 4: Full verification

1. Run `pnpm install`.
2. Run `pnpm test`.
3. Run `pnpm lint --fix`.
4. Run `pnpm ts-check`.
5. Run `pnpm lint`.
6. Review diff for permission widening, path traversal, provider failure handling, and unrelated changes.
