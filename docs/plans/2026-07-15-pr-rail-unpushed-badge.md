# PR Rail Unpushed Badge Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Follow this plan task-by-task.

**Goal:** Show a static “Unpushed” badge in PR sidebar rows linked to task worktrees with commits ahead of upstream.

**Architecture:** Enrich existing task feed items with a lightweight Git ahead check. Match task items to PR rows by project and PR ID, then pass optional display state into shared PR row component.

**Tech Stack:** TypeScript, Electron, React, Vitest, Lucide.

---

### Task 1: Feed status

**Files:**
- Modify: `shared/feed-types.ts`
- Modify: `electron/services/worktree-service.ts`
- Modify: `electron/services/feed-service.ts`
- Test: `electron/services/worktree-service.test.ts`
- Test: `electron/services/feed-service.test.ts`

1. Add true unpushed-commit detection tests.
2. Add lightweight ahead-of-upstream helper.
3. Enrich PR-linked task feed items in bounded chunks.
4. Run focused service tests.

### Task 2: PR sidebar badge

**Files:**
- Modify: `src/hooks/use-feed.ts`
- Modify: `src/features/pull-request/ui-pr-sidebar-list/index.tsx`
- Modify: `src/features/pull-request/ui-pr-list-item/index.tsx`
- Test: `src/features/pull-request/ui-pr-sidebar-list/index.test.ts`

1. Expose shared task-feed resource hook.
2. Build project-and-PR keyed unpushed lookup.
3. Pass optional state to sidebar PR rows.
4. Render compact static “Unpushed” badge.
5. Run focused tests.

### Task 3: Repository verification

1. Run `pnpm install`.
2. Run `pnpm test`.
3. Run `pnpm lint --fix`.
4. Run `pnpm ts-check`.
5. Run `pnpm lint`.
