# Branch Selector Improvements — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace all branch selectors with a shared searchable combobox that shows favorite branches (per-project) and sorts all branches by last git commit date.

**Architecture:** New `BranchInfo` type carries branch name + last commit date from backend. A shared `<BranchSelect>` combobox component renders sections (Favorites, All Branches) with type-to-filter. Favorite branches are stored per-project in a new DB column, managed in project settings.

**Tech Stack:** SQLite/Kysely (migration), Electron IPC, React, TanStack Query, Tailwind CSS

---

### Task 1: Database Migration — Add `favoriteBranches` Column

**Files:**
- Create: `electron/database/migrations/051_project_favorite_branches.ts`
- Modify: `electron/database/migrator.ts`
- Modify: `electron/database/schema.ts`

**Step 1: Create the migration file**

Create `electron/database/migrations/051_project_favorite_branches.ts`:

```typescript
import { Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('projects')
    .addColumn('favoriteBranches', 'text')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('projects')
    .dropColumn('favoriteBranches')
    .execute();
}
```

**Step 2: Register the migration**

In `electron/database/migrator.ts`, add the import and registration following the pattern of existing migrations:

```typescript
import * as m051 from './migrations/051_project_favorite_branches';
```

And in the `migrations` record:

```typescript
'051_project_favorite_branches': m051,
```

**Step 3: Add column to schema**

In `electron/database/schema.ts`, add to the `ProjectTable` interface (after `protectedBranches`):

```typescript
favoriteBranches: string | null; // JSON array of branch names
```

**Step 4: Commit**

```
feat(db): add favoriteBranches column to projects table
```

---

### Task 2: Types and Repository — Wire `favoriteBranches` Through the Stack

**Files:**
- Modify: `shared/types.ts`
- Modify: `electron/database/repositories/projects.ts`

**Step 1: Add `BranchInfo` type and update `Project` / `UpdateProject`**

In `shared/types.ts`:

1. Add `BranchInfo` type (near the top, next to other shared types):

```typescript
export interface BranchInfo {
  name: string;
  lastCommitDate: string;
}
```

2. Add to the `Project` interface (after `protectedBranches`):

```typescript
favoriteBranches: string[];
```

3. Add to the `UpdateProject` interface (after `protectedBranches`):

```typescript
favoriteBranches?: string[];
```

**Step 2: Update the repository**

In `electron/database/repositories/projects.ts`:

1. Rename `sanitizeProtectedBranches` to a more general `sanitizeBranchList` (or add a second function). The simplest approach: add a `sanitizeFavoriteBranches` function identical to `sanitizeProtectedBranches`:

```typescript
function sanitizeFavoriteBranches(
  branches: string[] | undefined | null,
): string | null {
  if (!branches || branches.length === 0) return null;
  const sanitized = [
    ...new Set(
      branches.filter(
        (b) =>
          typeof b === 'string' &&
          b.length > 0 &&
          b.length <= MAX_BRANCH_NAME_LENGTH,
      ),
    ),
  ].slice(0, MAX_PROTECTED_BRANCHES);
  return sanitized.length > 0 ? JSON.stringify(sanitized) : null;
}
```

2. Update `parseProjectRow` — add `favoriteBranches` parsing right after `protectedBranches`:

```typescript
let favoriteBranches: string[] = [];
if (row.favoriteBranches) {
  try {
    const parsed: unknown = JSON.parse(row.favoriteBranches);
    favoriteBranches = Array.isArray(parsed)
      ? parsed.filter((b): b is string => typeof b === 'string')
      : [];
  } catch {
    // Malformed JSON — fall back to empty
  }
}
```

And add `favoriteBranches` to the return object.

3. Update `create` method — add to the `.values()` call:

```typescript
favoriteBranches: sanitizeFavoriteBranches(favoriteBranches),
```

And destructure `favoriteBranches` alongside `protectedBranches` from `data`.

4. Update `update` method — add to the `.set()` call:

```typescript
...(favoriteBranches !== undefined && {
  favoriteBranches: sanitizeFavoriteBranches(favoriteBranches),
}),
```

And destructure `favoriteBranches` alongside `protectedBranches` from `data`.

**Step 3: Commit**

```
feat(types): add BranchInfo type and favoriteBranches to Project
```

---

### Task 3: Backend — Return `BranchInfo[]` from `getProjectBranches`

**Files:**
- Modify: `electron/services/worktree-service.ts`
- Modify: `electron/ipc/handlers.ts`
- Modify: `electron/preload.ts`
- Modify: `src/lib/api.ts`
- Modify: `src/hooks/use-projects.ts`
- Modify: `src/hooks/use-worktree-diff.ts`

**Step 1: Update `getProjectBranches` in worktree-service.ts**

Change the function at line ~707 to return `BranchInfo[]`:

