# Refactor Work Item Picker for Reuse

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extract the work item board/list/details components from the new-task overlay into a reusable `WorkItemPicker` composite component, then use it in both the new-task overlay and the task details work items editor.

**Architecture:** The new-task overlay currently owns a `SearchModeContent` component (~330 lines) that bundles data fetching, filtering (Fuse.js + iteration), resizable two-panel layout, view mode toggling, and keyboard navigation. We'll extract a self-contained `WorkItemPicker` into `src/features/common/ui-work-item-picker/` that encapsulates all of this. The existing `WorkItemBoard`, `WorkItemList`, `WorkItemDetails`, and `ui-work-item-shared` move from `src/features/new-task/` to `src/features/common/` since they're now shared. The task details replaces its current `WorkItemsEditor` + `WorkItemsBrowser` with this new picker inside a modal.

**Tech Stack:** React, Zustand, TanStack React Query, Fuse.js, Tailwind CSS

---

### Task 1: Move shared work item UI primitives to `src/features/common/`

These components are already fully presentational and decoupled. Move them out of `new-task/` so both features can import them.

**Files:**
- Move: `src/features/new-task/ui-work-item-shared.tsx` → `src/features/common/ui-work-item-shared.tsx`
- Move: `src/features/new-task/ui-work-item-board/index.tsx` → `src/features/common/ui-work-item-board/index.tsx`
- Move: `src/features/new-task/ui-work-item-list/index.tsx` → `src/features/common/ui-work-item-list/index.tsx`
- Move: `src/features/new-task/ui-work-item-details/index.tsx` → `src/features/common/ui-work-item-details/index.tsx`
- Modify: `src/features/new-task/ui-new-task-overlay/index.tsx` — update imports

**Step 1: Move the files**

```bash
mv src/features/new-task/ui-work-item-shared.tsx src/features/common/ui-work-item-shared.tsx
mkdir -p src/features/common/ui-work-item-board
mv src/features/new-task/ui-work-item-board/index.tsx src/features/common/ui-work-item-board/index.tsx
rmdir src/features/new-task/ui-work-item-board
mkdir -p src/features/common/ui-work-item-list
mv src/features/new-task/ui-work-item-list/index.tsx src/features/common/ui-work-item-list/index.tsx
rmdir src/features/new-task/ui-work-item-list
mkdir -p src/features/common/ui-work-item-details
mv src/features/new-task/ui-work-item-details/index.tsx src/features/common/ui-work-item-details/index.tsx
rmdir src/features/new-task/ui-work-item-details
```

**Step 2: Update internal imports in the moved files**

In `ui-work-item-board/index.tsx` and `ui-work-item-list/index.tsx`, change:
```ts
// Old
import { WorkItemTypeIcon, SelectionCheckbox } from '../ui-work-item-shared';
// New
import { WorkItemTypeIcon, SelectionCheckbox } from '../ui-work-item-shared';
```
These are relative sibling imports — they stay the same since the files moved together. No change needed.

**Step 3: Update imports in `ui-new-task-overlay/index.tsx`**

Find all imports referencing the old paths and update them:

```ts
// Old
import { WorkItemBoard } from '../ui-work-item-board';
import { WorkItemList } from '../ui-work-item-list';
import { WorkItemDetails } from '../ui-work-item-details';
// New
import { WorkItemBoard } from '@/features/common/ui-work-item-board';
import { WorkItemList } from '@/features/common/ui-work-item-list';
import { WorkItemDetails } from '@/features/common/ui-work-item-details';
```

**Step 4: Verify build**

```bash
pnpm ts-check
```

**Step 5: Commit**

```bash
git add -A
git commit -m "refactor: move work item UI primitives to features/common"
```

---

### Task 2: Create the `WorkItemPicker` composite component

Extract the `SearchModeContent` logic from the new-task overlay into a self-contained picker component. This component handles:
- Data fetching (work items + iterations via React Query)
- Client-side filtering (Fuse.js fuzzy search)
- View mode toggling (board/list)
- Iteration selection
- Resizable two-panel layout (items + details)
- Highlight and multi-select state
- Keyboard navigation (delegated to board/list children)

