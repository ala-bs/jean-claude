# Azure Work Item Title Parser Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add per-project regex title parsing and extracted-label display to Azure Board overlay.

**Architecture:** Store validated, versioned parser config as nullable project JSON. Parse raw Azure titles through a pure shared utility, then render results through one overlay-focused presenter while preserving raw search and edit behavior.

**Tech Stack:** TypeScript, React 19, Kysely/SQLite, Vitest, Tailwind CSS

---

### Task 1: Shared Configuration Contract

**Files:**
- Modify: `shared/types.ts`
- Test: `src/lib/work-item-title-parser.test.ts`

1. Add `WorkItemTitleParserSetting`, rule type, limits, starter setting, and runtime validator.
2. Add nullable setting to `Project`, `NewProject`, and `UpdateProject`.
3. Test malformed versions, rule bounds, missing named capture, invalid regex, and valid starter config.
4. Run `pnpm vitest run src/lib/work-item-title-parser.test.ts` and confirm contract tests pass.

### Task 2: Persistence

**Files:**
- Create: `electron/database/migrations/075_project_work_item_title_parser.ts`
- Modify: `electron/database/migrator.ts`
- Modify: `electron/database/schema.ts`
- Modify: `electron/database/repositories/projects.ts`

1. Add nullable `workItemTitleParser` text column with reversible migration.
2. Register migration after `074_migrate_preference_memory`.
3. Parse valid JSON on reads; malformed/invalid data falls back to null.
4. Serialize valid setting on create/update and reject invalid writes.
5. Run focused repository tests if available, then `pnpm ts-check`.

### Task 3: Pure Parser

**Files:**
- Create: `src/lib/work-item-title-parser.ts`
- Test: `src/lib/work-item-title-parser.test.ts`

1. Write failing tests for ordered global extraction, case-insensitive matching, label trimming/deduplication, no match, empty result, disabled rules, zero-length matches, title bounds, and match limits.
2. Implement `parseWorkItemTitle({ title, setting })` returning `{ displayTitle, labels, matched }`.
3. Abort to raw output on runtime anomaly; never return partial hidden content.
4. Run `pnpm vitest run src/lib/work-item-title-parser.test.ts`.

### Task 4: Project Settings Editor

**Files:**
- Create: `src/features/project/ui-work-item-title-parser-settings/index.tsx`
- Modify: `src/features/project/ui-project-settings/index.tsx`
- Modify: `src/features/project/ui-work-items-link/index.tsx`
- Modify: `src/features/project/ui-project-settings/utils-project-settings-save-data.test.ts`

1. Add parser setting to project settings draft, dirty tracking, initialization, and autosave payload.
2. Render editor under linked Azure Work Items card.
3. Add enable, add/remove, reorder, per-rule enable, pattern, and ignore-case controls.
4. Validate drafts before calling `onChange`; keep invalid text local and show inline errors.
5. Add sample raw title input and live parsed preview.
6. Test save-data projection for parser setting.

### Task 5: Parsed Title Presenter

**Files:**
- Create: `src/features/work-item/ui-parsed-work-item-title/index.tsx`
- Modify: `src/features/work-item/ui-work-item-board/index.tsx`
- Modify: `src/features/work-item/ui-work-item-preview/index.tsx`
- Modify: `src/features/work-item/ui-azure-board-overlay/project-content.tsx`

1. Build presenter accepting raw title, parser setting, title class, compact mode, and optional search highlighting.
2. Render clean title and separate extracted-label row.
3. Compact mode shows five labels plus focusable `+N` tooltip; preview mode shows all.
4. Pass project setting from overlay root to board, preview, related rows, and related bugs panel.
5. Keep `EditableMetadataValue` bound to raw `fields.title`.

### Task 6: Verification

**Files:**
- Modify only files changed by formatter/linter when required.

1. Run `pnpm install`.
2. Run `pnpm test`.
3. Run `pnpm lint --fix`.
4. Run `pnpm ts-check`.
5. Run `pnpm lint`.
6. Inspect final diff for unrelated changes and verify no changelog files changed.