```typescript
import type { BranchInfo } from '@shared/types';

export async function getProjectBranches(
  projectPath: string,
): Promise<BranchInfo[]> {
  try {
    const { stdout } = await execAsync(
      'git branch --sort=-committerdate --format="%(refname:short)\t%(committerdate:iso-strict)"',
      {
        cwd: projectPath,
        encoding: 'utf-8',
      },
    );
    return stdout
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => {
        const [name, lastCommitDate] = line.split('\t');
        return { name: name ?? line, lastCommitDate: lastCommitDate ?? '' };
      });
  } catch (error) {
    throw new Error(`Failed to get branches: ${error}`);
  }
}
```

The `--sort=-committerdate` flag sorts by most recent first. The `--format` outputs `branchname\tdate` per line.

**Step 2: Update IPC handler**

The handler in `electron/ipc/handlers.ts` at line ~378 doesn't need changes — it already returns whatever `getProjectBranches` returns.

The worktree handler at line ~1632 also calls `getProjectBranches` — it will now return `BranchInfo[]` too.

**Step 3: Update preload bridge types**

No code changes needed — `ipcRenderer.invoke` returns `Promise<any>`, types are in `api.ts`.

**Step 4: Update `api.ts` types**

In `src/lib/api.ts`, update the `projects` section:

```typescript
getBranches: (projectId: string) => Promise<BranchInfo[]>;
```

And in the `tasks.worktree` section:

```typescript
getBranches: (taskId: string) => Promise<BranchInfo[]>;
```

Import `BranchInfo` from `@shared/types`.

**Step 5: Update `useProjectBranches` hook**

In `src/hooks/use-projects.ts`, update the return type:

```typescript
export function useProjectBranches(projectId: string | null) {
  return useQuery({
    queryKey: ['project-branches', projectId],
    queryFn: () => {
      if (!projectId) return [];
      return api.projects.getBranches(projectId);
    },
    enabled: !!projectId,
    staleTime: 30000,
  });
}
```

The return type is now inferred as `BranchInfo[]`. No explicit annotation needed.

**Step 6: Update `useWorktreeBranches` hook**

In `src/hooks/use-worktree-diff.ts`, same — the return type will naturally change since `api.tasks.worktree.getBranches` now returns `BranchInfo[]`.

**Step 7: Commit**

```
feat(backend): return BranchInfo with commit dates from branch listing
```

---

### Task 4: Shared `<BranchSelect>` Component

**Files:**
- Create: `src/common/ui/branch-select/index.tsx`

**Step 1: Create the component**

Create `src/common/ui/branch-select/index.tsx`. This is a combobox with search input and sectioned dropdown.

The component should:

1. Accept props:

```typescript
{
  branches: BranchInfo[]
  branchesLoading?: boolean
  favoriteBranches?: string[]
  defaultBranch?: string | null
  protectedBranches?: string[]
  value: string | undefined
  onChange: (branch: string) => void
  label?: string
  disabled?: boolean
  placeholder?: string
  side?: 'top' | 'bottom'
}
```

Note: We pass `branches` and `favoriteBranches` as props rather than fetching internally — this keeps the component pure and lets each consumer provide data however it gets it (via `useProjectBranches`, or from Azure DevOps APIs, etc.).

2. Internal state: `isOpen`, `filter` (search string), `highlightedIndex` (keyboard navigation).

3. Rendering:
   - **Trigger button** showing the selected branch name (or placeholder). Clicking opens the dropdown.
   - **Dropdown** (portaled, positioned) containing:
     - **Search input** at the top — auto-focused when dropdown opens
     - **Favorites section** — header "Favorites" + list of favorite branches that match the filter. Only rendered if `favoriteBranches` has entries. Each item shows the branch name.
     - **All Branches section** — header "All branches" + list of all branches that match the filter. Each item shows the branch name, with "(default)" badge for the default branch and "(protected)" suffix for protected branches.
   - Sections with no matching branches are hidden.
   - Use fuzzy/substring matching: `branch.name.toLowerCase().includes(filter.toLowerCase())`

4. Keyboard:
   - Arrow up/down: navigate items across sections
   - Enter: select highlighted item, close dropdown
   - Escape: close dropdown
   - Typing in the search input filters in real-time

5. Styling: Follow existing component patterns (use `border-glass-border`, `bg-bg-0`, `text-ink-1`, `hover:bg-glass-medium`, etc.). Match the visual density of the existing `<Select>` component.

6. Close on click outside (use a backdrop or `onBlur` with timeout, similar to existing `Select`).

**Step 2: Commit**

```
feat(ui): add BranchSelect combobox component with sections
```

---

### Task 5: Favorite Branches Input in Project Settings

**Files:**
- Create: `src/features/project/ui-project-settings/favorite-branches-input.tsx`
- Modify: `src/features/project/ui-project-settings/index.tsx`