**Files:**
- Create: `src/features/common/ui-work-item-picker/index.tsx`

**Step 1: Create the component**

The component accepts configuration props and exposes selection callbacks. It manages its own internal state for highlighting, filtering, iteration, view mode, and panel width.

```tsx
import clsx from 'clsx';
import Fuse from 'fuse.js';
import { Columns3, List } from 'lucide-react';
import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { Select } from '@/common/ui/select';
import { WorkItemBoard } from '@/features/common/ui-work-item-board';
import { WorkItemDetails } from '@/features/common/ui-work-item-details';
import { WorkItemList } from '@/features/common/ui-work-item-list';
import { useIterations, useWorkItems } from '@/hooks/use-work-items';
import type { AzureDevOpsWorkItem } from '@/lib/api';

// Status urgency for sorting (lower = more urgent / further left)
const STATUS_URGENCY: Record<string, number> = {
  Active: 1,
  'In Progress': 1,
  New: 2,
  'To Do': 2,
  Resolved: 3,
  Done: 3,
  Closed: 4,
  Removed: 5,
};

function getStatusUrgency(status: string): number {
  return STATUS_URGENCY[status] ?? 3;
}

export type WorkItemsViewMode = 'list' | 'board';

export function WorkItemPicker({
  providerId,
  projectId,
  projectName,
  selectedWorkItemIds,
  onToggleSelect,
  onClearSelection,
  filter,
  viewMode: controlledViewMode,
  onViewModeChange: controlledOnViewModeChange,
  excludeWorkItemTypes = ['Test Suite', 'Test Case', 'Epic', 'Feature'],
  headerRight,
}: {
  providerId: string;
  projectId: string;
  projectName: string;
  selectedWorkItemIds: string[];
  onToggleSelect: (workItem: AzureDevOpsWorkItem) => void;
  onClearSelection?: () => void;
  /** Client-side fuzzy filter text. Managed externally so the parent can own the search input. */
  filter?: string;
  /** Controlled view mode. If omitted, internal state is used. */
  viewMode?: WorkItemsViewMode;
  onViewModeChange?: (mode: WorkItemsViewMode) => void;
  /** Work item types to exclude from the query. */
  excludeWorkItemTypes?: string[];
  /** Extra elements rendered at the end of the header toolbar. */
  headerRight?: React.ReactNode;
}) {
  // View mode — controlled or uncontrolled
  const [internalViewMode, setInternalViewMode] =
    useState<WorkItemsViewMode>('board');
  const viewMode = controlledViewMode ?? internalViewMode;
  const onViewModeChange = controlledOnViewModeChange ?? setInternalViewMode;

  // Highlight state (always internal — keyboard/mouse navigation)
  const [highlightedWorkItemId, setHighlightedWorkItemId] = useState<
    string | null
  >(null);

  // Fetch iterations
  const { data: iterations = [] } = useIterations({
    providerId,
    projectName,
  });

  const currentIteration = useMemo(
    () => iterations.find((i) => i.isCurrent),
    [iterations],
  );

  // Iteration selection
  const [selectedIterationId, setSelectedIterationId] =
    useState<string>('__current__');

  // Reset iteration when project changes
  useEffect(() => {
    setSelectedIterationId('__current__');
  }, [projectId]);

  const resolvedIterationPath = useMemo(() => {
    if (selectedIterationId === '__all__') return undefined;
    if (selectedIterationId === '__current__') {
      return iterations.find((i) => i.isCurrent)?.path;
    }
    return iterations.find((i) => i.id === selectedIterationId)?.path;
  }, [selectedIterationId, iterations]);

  const iterationOptions = useMemo(() => {
    const opts = [
      {
        value: '__current__',
        label: currentIteration
          ? `Current: ${currentIteration.name}`
          : 'Current Iteration',
      },
      { value: '__all__', label: 'All Iterations' },
    ];
    for (const iter of [...iterations].reverse()) {
      if (iter.isCurrent) continue;
      opts.push({ value: iter.id, label: iter.name });
    }
    return opts;
  }, [iterations, currentIteration]);

  // Fetch work items
  const { data: workItems = [], isLoading } = useWorkItems({
    providerId,
    projectId,
    projectName,
    filters: {
      excludeWorkItemTypes,
      iterationPath: resolvedIterationPath,
    },
  });

  // Fuse.js fuzzy search
  const fuse = useMemo(
    () =>
      new Fuse(workItems, {
        keys: ['fields.title', 'id'],
        threshold: 0.4,
        ignoreLocation: true,
      }),
    [workItems],
  );

  const filteredWorkItems = useMemo(() => {
    if (!filter?.trim()) {
      return [...workItems].sort(
        (a, b) =>
          getStatusUrgency(a.fields.state) - getStatusUrgency(b.fields.state),
      );
    }
    return fuse.search(filter).map((r) => r.item);
  }, [workItems, filter, fuse]);

  // Highlighted work item for details panel
  const highlightedIndex = useMemo(() => {
    if (highlightedWorkItemId === null) return -1;
    return filteredWorkItems.findIndex(
      (wi) => wi.id.toString() === highlightedWorkItemId,
    );
  }, [filteredWorkItems, highlightedWorkItemId]);

  const [highlightedWorkItem, setHighlightedWorkItem] =
    useState<AzureDevOpsWorkItem | null>(null);

  useEffect(() => {
    startTransition(() => {
      if (
        highlightedIndex >= 0 &&
        highlightedIndex < filteredWorkItems.length
      ) {
        setHighlightedWorkItem(filteredWorkItems[highlightedIndex]);
      } else if (selectedWorkItemIds.length > 0) {
        const firstSelected = workItems.find(
          (wi) => wi.id.toString() === selectedWorkItemIds[0],
        );
        setHighlightedWorkItem(firstSelected ?? null);
      } else {
        setHighlightedWorkItem(null);
      }
    });
  }, [filteredWorkItems, highlightedIndex, selectedWorkItemIds, workItems]);

  // Resizable panel
  const [panelWidth, setPanelWidth] = useState(65);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = panelWidth;

      const onMouseMove = (moveEvent: MouseEvent) => {
        if (!containerRef.current) return;
        const containerWidth = containerRef.current.offsetWidth;
        const deltaX = moveEvent.clientX - startX;
        const deltaPct = (deltaX / containerWidth) * 100;
        const newWidth = Math.max(30, Math.min(80, startWidth + deltaPct));
        setPanelWidth(newWidth);
      };

      const onMouseUp = () => {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    },
    [panelWidth],
  );

  const handleHighlight = useCallback((workItem: AzureDevOpsWorkItem) => {
    setHighlightedWorkItemId(workItem.id.toString());
  }, []);

  // Loading state
  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-ink-2 text-sm">Loading work items...</div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex h-full w-full overflow-hidden">
      {/* Left panel: items */}
      <div
        className="flex shrink-0 flex-col overflow-hidden"
        style={{ width: `${panelWidth}%` }}
      >
        {/* Header toolbar */}
        <div
          className="mb-0 flex items-center gap-2 px-1 py-2"
          style={{ borderBottom: '1px solid oklch(1 0 0 / 0.04)' }}
        >
          <span className="text-ink-3 font-mono text-[10px] font-semibold tracking-wider uppercase">
            Work Items ({filteredWorkItems.length})
            {selectedWorkItemIds.length > 0 && (
              <span className="text-acc-ink ml-2 font-mono text-[10px] font-semibold tracking-wider uppercase">
                {selectedWorkItemIds.length} selected
              </span>
            )}
          </span>

          <div className="flex items-center gap-2">
            {viewMode === 'board' &&
              selectedWorkItemIds.length > 0 &&
              onClearSelection && (
                <button
                  type="button"
                  onClick={onClearSelection}
                  className="border-glass-border text-ink-1 hover:border-glass-border-strong hover:text-ink-0 rounded border px-2 py-1 text-xs font-medium"
                >
                  Clear selected
                </button>
              )}

            {/* Iteration dropdown */}
            {iterations.length > 0 && (
              <Select
                value={selectedIterationId}
                options={iterationOptions}
                onChange={setSelectedIterationId}
                label="Iteration"
                side="bottom"
              />
            )}

            {/* View mode toggle */}
            <div className="border-glass-border flex rounded border">
              <button
                type="button"
                onClick={() => onViewModeChange('list')}
                className={clsx(
                  'flex items-center px-1.5 py-1',
                  viewMode === 'list'
                    ? 'bg-bg-3 text-ink-0'
                    : 'text-ink-2 hover:text-ink-1',
                )}
                title="List view"
              >
                <List className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => onViewModeChange('board')}
                className={clsx(
                  'flex items-center px-1.5 py-1',
                  viewMode === 'board'
                    ? 'bg-bg-3 text-ink-0'
                    : 'text-ink-2 hover:text-ink-1',
                )}
                title="Board view"
              >
                <Columns3 className="h-3.5 w-3.5" />
              </button>
            </div>

            {/* Custom header content (e.g. Next button) */}
            {headerRight}
          </div>
        </div>

        {/* Items area */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {viewMode === 'list' ? (
            <WorkItemList
              workItems={filteredWorkItems}
              highlightedWorkItemId={highlightedWorkItemId}
              selectedWorkItemIds={selectedWorkItemIds}
              providerId={providerId}
              onToggleSelect={onToggleSelect}
              onHighlight={handleHighlight}
            />
          ) : (
            <WorkItemBoard
              workItems={filteredWorkItems}
              highlightedWorkItemId={highlightedWorkItemId}
              selectedWorkItemIds={selectedWorkItemIds}
              providerId={providerId}
              onToggleSelect={onToggleSelect}
              onHighlight={handleHighlight}
            />
          )}
        </div>
      </div>

      {/* Drag handle */}
      <div
        className="hover:bg-bg-3 active:bg-bg-2 w-1 shrink-0 cursor-col-resize bg-transparent"
        onMouseDown={handleDragStart}
      />

      {/* Right panel: details */}
      <div
        className="flex-1 overflow-y-auto rounded-none border-l p-3"
        style={{
          borderColor: 'oklch(1 0 0 / 0.04)',
          background: 'oklch(0 0 0 / 0.22)',
        }}
      >
        <WorkItemDetails
          workItem={highlightedWorkItem ?? null}
          providerId={providerId}
        />
      </div>
    </div>
  );
}
```

