# Task Rail Uncommitted Indicator Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Follow this plan task-by-task.

**Goal:** Show a clickable “Uncommitted” indicator on an associated PR rail when its task worktree contains uncommitted changes.

**Architecture:** Enrich task feed items in Electron with one lightweight Git status check for PR-linked worktrees. Render the status in the existing PR rail and route clicks to the task’s changes view.

**Tech Stack:** TypeScript, Electron, React, Vitest, Zustand, Lucide.

---

### Task 1: Feed status

**Files:**
- Modify: `shared/feed-types.ts`
- Modify: `electron/services/worktree-service.ts`
- Modify: `electron/services/feed-service.ts`
- Test: `electron/services/feed-service.test.ts`

1. Add failing tests for PR-linked worktrees with and without changes.
2. Add lightweight uncommitted-change helper.
3. Enrich parent task feed items in bounded parallel chunks.
4. Run focused service tests.

### Task 2: PR rail indicator

**Files:**
- Modify: `src/features/feed/ui-feed-list/feed-item-card.tsx`

1. Render compact dot/icon plus “Uncommitted” on affected PR rails.
2. Stop PR-row click propagation; navigate to task and open changes view.
3. Verify TypeScript and lint.

### Task 3: Repository verification

1. Run `pnpm install`.
2. Run `pnpm test`.
3. Run `pnpm lint --fix`.
4. Run `pnpm ts-check`.
5. Run `pnpm lint`.
