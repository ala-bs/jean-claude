# Eurecia Daily Row Aggregation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Represent Work Activity context as one proposed Eurecia row per day while preserving multiple project/work-item entries inside that row.

**Architecture:** Add typed nested daily items to timesheet drafts. Eurecia adapter groups events by UTC date, stores each existing project/work-item group as a child item, and emits one parent draft per day. Existing editor/capacity flow continues to count parent drafts as Eurecia rows.

**Tech Stack:** TypeScript, React, Vitest

---

### Task 1: Add nested draft type

**Files:** `shared/timesheet-types.ts`

Add reusable child type containing project, work item, description, event IDs, and metadata. Add `items` to `TimesheetEntryDraft`.

### Task 2: Add failing adapter coverage

**Files:** `electron/services/timesheet-adapters/eurecia-timesheet-adapter.test.ts`

Extend multi-group fixture across same date. Assert one output per date, all child groups retained, source IDs retained, and deterministic ordering.

### Task 3: Aggregate adapter output by date

**Files:** `electron/services/timesheet-adapters/eurecia-timesheet-adapter.ts`

Keep current event grouping as child-item grouping. Build one parent draft per UTC date, combine child descriptions, flatten source IDs, and expose child items through `items`.

### Task 4: Display nested context

**Files:** `src/features/work-activity/ui-eurecia-sync-dialog/index.tsx`

Render child project/work-item context within daily entry card without changing editable row count or Eurecia payload shape.

### Task 5: Verify

Run `pnpm install`, `pnpm test`, `pnpm lint --fix`, `pnpm ts-check`, and `pnpm lint`.
