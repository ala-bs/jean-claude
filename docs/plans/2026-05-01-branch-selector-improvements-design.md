# Branch Selector Improvements

## Problem

Branch selectors across the app are basic `<Select>` dropdowns with no search, no sorting, and no way to surface frequently-used branches. In repos with many branches, finding the right one is slow and tedious.

## Goals

- Searchable combobox with type-to-filter
- Sections: **Favorites** (pinned per-project) and **All Branches**
- Sort branches by last git commit date (most recent first)
- Single shared component used across all 4 branch selector locations
- Favorite branches managed in project settings

## Design

### Shared Component: `<BranchSelect>`

**Location:** `src/common/ui/branch-select/index.tsx`

A combobox-style component with a text input and dropdown list, grouped into sections.

**Props:**

```ts
{
  projectId: string
  value: string | undefined
  onChange: (branch: string) => void
  label?: string
  disabled?: boolean
  placeholder?: string
}
```

**Behavior:**

- Opens dropdown on focus/click
- Text input filters branches with fuzzy matching across all sections
- Two sections in order:
  1. **Favorites** — branches pinned by the user in project settings. Only shown if the project has favorites configured. Sorted by last commit date.
  2. **All Branches** — every branch, sorted by last commit date (most recent first). Default branch marked with a "(default)" badge.
- Section headers are non-interactive visual dividers
- Empty sections are hidden (especially Favorites when none configured)
- When filtering, sections with no matches are hidden
- Keyboard navigation: arrow keys, enter to select, escape to close

**Data fetching:** Uses the existing `useProjectBranches` hook (updated to return `BranchInfo[]`) and reads favorites from the project data already available via `useProject`.

### Backend: Enhanced Branch Listing

**Current:** `api.projects.getBranches(projectId)` returns `string[]`.

**New return type:**

```ts
type BranchInfo = {
  name: string
  lastCommitDate: string // ISO 8601 timestamp
}
```

**Implementation:** The git command changes from `git branch` to:

```bash
git branch --sort=-committerdate --format='%(refname:short)\t%(committerdate:iso8601)'
```

This gets branch names with their last commit date in a single call, already sorted by most recent first — no extra git calls needed.

**Files changed:**
- `electron/services/worktree-service.ts` (or wherever `getBranches` is implemented) — update git command and parse output
- `src/lib/api.ts` — update `getBranches` return type
- `shared/types.ts` — add `BranchInfo` type
- `src/hooks/use-projects.ts` — update `useProjectBranches` return type

### Database: Favorite Branches

**Migration:** `051_project_favorite_branches.ts`

Add a `favoriteBranches` column to the `projects` table — a nullable text column storing a JSON array of branch names. Same pattern as the existing `protectedBranches` column.

```ts
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('projects')
    .addColumn('favoriteBranches', 'text')
    .execute();
}
```

**Repository:** Add `favoriteBranches` to the `update` method with the same sanitization logic used for `protectedBranches` (max 100 entries, max 256 char names, deduplicated).

**Types:** Add `favoriteBranches?: string[]` to `UpdateProject` and include it in the `Project` type.

### Project Settings: Favorite Branches UI

Add a **"Favorite Branches"** section in the project settings page, directly following the existing "Protected Branches" section. Uses the same UI pattern:

- A `<FavoriteBranchesInput>` component (mirroring `<ProtectedBranchesInput>`)
- Shows a list of currently favorited branches, each with a remove button
- An "Add" control — a small select/autocomplete to pick from available branches (filtered to exclude already-favorited ones)
- Empty state text: "No favorite branches. Add branches to pin them at the top of branch selectors."

### Migration Plan: Replace Existing Selectors

All 4 branch selectors get replaced with `<BranchSelect>`:

| Location | File | Notes |
|----------|------|-------|
| New task overlay | `src/features/new-task/ui-new-task-overlay/index.tsx` | Replace `<Select>` |
| Classic new task form | `src/routes/projects/$projectId/tasks/new.tsx` | Replace `<Select>` |
| Worktree merge actions | `src/features/agent/ui-worktree-actions/index.tsx` | Resolve projectId from task |
| Pipeline trigger dialog | `src/features/pipelines/ui-pipelines-overlay/trigger-run-dialog.tsx` | Replace custom input+dropdown |

## Implementation Order

1. Migration + DB (favorite branches column)
2. Backend (enhanced branch listing with commit dates)
3. Types (BranchInfo, updated Project type)
4. `<BranchSelect>` shared component
5. Project settings (FavoriteBranchesInput)
6. Replace all 4 existing selectors