**Step 1: Create `FavoriteBranchesInput` component**

Model it closely after `protected-branches-input.tsx`. The component:

```typescript
import { Star, X } from 'lucide-react';
import { useMemo } from 'react';

import { Select } from '@/common/ui/select';

export function FavoriteBranchesInput({
  branches,
  branchesLoading,
  favoriteBranches,
  onChange,
}: {
  branches: string[];
  branchesLoading: boolean;
  favoriteBranches: string[];
  onChange: (branches: string[]) => void;
}) {
  const availableBranches = useMemo(
    () => branches.filter((b) => !favoriteBranches.includes(b)),
    [branches, favoriteBranches],
  );

  const handleAdd = (branch: string) => {
    if (branch && !favoriteBranches.includes(branch)) {
      onChange([...favoriteBranches, branch]);
    }
  };

  const handleRemove = (branch: string) => {
    onChange(favoriteBranches.filter((b) => b !== branch));
  };

  return (
    <div>
      <label className="text-ink-1 mb-1 flex items-center gap-1.5 text-sm font-medium">
        <Star className="text-amber-400 h-4 w-4" />
        Favorite branches
      </label>
      {favoriteBranches.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {favoriteBranches.map((branch) => (
            <FavoriteBranchBadge
              key={branch}
              branch={branch}
              onRemove={() => handleRemove(branch)}
            />
          ))}
        </div>
      )}
      <Select
        value=""
        options={
          branchesLoading
            ? [{ value: '', label: 'Loading...' }]
            : availableBranches.length === 0
              ? [{ value: '', label: 'No branches available' }]
              : [
                  { value: '', label: 'Add a favorite branch...' },
                  ...availableBranches.map((b) => ({ value: b, label: b })),
                ]
        }
        onChange={(value) => {
          if (value) handleAdd(value);
        }}
        disabled={branchesLoading || availableBranches.length === 0}
        className="w-full justify-between"
      />
      <p className="text-ink-3 mt-1 text-xs">
        Favorite branches appear at the top of branch selectors
      </p>
    </div>
  );
}

function FavoriteBranchBadge({
  branch,
  onRemove,
}: {
  branch: string;
  onRemove: () => void;
}) {
  return (
    <span className="border-amber-400/50 bg-amber-400/10 text-amber-400 inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs">
      {branch}
      <button
        type="button"
        onClick={onRemove}
        className="hover:bg-amber-400/20 cursor-pointer rounded p-0.5 transition-colors"
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}
```

**Step 2: Wire into project settings**

In `src/features/project/ui-project-settings/index.tsx`:

1. Add state (next to `protectedBranches` state):

```typescript
const [favoriteBranches, setFavoriteBranches] = useState<string[]>([]);
```

2. In the `useEffect` that syncs project data, add:

```typescript
setFavoriteBranches(project.favoriteBranches ?? []);
```

3. In the save payload (the `updateProject.mutateAsync` call), add:

```typescript
favoriteBranches,
```

4. Render `<FavoriteBranchesInput>` right before or after `<ProtectedBranchesInput>`:

```typescript
<FavoriteBranchesInput
  branches={branches ?? []}
  branchesLoading={branchesLoading}
  favoriteBranches={favoriteBranches}
  onChange={setFavoriteBranches}
/>
```

Note: The `branches` variable here currently comes from `useProjectBranches` which now returns `BranchInfo[]`. We need to map it to `string[]` for the input: `branches={(branches ?? []).map(b => b.name)}`. Same applies to the existing `<ProtectedBranchesInput>` — update its `branches` prop too.

**Step 3: Commit**

```
feat(settings): add favorite branches management in project settings
```

---

### Task 6: Replace Branch Selector in New Task Overlay

**Files:**
- Modify: `src/features/new-task/ui-new-task-overlay/index.tsx`

**Step 1: Replace the `<Select>` with `<BranchSelect>`**

At line ~1223, replace the `<Select>` inside the branch selector wrapper:

Before:
```tsx
<Select
  value={currentSourceBranch ?? ''}
  options={branches.map((branch) => ({
    value: branch,
    label: branch,
  }))}
  onChange={(branch) => updateDraft({ sourceBranch: branch })}
  label="Source branch"
  side="top"
/>
```

After:
```tsx
<BranchSelect
  branches={branches}
  favoriteBranches={project?.favoriteBranches}
  defaultBranch={project?.defaultBranch}
  value={currentSourceBranch ?? undefined}
  onChange={(branch) => updateDraft({ sourceBranch: branch })}
  placeholder="Select branch"
  side="top"
/>
```

Note: `branches` is now `BranchInfo[]` from `useProjectBranches`. We need to make sure `project` is available — it may already be fetched via `useProject(selectedProjectId)` or we may need to add that query.