Key design decisions:
- **`filter` is external** — the parent owns the search input (overlay has it in the top bar, task details will have it in the modal header). The picker just receives the string.
- **`viewMode` is controlled or uncontrolled** — the overlay persists it in the draft store, the task details doesn't need to persist it.
- **`headerRight` slot** — the overlay puts its "Next" button here. The task details won't need it.
- **`selectedWorkItemIds` + `onToggleSelect` is external** — the parent manages selection state because it needs to do things with it (advance to compose, update task, etc.).
- **Highlight state is internal** — it's purely navigational UI, not business state.
- **Panel width is internal** — simpler than plumbing through UI settings. The overlay was persisting it but that's not worth the coupling.

**Step 2: Verify build**

```bash
pnpm ts-check
```

**Step 3: Commit**

```bash
git add src/features/common/ui-work-item-picker/index.tsx
git commit -m "feat: create reusable WorkItemPicker component"
```

---

### Task 3: Replace `SearchModeContent` in the new-task overlay with `WorkItemPicker`

**Files:**
- Modify: `src/features/new-task/ui-new-task-overlay/index.tsx`

**Step 1: Replace the `SearchModeContent` component**

Delete the entire `SearchModeContent` function (lines ~1438–1774) and replace it with a thin wrapper that uses `WorkItemPicker`:

