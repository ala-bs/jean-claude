# Azure Board Overlay Performance Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reduce Azure board overlay render and network churn while splitting its monolithic component into focused, testable boundaries.

**Architecture:** Keep portal, focus lock, and project selection in `AzureBoardOverlay`. Move project-specific queries and UI into a keyed content component, isolate transient resize state in a split-pane component, and consolidate expensive data derivation in one pure model builder. Rely on React Compiler before adding manual memoization.

**Tech Stack:** React 19, TypeScript, Zustand, TanStack React Query, Vitest, Tailwind CSS, React Compiler

---

### Task 1: Isolate Split-Pane Resizing

**Files:**
- Create: `src/features/work-item/ui-azure-board-overlay/board-split-pane.tsx`
- Modify: `src/features/work-item/ui-azure-board-overlay/index.tsx:215-217,233-234,404,454-473,545-647`
- Test: `src/stores/azure-board.test.ts`

**Step 1: Extend persisted-width test**

Update `persists the board split width` to verify final committed values and bounds expected by split pane:

```ts
it('persists the board split width', () => {
  useAzureBoardStore.getState().setPanelWidth(58);
  expect(useAzureBoardStore.getState().panelWidth).toBe(58);
});
```

No new store behavior is required. This protects persistence contract while render ownership changes.

**Step 2: Run focused test**

Run: `pnpm test src/stores/azure-board.test.ts`

Expected: PASS before refactor.

**Step 3: Create split-pane component**

Create `board-split-pane.tsx` with these responsibilities:

```tsx
import { useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';

const MIN_BOARD_WIDTH = 30;
const MAX_BOARD_WIDTH = 80;

function clampBoardWidth(width: number) {
  return Math.min(MAX_BOARD_WIDTH, Math.max(MIN_BOARD_WIDTH, width));
}

export function BoardSplitPane({
  initialBoardWidth,
  board,
  details,
  onBoardWidthCommit,
}: {
  initialBoardWidth: number;
  board: ReactNode;
  details: ReactNode;
  onBoardWidthCommit: (width: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController>(null);
  const [boardWidth, setBoardWidth] = useState(initialBoardWidth);

  useEffect(() => setBoardWidth(initialBoardWidth), [initialBoardWidth]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const startResize = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    let pendingWidth = boardWidth;

    const move = (moveEvent: MouseEvent) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      pendingWidth = clampBoardWidth(
        ((moveEvent.clientX - rect.left) / rect.width) * 100,
      );
      setBoardWidth(pendingWidth);
    };
    const stop = () => {
      onBoardWidthCommit(pendingWidth);
      controller.abort();
    };

    document.addEventListener('mousemove', move, { signal: controller.signal });
    document.addEventListener('mouseup', stop, { signal: controller.signal });
    window.addEventListener('blur', stop, { signal: controller.signal });
  };

  // Render current board/details markup and accessible keyboard separator here.
}
```

Keep keyboard resizing local, then call `onBoardWidthCommit()` once per key event. Preserve:

- board width range: 30-80%
- details width range: 20-70%
- `role="separator"`
- arrow-key support
- wide invisible hit target with one-pixel visible divider

**Step 4: Replace inline resize implementation**

In `index.tsx`:

- Remove `splitPaneRef` and `resizeAbortRef`.
- Remove resize cleanup effect and `startResize`.
- Keep persisted `panelWidth` selector.
- Render `BoardSplitPane` with board and details nodes.
- Pass `setPanelWidth` only as commit callback.

This ensures mouse movement rerenders only `BoardSplitPane`, not queries, model derivation, board cards, or preview.

**Step 5: Verify**

Run:

```bash
pnpm test src/stores/azure-board.test.ts
pnpm ts-check
pnpm lint
```

Expected: all PASS. Manually confirm drag, keyboard arrows, persisted width, and no board scroll when opening related bugs.

**Step 6: Commit**

```bash
git add src/features/work-item/ui-azure-board-overlay/board-split-pane.tsx src/features/work-item/ui-azure-board-overlay/index.tsx src/stores/azure-board.test.ts
git commit -m "perf(azure-board): isolate split pane resizing"
```

### Task 2: Debounce Remote Search

**Files:**
- Create: `src/common/hooks/use-debounced-value.ts`
- Create: `src/common/hooks/use-debounced-value.test.ts`
- Modify: `src/features/work-item/ui-azure-board-overlay/index.tsx:243-285,502-505`

**Step 1: Write failing debounce tests**

Use fake timers to verify latest value publishes only after delay and timers clean up on value changes/unmount:

```ts
describe('debounced value timing', () => {
  it('publishes only the latest value after the delay', () => {
    // Test extracted timer behavior or hook with existing React test utilities.
  });
});
```

If repository lacks hook rendering utilities, extract and test a small timer controller rather than adding a dependency.

**Step 2: Run test to verify failure**

Run: `pnpm test src/common/hooks/use-debounced-value.test.ts`

Expected: FAIL because implementation does not exist.

**Step 3: Implement debounce hook**

