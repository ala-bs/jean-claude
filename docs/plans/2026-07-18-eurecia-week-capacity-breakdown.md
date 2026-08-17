# Eurecia Week Capacity Breakdown Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Show count-only row and day-capacity totals for every date in selected Eurecia sheet.

**Architecture:** Extend existing dialog utility module with shared default allocation policy and pure bounded daily breakdown. Feed current editable entries during normal editing and draft fallback only when row capacity blocked initialization. Render compact inline table within existing editor stage.

**Tech Stack:** TypeScript, React 19, Tailwind CSS, Vitest

---

### Task 1: Capacity Utility Tests

**Files:**
- Modify: `src/features/work-activity/ui-eurecia-sync-dialog/utils.test.ts`

1. Add tests for edited entries and blocked draft fallback.
2. Add tests for occupied-only remote counts, empty dates, inclusive multi-day ranges, strict date bounds, and bounded range size.
3. Add tests proving row and fraction overflow flags are independent.
4. Run focused test and confirm failure before implementation.

### Task 2: Capacity Utility

**Files:**
- Modify: `src/features/work-activity/ui-eurecia-sync-dialog/utils.ts`

1. Export shared default fraction helper and use it in initialization.
2. Implement pure daily breakdown using UTC ISO dates and finite range guard.
3. Count remote rows only when explicitly or structurally occupied.
4. Run focused tests until passing.

### Task 3: Editor Breakdown Table

**Files:**
- Modify: `src/features/work-activity/ui-eurecia-sync-dialog/index.tsx`

1. Derive breakdown from selected sheet, remote rows, editable entries, and blocked fallback drafts.
2. Render accessible compact table after row-capacity validation and before aggregate preservation warning.
3. Add horizontal mobile scrolling, minimum table width, count/fraction cell labels, and independent row/day overflow accents.
4. Update blocked copy to point to breakdown and explain zero editable entries.

### Task 4: Verification

1. Run `pnpm install`.
2. Run `pnpm test`.
3. Run `pnpm lint --fix`.
4. Run `pnpm ts-check`.
5. Run `pnpm lint`.
6. Review accessibility, redaction, responsive layout, and diff scope. No commit.