```tsx
function SearchModeContent({
  project,
  filter,
  selectedWorkItemIds,
  viewMode,
  onViewModeChange,
  onWorkItemToggle,
  onClearSelectedWorkItems,
  onAdvanceToCompose,
  canAdvance,
}: {
  project: Project | null;
  filter: string;
  selectedWorkItemIds: string[];
  viewMode: WorkItemsViewMode;
  onViewModeChange: (mode: WorkItemsViewMode) => void;
  onWorkItemToggle: (workItem: AzureDevOpsWorkItem) => void;
  onClearSelectedWorkItems: () => void;
  onAdvanceToCompose: () => void;
  canAdvance: boolean;
}) {
  const hasWorkItems = projectHasWorkItems(project);

  if (!project || !hasWorkItems) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-ink-2 text-center">
          {!project ? (
            <p className="text-sm">Select a project to search work items</p>
          ) : (
            <>
              <p className="text-sm">No work items linked to this project.</p>
              <p className="mt-1 text-xs">
                Link Azure DevOps in project settings to see work items.
              </p>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <WorkItemPicker
      providerId={project.workItemProviderId!}
      projectId={project.workItemProjectId!}
      projectName={project.workItemProjectName!}
      selectedWorkItemIds={selectedWorkItemIds}
      onToggleSelect={onWorkItemToggle}
      onClearSelection={onClearSelectedWorkItems}
      filter={filter}
      viewMode={viewMode}
      onViewModeChange={onViewModeChange}
      headerRight={
        canAdvance ? (
          <Button variant="primary" size="sm" onClick={onAdvanceToCompose}>
            Next
            <ChevronRight className="h-3 w-3" />
            <Kbd shortcut="cmd+enter" className="ml-1" />
          </Button>
        ) : undefined
      }
    />
  );
}
```

