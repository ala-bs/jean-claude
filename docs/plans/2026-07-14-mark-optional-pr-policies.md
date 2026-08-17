# Mark Optional PR Policies Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let users toggle Azure-optional PR policies in current PR auto-complete ignore list from each check row.

**Architecture:** Reuse existing `useSetAutoComplete` mutation and Azure `autoCompleteIgnoreConfigIds`. Replace one-way build-only action with direct row buttons for every optional policy while auto-complete is active. Share PR-specific mutation state so enable, cancel, and policy updates cannot race.

**Tech Stack:** React 19, TypeScript, TanStack Query, Vitest.

---

### Task 1: Cover optional-policy row behavior

**Files:**
- Test: `src/features/pull-request/ui-pr-checks/index.test.ts`

1. Add tests proving every optional policy gets a direct action when auto-complete is active.
2. Verify button says `Make optional` when policy is not ignored and `Make required` when ignored.
3. Verify inactive or read-only rows show only the static `Optional` badge.
4. Run focused test; expect initial failure.

### Task 2: Add row action and toggle mutation

**Files:**
- Modify: `src/features/pull-request/ui-pr-checks/index.tsx`
- Modify: `src/features/pull-request/ui-pr-overview/index.tsx`

1. Replace one-way callback with setter receiving policy config ID and desired ignored state.
2. Preserve existing auto-complete options while adding or removing config ID.
3. Replace `Optional` badge with direct `Make optional` / `Make required` button while active and writable.
4. Keep `Queue all` unchanged and show `Ignored` only while controls are active.
5. Run focused test; expect pass.

### Task 3: Coordinate auto-complete mutations

**Files:**
- Modify: `src/hooks/use-pull-requests.ts`
- Modify: `src/features/pull-request/ui-pr-auto-complete/index.tsx`
- Test: `src/hooks/use-pull-requests.test.ts`

1. Give auto-complete mutations a shared PR-specific mutation key.
2. Expose aggregate pending state from `useIsMutating`.
3. Disable enable, cancel, and policy controls while any matching mutation runs.
4. Test that sibling hook instances observe the same pending state.

### Task 4: Verify repository

**Files:**
- No planned edits

1. Run `pnpm install`.
2. Run `pnpm test`.
3. Run `pnpm lint --fix`.
4. Run `pnpm ts-check`.
5. Run `pnpm lint`.