Check if `project` is already available in scope. If not, add:
```typescript
const { data: project } = useProject(selectedProjectId ?? '');
```

Update the import to add `BranchSelect` from `@/common/ui/branch-select` and remove `Select` if no longer used.

Also update any references to `branches` as `string[]` — the variable is now `BranchInfo[]`, so anywhere that does `branches.map(branch => ...)` treating `branch` as a string needs updating to `branches.map(b => b.name)`. Check the `branches.length > 0` guard — that still works fine.

**Step 2: Commit**

```
feat(new-task): use BranchSelect combobox in new task overlay
```

---

### Task 7: Replace Branch Selector in Classic New Task Form

**Files:**
- Modify: `src/routes/projects/$projectId/tasks/new.tsx`

**Step 1: Replace the `<Select>` with `<BranchSelect>`**

At line ~216, replace:

Before:
```tsx
<Select
  value={branchesLoading ? '' : (effectiveSourceBranch ?? branches[0] ?? '')}
  options={...}
  onChange={(value) => setDraft({ sourceBranch: value || null })}
  disabled={branchesLoading}
  className="w-full justify-between"
/>
```

After:
```tsx
<BranchSelect
  branches={branches ?? []}
  branchesLoading={branchesLoading}
  favoriteBranches={project?.favoriteBranches}
  defaultBranch={project?.defaultBranch}
  value={effectiveSourceBranch ?? branches?.[0]?.name}
  onChange={(value) => setDraft({ sourceBranch: value || null })}
  disabled={branchesLoading}
  placeholder="Select branch"
/>
```

Update `branches[0]` references to `branches[0]?.name` since it's now `BranchInfo[]`.

**Step 2: Commit**

```
feat(tasks): use BranchSelect combobox in classic new task form
```

---

### Task 8: Replace Branch Selector in Worktree Actions

**Files:**
- Modify: `src/features/agent/ui-worktree-actions/index.tsx`

**Step 1: Replace the `<Select>` with `<BranchSelect>`**

This is the merge target selector. At line ~290, replace:

Before:
```tsx
<Select
  value={isBranchesLoading ? '' : selectedBranch}
  options={isBranchesLoading ? [{ value: '', label: 'Loading…' }] : branchOptions}
  onChange={setSelectedBranch}
  disabled={isBranchesLoading || !branches?.length}
  className="w-full justify-between"
/>
```

After:
```tsx
<BranchSelect
  branches={branches ?? []}
  branchesLoading={isBranchesLoading}
  favoriteBranches={project?.favoriteBranches}
  defaultBranch={defaultBranch}
  protectedBranches={protectedBranches}
  value={selectedBranch || undefined}
  onChange={setSelectedBranch}
  disabled={isBranchesLoading || !branches?.length}
  placeholder="Select branch"
/>
```

Also update the `branchOptions` memo and the `useEffect` that sets the default branch — these reference `branches` as `string[]` but it's now `BranchInfo[]`. The `useEffect` at line ~135 needs to check `branches[0]?.name` instead of `branches[0]`, and `branches.includes(sourceBranch)` becomes `branches.some(b => b.name === sourceBranch)`.

The `branchOptions` memo can be removed since `<BranchSelect>` handles rendering internally.

**Step 2: Commit**

```
feat(worktree): use BranchSelect combobox in merge actions
```

---

### Task 9: Replace Branch Selector in Pipeline Trigger Dialog

**Files:**
- Modify: `src/features/pipelines/ui-pipelines-overlay/trigger-run-dialog.tsx`

**Step 1: Replace the custom input+dropdown with `<BranchSelect>`**

At line ~438, replace the entire custom branch selector block. The pipeline dialog uses Azure DevOps branches (from `useBranchNames`), not local git branches. There are no favorites or commit dates for these.

Convert `branchNames: string[]` to `BranchInfo[]` for the component:

```typescript
const pipelineBranchInfos = useMemo(
  () => branchNames.map((name) => ({ name, lastCommitDate: '' })),
  [branchNames],
);
```

Then replace the custom input+dropdown with:

```tsx
<BranchSelect
  branches={pipelineBranchInfos}
  value={branchFilter || undefined}
  onChange={(branch) => setBranchFilter(branch)}
  placeholder="Select branch"
  label="Branch"
/>
```

Remove the custom dropdown state (`showBranchDropdown`, `blurTimeoutRef`, `filteredBranches` logic).

**Step 2: Commit**

```
feat(pipelines): use BranchSelect combobox in trigger dialog
```

---

### Task 10: Final Verification

**Step 1: Run `pnpm install`**

**Step 2: Run `pnpm lint --fix`**

**Step 3: Run `pnpm ts-check`**

**Step 4: Run `pnpm lint`**

Fix any remaining issues.

**Step 5: Commit any fixes**

```
fix: resolve lint and type errors from branch selector migration
```