Also:
- Remove the `projectId` prop (no longer needed — the null check moves to the caller or uses `project` directly).
- Add the import for `WorkItemPicker` at the top.
- Remove now-unused imports: `useIterations`, `useWorkItems` (if only used by `SearchModeContent`), `useUISetting`, `useUIStore` (if only used for panel width), `Columns3`, `List`, `Select`, `Fuse`, `startTransition`.
- Remove the `getStatusUrgency` function if only used by `SearchModeContent`.

**Step 2: Update the call site**

In the parent component where `SearchModeContent` is rendered (~line 1041-1059), remove the `projectId` prop:

```tsx
// Old
<SearchModeContent
  projectId={selectedProjectId}
  project={selectedProject}
  ...
/>

// New
<SearchModeContent
  project={selectedProject}
  ...
/>
```

**Step 3: Verify build**

```bash
pnpm ts-check
```

**Step 4: Commit**

```bash
git add src/features/new-task/ui-new-task-overlay/index.tsx
git commit -m "refactor: use WorkItemPicker in new-task overlay"
```

---

### Task 4: Replace `WorkItemsEditor` + `WorkItemsBrowser` with `WorkItemPicker` in task details

The current task details uses a `WorkItemsEditor` inside a small `Modal` with `size="sm"`. The editor shows a flat list of linked work item IDs and an inline `WorkItemsBrowser` for adding. We'll replace this with a larger modal containing `WorkItemPicker` so users get the same rich board/list experience as the new-task overlay.

**Files:**
- Modify: `src/features/task/ui-task-panel/index.tsx`
- Delete: `src/features/task/ui-task-panel/work-items-editor.tsx` (after confirming no other consumers)

**Step 1: Check for other consumers of `WorkItemsEditor`**

```bash
grep -r "WorkItemsEditor\|work-items-editor" src/ --include="*.tsx" --include="*.ts" -l
```

Should only show `index.tsx` and the file itself.

**Step 2: Replace the modal contents in `index.tsx`**

Find the `WorkItemsEditor` modal section (around lines 1043-1067) and replace it:

```tsx
// Old
import { WorkItemsEditor } from './work-items-editor';

// New
import { WorkItemPicker } from '@/features/common/ui-work-item-picker';
```

Replace the Modal + WorkItemsEditor with a larger modal containing WorkItemPicker. The modal needs a search input in its header and the picker in its body.

```tsx
{/* Work items editor modal */}
{hasWorkItemsLink && (
  <WorkItemsPickerModal
    isOpen={showWorkItemsEditor}
    onClose={() => setShowWorkItemsEditor(false)}
    project={project}
    workItemIds={task.workItemIds ?? []}
    workItemUrls={task.workItemUrls ?? []}
    onUpdate={({ workItemIds, workItemUrls }) => {
      updateTask.mutate({
        id: taskId,
        data: { workItemIds, workItemUrls },
      });
    }}
  />
)}
```

Create a small `WorkItemsPickerModal` component nearby (or inline) that wraps the picker:

```tsx
function WorkItemsPickerModal({
  isOpen,
  onClose,
  project,
  workItemIds,
  workItemUrls,
  onUpdate,
}: {
  isOpen: boolean;
  onClose: () => void;
  project: Project;
  workItemIds: string[];
  workItemUrls: string[];
  onUpdate: (update: {
    workItemIds: string[] | null;
    workItemUrls: string[] | null;
  }) => void;
}) {
  const [filter, setFilter] = useState('');
  // Local selection state initialized from task's current work item IDs
  const [selectedIds, setSelectedIds] = useState<string[]>(workItemIds);

  // Sync when modal opens or workItemIds change externally
  useEffect(() => {
    if (isOpen) {
      setSelectedIds(workItemIds);
      setFilter('');
    }
  }, [isOpen, workItemIds]);

  const handleToggle = useCallback(
    (workItem: AzureDevOpsWorkItem) => {
      const wiId = workItem.id.toString();
      const wiUrl = workItem.url;

      if (selectedIds.includes(wiId)) {
        // Remove
        const idx = selectedIds.indexOf(wiId);
        const newIds = selectedIds.filter((_, i) => i !== idx);
        const newUrls = workItemUrls.filter((_, i) => i !== idx);
        setSelectedIds(newIds);
        onUpdate({
          workItemIds: newIds.length > 0 ? newIds : null,
          workItemUrls: newUrls.length > 0 ? newUrls : null,
        });
      } else {
        // Add
        const newIds = [...selectedIds, wiId];
        const newUrls = [...workItemUrls, wiUrl];
        setSelectedIds(newIds);
        onUpdate({
          workItemIds: newIds,
          workItemUrls: newUrls,
        });
      }
    },
    [selectedIds, workItemUrls, onUpdate],
  );

  const handleClear = useCallback(() => {
    setSelectedIds([]);
    onUpdate({ workItemIds: null, workItemUrls: null });
  }, [onUpdate]);

  if (!isOpen) return null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Linked Work Items" size="lg">
      <div className="flex flex-col" style={{ height: '60vh' }}>
        {/* Search input */}
        <div className="mb-2 shrink-0">
          <Input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search work items..."
            size="sm"
            icon={<Search />}
          />
        </div>

        {/* Picker */}
        <div className="min-h-0 flex-1">
          <WorkItemPicker
            providerId={project.workItemProviderId!}
            projectId={project.workItemProjectId!}
            projectName={project.workItemProjectName!}
            selectedWorkItemIds={selectedIds}
            onToggleSelect={handleToggle}
            onClearSelection={handleClear}
            filter={filter}
          />
        </div>
      </div>
    </Modal>
  );
}
```

**Step 3: Delete `work-items-editor.tsx`**

```bash
rm src/features/task/ui-task-panel/work-items-editor.tsx
```

**Step 4: Consider deleting `WorkItemsBrowser`**

Check if `WorkItemsBrowser` has other consumers:

```bash
grep -r "WorkItemsBrowser\|ui-work-items-browser" src/ --include="*.tsx" --include="*.ts" -l
```

If `WorkItemsEditor` was its only consumer, delete it:

```bash
rm -rf src/features/agent/ui-work-items-browser/
```

Also remove `useWorkItemsFiltersStore` from `src/stores/new-task-form.ts` if it was only used by `WorkItemsBrowser`. (Check first — the new-task-form store also has `NewTaskFormDraft` which may still be used elsewhere.)

**Step 5: Verify build**

```bash
pnpm ts-check
```

**Step 6: Commit**

```bash
git add -A
git commit -m "feat: use WorkItemPicker in task details modal

Replace the simple WorkItemsEditor + WorkItemsBrowser with the full
WorkItemPicker, giving the task panel the same rich board/list experience
as the new-task overlay."
```

---

### Task 5: Lint and final cleanup

**Step 1: Run lint with auto-fix**

```bash
pnpm lint --fix
```

**Step 2: Fix any remaining lint errors**

```bash
pnpm lint
```

Address any remaining issues (typically unused imports from the refactor).

**Step 3: TypeScript check**

```bash
pnpm ts-check
```

**Step 4: Commit any fixes**

```bash
git add -A
git commit -m "chore: lint fixes after work item picker refactor"
```