```ts
export function useDebouncedValue<T>(value: T, delayMs: number) {
  const [debouncedValue, setDebouncedValue] = useState(value);
  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedValue(value), delayMs);
    return () => window.clearTimeout(timeout);
  }, [delayMs, value]);
  return debouncedValue;
}
```

**Step 4: Separate displayed and queried search**

In overlay:

- Continue showing `filters.search` immediately.
- Derive `querySearch = useDebouncedValue(filters.search, 250)`.
- Use `querySearch` only for `useWorkItems().filters.searchText`.
- Keep board highlight search immediate unless profiling shows it expensive.

Do not use `useDeferredValue` as network debounce; it does not guarantee request coalescing.

**Step 5: Verify**

Run:

```bash
pnpm test src/common/hooks/use-debounced-value.test.ts
pnpm test
pnpm ts-check
pnpm lint
```

Expected: all PASS. Manually type quickly and confirm only settled search triggers board loading.

**Step 6: Commit**

```bash
git add src/common/hooks/use-debounced-value.ts src/common/hooks/use-debounced-value.test.ts src/features/work-item/ui-azure-board-overlay/index.tsx
git commit -m "perf(azure-board): debounce remote search"
```

### Task 3: Narrow Project-Specific State and Query Ownership

**Files:**
- Create: `src/features/work-item/ui-azure-board-overlay/project-content.tsx`
- Modify: `src/features/work-item/ui-azure-board-overlay/index.tsx:218-430,474-649`
- Modify: `src/stores/azure-board.ts:11-28,108-113`
- Test: `src/stores/azure-board.test.ts`

**Step 1: Add stable store defaults**

Export stable defaults from store:

```ts
export const DEFAULT_AZURE_BOARD_FILTERS: AzureBoardFilters = {
  search: '',
  workItemTypes: [],
  assignees: [],
  iterations: [],
  tags: [],
};

export const EMPTY_AZURE_BOARD_COLUMN_IDS: string[] = [];
```

Do not return fresh arrays or objects from Zustand selectors.

**Step 2: Add selector behavior tests**

Test current project fallback and isolation through existing store APIs. Do not test React rerender counts without established renderer infrastructure.

**Step 3: Extract `AzureBoardProjectContent`**

Pass one validated `project` object plus refresh metadata/actions. Move into child:

- current project filter lookup
- current project collapsed-column lookup
- work-item/iteration/column/detail/linked-item queries
- board model construction
- selection and related-bug state
- board/details rendering

Subscribe with primitive or stable-source selectors:

```ts
const projectFilters = useAzureBoardStore(
  (state) => state.filtersByProject[project.id],
) ?? DEFAULT_AZURE_BOARD_FILTERS;

const collapsedColumnIds = useAzureBoardStore(
  (state) => state.collapsedColumnIdsByProject[project.id],
) ?? EMPTY_AZURE_BOARD_COLUMN_IDS;
```

Keep actions in separate selectors.

**Step 4: Reduce root overlay responsibility**

Root `AzureBoardOverlay` should own only:

- portal and `FocusLock`
- close keyboard command
- configured project list and selected project
- top-level empty state
- project switch reset by keying content: `<AzureBoardProjectContent key={project.id} ... />`

Project key replaces four manual reset calls when switching projects. Verify whether refresh timestamp should remain global or reset per project; preserve current reset behavior unless product requirements say otherwise.

**Step 5: Verify**

Run:

```bash
pnpm test src/stores/azure-board.test.ts
pnpm test
pnpm ts-check
pnpm lint
```

Expected: all PASS. Manually verify project switch, filters, collapsed columns, selected details, refresh, and persisted split width.

**Step 6: Commit**

```bash
git add src/features/work-item/ui-azure-board-overlay/index.tsx src/features/work-item/ui-azure-board-overlay/project-content.tsx src/stores/azure-board.ts src/stores/azure-board.test.ts
git commit -m "refactor(azure-board): isolate project content"
```

### Task 4: Consolidate Board Model Derivation

**Files:**
- Create: `src/features/work-item/ui-azure-board-overlay/build-board-model.ts`
- Create: `src/features/work-item/ui-azure-board-overlay/build-board-model.test.ts`
- Modify: `src/features/work-item/ui-azure-board-overlay/project-content.tsx`
- Modify: `src/features/work-item/ui-work-item-board/utils.ts:34-60`

**Step 1: Write model tests**

Cover:

- persisted filter values remain available as options
- assignees and tags deduplicate case-insensitively
- assignee/tag filters produce correct visible items
- current iteration option placement
- linked child IDs deduplicate
- progress counts only bugs and recognizes closed/done
- related bug lookup follows selected story

Use small work-item fixtures. Assert complete model output where practical.

**Step 2: Run tests to verify failure**

Run: `pnpm test src/features/work-item/ui-azure-board-overlay/build-board-model.test.ts`

Expected: FAIL because builder does not exist.

**Step 3: Implement pure model builder**

```ts
export function buildAzureBoardModel({
  metadataItems,
  items,
  childWorkItems,
  iterations,
  filters,
  bugsForWorkItemId,
}: BuildAzureBoardModelParams) {
  const childById = new Map(childWorkItems.map((item) => [item.id, item]));
  const visibleItems = items.filter(/* assignee and tag predicates */);
  const stories = visibleItems.filter(
    (item) => item.fields.workItemType.toLocaleLowerCase() === 'user story',
  );

  // Build options, linked IDs, progress, and related bugs in bounded passes.
  return {
    visibleItems,
    types,
    assignees,
    tagOptions,
    iterationOptions,
    storyLinkedWorkItemIds,
    childBugProgressByWorkItemId,
    bugsForWorkItem,
    relatedBugs,
  };
}
```

Avoid DOM access. Keep `workItemSummary()` in related bug presentation.

**Step 4: Replace inline derivation**

Call builder from project content. Do not add blanket `useMemo`; React Compiler is enabled. If builder appears in profiler after earlier fixes, add one memo around complete model, not separate memo calls for every field.

**Step 5: Verify**

Run:

```bash
pnpm test src/features/work-item/ui-azure-board-overlay/build-board-model.test.ts
pnpm test src/features/work-item/ui-work-item-board/utils.test.ts
pnpm test
pnpm ts-check
pnpm lint
```

Expected: all PASS.

**Step 6: Commit**

```bash
git add src/features/work-item/ui-azure-board-overlay/build-board-model.ts src/features/work-item/ui-azure-board-overlay/build-board-model.test.ts src/features/work-item/ui-azure-board-overlay/project-content.tsx src/features/work-item/ui-work-item-board/utils.ts
git commit -m "refactor(azure-board): consolidate board model"
```

### Task 5: Gate Editorial Preview Queries

**Files:**
- Modify: `src/features/work-item/ui-work-item-preview/index.tsx:49-104`
- Modify: `src/hooks/use-work-items.ts` query hook parameter types for comments/test cases if needed
- Test: relevant hook tests or new pure enablement tests beside `ui-work-item-preview`

**Step 1: Write query-enablement tests**

Extract a pure policy if component test infrastructure is absent:

```ts
export function getPreviewQueryPolicy({
  isEditorial,
  activeTab,
}: {
  isEditorial: boolean;
  activeTab: DetailsTab;
}) {
  return {
    loadTestCases: !isEditorial,
    loadComments: activeTab === 'comments',
  };
}
```

Test editorial test cases are disabled and comments enable when first requested. Preserve comments after first open if returning to tab should be instant.

**Step 2: Run test to verify failure**

Run focused test path.

Expected: FAIL before policy implementation.

**Step 3: Add hook `enabled` options**

Extend relevant hooks without changing existing callers:

```ts
enabled?: boolean;
```

Combine caller intent with required IDs in each query's `enabled` expression.

**Step 4: Apply preview policy**

- Move `isEditorial` and active-tab state before query calls.
- Never request test cases in editorial mode.
- Track whether comments tab has ever opened; fetch comments only after first open unless `showCommentsAside` requires them immediately.
- Keep state and related-work-item queries eager.

**Step 5: Verify**

Run:

```bash
pnpm test
pnpm ts-check
pnpm lint
```

Expected: all PASS. Manually verify normal preview test cases/comments and editorial comments behavior.

**Step 6: Commit**

```bash
git add src/features/work-item/ui-work-item-preview/index.tsx src/hooks/use-work-items.ts src/features/work-item/ui-work-item-preview/*.test.ts
git commit -m "perf(work-item): gate hidden preview queries"
```

### Task 6: Profile and Remove Remaining Noise

**Files:**
- Modify only files proven hot by profiling
- Do not modify changelog files

**Step 1: Capture baseline**

Using React DevTools Profiler, record:

1. Drag divider for three seconds.
2. Type a ten-character search quickly.
3. Open five board cards.
4. Open related bugs and one bug.

Record commit counts and slowest components before Tasks 1-5 if possible, or compare against current branch baseline.

**Step 2: Capture optimized profile**

Repeat identical interactions.

Expected:

- Divider drag does not rerender `WorkItemBoard` or `WorkItemPreview` per mousemove.
- Search launches one settled request rather than one per character.
- Project-unrelated store changes do not rerender content.
- Editorial preview does not request test cases.

**Step 3: Add narrow memoization only if proven necessary**

If profiler still shows unchanged board cards rerendering materially, extract one `AzureBoardBoardPane` boundary. Prefer React Compiler output before manual `memo`, `useMemo`, or `useCallback`.

Do not memoize cheap header buttons or every callback.

**Step 4: Run required repository verification**

Run in required order:

```bash
pnpm install
pnpm test
pnpm lint --fix
pnpm ts-check
pnpm lint
```

Expected: all PASS. Node engine should be Node 20.18.x; report warning if environment differs.

**Step 5: Final review**

Request code review focused on:

- stale query behavior during project switches
- resize listener cleanup
- Zustand selector stability
- search debounce cancellation
- normal versus editorial preview behavior
- regression of related-bug focus/scroll fix

**Step 6: Commit proven follow-up only**

If profiling required code changes:

```bash
git add <only-profile-proven-files>
git commit -m "perf(azure-board): reduce remaining render churn"
```

If no code changes are needed, do not create an empty commit.
