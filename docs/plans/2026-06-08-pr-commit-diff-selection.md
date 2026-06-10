# PR Commit Diff Selection Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let users click a commit in the PR commits tab to see its changed files and diffs, mirroring the existing files tab layout.

**Architecture:** Add `getCommitChanges` + `getFileContentAtCommit` backend APIs (Azure DevOps Git Commits API). Extend `PrViewState` in the navigation store with `selectedCommitId` and `selectedCommitFile`. Refactor commits tab into a three-column layout: commit list (left) → file tree (middle, shown when commit selected) → diff view (right, shown when file selected). Reuse existing `DiffFileTree` and `FileDiffContent` components.

**Tech Stack:** Azure DevOps REST API v7.0, Electron IPC, React Query, Zustand, existing diff components

---

### Task 1: Backend — `getCommitChanges` service function

**Files:**
- Modify: `electron/services/azure-devops-service.ts` (after `getPullRequestChanges`, ~line 2533)

**Step 1: Add `getCommitChanges` function**

Insert after `getPullRequestChanges` (after line 2533):

```typescript
export async function getCommitChanges(params: {
  providerId: string;
  projectId: string;
  repoId: string;
  commitId: string;
}): Promise<AzureDevOpsFileChange[]> {
  const { authHeader, orgName } = await getProviderAuth(params.providerId);

  const url = `https://dev.azure.com/${orgName}/${params.projectId}/_apis/git/repositories/${params.repoId}/commits/${params.commitId}/changes?api-version=7.0`;

  const response = await fetch(url, {
    headers: { Authorization: authHeader },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get commit changes: ${error}`);
  }

  const data: { changeCounts: Record<string, number>; changes: ChangeResponse[] } =
    await response.json();

  return data.changes
    .filter((change) => change.item?.path)
    .map((change) => ({
      path: change.item!.path,
      changeType: mapChangeType(change.changeType),
      originalPath: change.sourceServerItem,
    }));
}
```

Note: The Azure DevOps Commits API returns `{ changes: ChangeResponse[] }` (not `changeEntries` like the iterations API). The `ChangeResponse` interface already exists (line ~1662) and matches. The `sourceServerItem` field maps to `originalPath` for renames.

**Step 2: Add `getFileContentAtCommit` function**

Insert right after `getCommitChanges`:

```typescript
export async function getFileContentAtCommit(params: {
  providerId: string;
  projectId: string;
  repoId: string;
  commitId: string;
  filePath: string;
  version: 'current' | 'parent';
}): Promise<string> {
  const { authHeader, orgName } = await getProviderAuth(params.providerId);

  let versionId = params.commitId;

  if (params.version === 'parent') {
    // Get parent commit ID
    const commitUrl = `https://dev.azure.com/${orgName}/${params.projectId}/_apis/git/repositories/${params.repoId}/commits/${params.commitId}?api-version=7.0`;
    const commitResponse = await fetch(commitUrl, {
      headers: { Authorization: authHeader },
    });
    if (!commitResponse.ok) {
      return '';
    }
    const commitData: { parents?: string[] } = await commitResponse.json();
    if (!commitData.parents?.length) {
      return ''; // Initial commit, no parent
    }
    versionId = commitData.parents[0];
  }

  const contentUrl = `https://dev.azure.com/${orgName}/${params.projectId}/_apis/git/repositories/${params.repoId}/items?path=${encodeURIComponent(params.filePath)}&versionDescriptor.version=${encodeURIComponent(versionId)}&versionDescriptor.versionType=commit&api-version=7.0`;

  const response = await fetch(contentUrl, {
    headers: { Authorization: authHeader },
  });

  if (!response.ok) {
    if (response.status === 404) {
      return ''; // File doesn't exist at this version (new or deleted)
    }
    const error = await response.text();
    throw new Error(`Failed to get file content at commit: ${error}`);
  }

  return response.text();
}
```

**Step 3: Export from service**

Both functions are already `export`ed in the code above. Verify they're importable.

**Step 4: Commit**

```bash
git add electron/services/azure-devops-service.ts
git commit -m "feat(azure): add getCommitChanges and getFileContentAtCommit APIs"
```

---

### Task 2: IPC + Preload + API wiring

**Files:**
- Modify: `electron/ipc/handlers.ts` (~line 140 for import, ~line 2765 for handlers)
- Modify: `electron/preload.ts` (~line 375)
- Modify: `src/lib/api.ts` (~line 710 for types, ~line 1694 for fallbacks)

**Step 1: Add import in handlers.ts**

At the import block (~line 140), add `getCommitChanges` and `getFileContentAtCommit` to the import from azure-devops-service:

```typescript
  getCommitChanges,
  getFileContentAtCommit,
```

**Step 2: Add IPC handlers in handlers.ts**

After the `azureDevOps:getPullRequestChanges` handler (~line 2765), add:

```typescript
  ipcMain.handle(
    'azureDevOps:getCommitChanges',
    (
      _,
      params: {
        providerId: string;
        projectId: string;
        repoId: string;
        commitId: string;
      },
    ) => getCommitChanges(params),
  );

  ipcMain.handle(
    'azureDevOps:getFileContentAtCommit',
    (
      _,
      params: {
        providerId: string;
        projectId: string;
        repoId: string;
        commitId: string;
        filePath: string;
        version: 'current' | 'parent';
      },
    ) => getFileContentAtCommit(params),
  );
```

**Step 3: Add preload bridge in preload.ts**

After `getPullRequestChanges` (~line 381), add:

```typescript
    getCommitChanges: (params: {
      providerId: string;
      projectId: string;
      repoId: string;
      commitId: string;
    }) => ipcRenderer.invoke('azureDevOps:getCommitChanges', params),
    getFileContentAtCommit: (params: {
      providerId: string;
      projectId: string;
      repoId: string;
      commitId: string;
      filePath: string;
      version: 'current' | 'parent';
    }) => ipcRenderer.invoke('azureDevOps:getFileContentAtCommit', params),
```

**Step 4: Add type declarations in api.ts**

After `getPullRequestChanges` type (~line 710), add:

```typescript
    getCommitChanges: (params: {
      providerId: string;
      projectId: string;
      repoId: string;
      commitId: string;
    }) => Promise<AzureDevOpsFileChange[]>;
    getFileContentAtCommit: (params: {
      providerId: string;
      projectId: string;
      repoId: string;
      commitId: string;
      filePath: string;
      version: 'current' | 'parent';
    }) => Promise<string>;
```

**Step 5: Add fallbacks in api.ts**

In the fallback section (~line 1694), add:

```typescript
        getCommitChanges: async () => [],
        getFileContentAtCommit: async () => '',
```

**Step 6: Commit**

```bash
git add electron/ipc/handlers.ts electron/preload.ts src/lib/api.ts
git commit -m "feat(ipc): wire getCommitChanges and getFileContentAtCommit through IPC"
```

---

### Task 3: React Query hooks

**Files:**
- Modify: `src/hooks/use-pull-requests.ts` (after `usePullRequestChanges`, ~line 237)

**Step 1: Add `useCommitChanges` hook**

After `usePullRequestChanges` (~line 237):

```typescript
export function useCommitChanges(
  projectId: string,
  commitId: string | null,
) {
  const repoInfo = useProjectRepoInfo(projectId);

  return useQuery<AzureDevOpsFileChange[]>({
    queryKey: ['commit-changes', projectId, commitId],
    queryFn: () =>
      api.azureDevOps.getCommitChanges({
        providerId: repoInfo!.providerId,
        projectId: repoInfo!.projectId,
        repoId: repoInfo!.repoId,
        commitId: commitId!,
      }),
    enabled: !!repoInfo && !!commitId,
    staleTime: 300_000, // 5 min — commit changes are immutable
  });
}
```

**Step 2: Add `useCommitFileContent` hook**

Right after `useCommitChanges`:

```typescript
export function useCommitFileContent(
  projectId: string,
  commitId: string | null,
  filePath: string | null,
  version: 'current' | 'parent',
) {
  const repoInfo = useProjectRepoInfo(projectId);

  return useQuery<string>({
    queryKey: ['commit-file-content', projectId, commitId, filePath, version],
    queryFn: () =>
      api.azureDevOps.getFileContentAtCommit({
        providerId: repoInfo!.providerId,
        projectId: repoInfo!.projectId,
        repoId: repoInfo!.repoId,
        commitId: commitId!,
        filePath: filePath!,
        version,
      }),
    enabled: !!repoInfo && !!commitId && !!filePath,
    staleTime: 300_000,
  });
}
```

**Step 3: Commit**

```bash
git add src/hooks/use-pull-requests.ts
git commit -m "feat(hooks): add useCommitChanges and useCommitFileContent query hooks"
```

---

### Task 4: Navigation store — commit selection state

**Files:**
- Modify: `src/stores/navigation.ts`

**Step 1: Extend `PrViewState` interface** (~line 61)

```typescript
interface PrViewState {
  selectedFile: string | null;
  activeTab: PrDetailTab;
  selectedCommitId: string | null;
  selectedCommitFile: string | null;
}
```

**Step 2: Extend `defaultPrViewState`** (~line 66)

```typescript
const defaultPrViewState: PrViewState = {
  selectedFile: null,
  activeTab: 'overview',
  selectedCommitId: null,
  selectedCommitFile: null,
};
```

**Step 3: Add store actions to the interface** (after `setPrActiveTab` ~line 229)

```typescript
  setPrSelectedCommit: (prKey: string, commitId: string | null) => void;
  setPrSelectedCommitFile: (prKey: string, filePath: string | null) => void;
```

**Step 4: Add store action implementations** (after `setPrActiveTab` implementation, ~line 532)

```typescript
      setPrSelectedCommit: (prKey, commitId) =>
        set((state) => ({
          prState: {
            ...state.prState,
            [prKey]: {
              ...defaultPrViewState,
              ...state.prState[prKey],
              selectedCommitId: commitId,
              selectedCommitFile: null, // Reset file selection when commit changes
            },
          },
        })),

      setPrSelectedCommitFile: (prKey, filePath) =>
        set((state) => ({
          prState: {
            ...state.prState,
            [prKey]: {
              ...defaultPrViewState,
              ...state.prState[prKey],
              selectedCommitFile: filePath,
            },
          },
        })),
```

**Step 5: Extend `usePrDetailState` hook** (~line 1061)

Add these selectors and callbacks inside the hook, before the return:

```typescript
  const selectedCommitId = useStore(
    (state) => state.prState[prKey]?.selectedCommitId ?? null,
  );
  const selectedCommitFile = useStore(
    (state) => state.prState[prKey]?.selectedCommitFile ?? null,
  );
  const setPrSelectedCommitAction = useStore(
    (state) => state.setPrSelectedCommit,
  );
  const setPrSelectedCommitFileAction = useStore(
    (state) => state.setPrSelectedCommitFile,
  );

  const setSelectedCommit = useCallback(
    (commitId: string | null) => setPrSelectedCommitAction(prKey, commitId),
    [prKey, setPrSelectedCommitAction],
  );

  const setSelectedCommitFile = useCallback(
    (filePath: string | null) =>
      setPrSelectedCommitFileAction(prKey, filePath),
    [prKey, setPrSelectedCommitFileAction],
  );
```

Update the return to include the new fields:

```typescript
  return {
    selectedFile,
    activeTab,
    selectedCommitId,
    selectedCommitFile,
    setSelectedFile,
    setActiveTab,
    setSelectedCommit,
    setSelectedCommitFile,
    clearState,
  };
```

**Step 6: Commit**

```bash
git add src/stores/navigation.ts
git commit -m "feat(store): add selectedCommitId and selectedCommitFile to PR navigation state"
```

---

### Task 5: Update `PrCommits` component — make commits selectable

**Files:**
- Modify: `src/features/pull-request/ui-pr-commits/index.tsx`

**Step 1: Rewrite the component to accept selection props**

Replace the full file content with:

```tsx
import type { AzureDevOpsCommit } from '@/lib/api';
import { formatRelativeTime } from '@/lib/time';
import clsx from 'clsx';

export function PrCommits({
  commits,
  selectedCommitId,
  onSelectCommit,
  bottomPadding = 0,
}: {
  commits: AzureDevOpsCommit[];
  selectedCommitId?: string | null;
  onSelectCommit?: (commitId: string | null) => void;
  bottomPadding?: number;
}) {
  if (commits.length === 0) {
    return (
      <div className="text-ink-3 flex h-full items-center justify-center text-sm">
        No commits
      </div>
    );
  }

  return (
    <div
      className="h-full overflow-y-auto p-4"
      style={bottomPadding > 0 ? { paddingBottom: bottomPadding } : undefined}
    >
      <div className="relative pl-6">
        {/* Timeline line */}
        <div className="bg-glass-medium absolute top-0 bottom-0 left-[7px] w-0.5" />

        {commits.map((commit, index) => {
          const isFirst = index === 0;
          const isLast = index === commits.length - 1;
          const shortHash = commit.commitId.slice(0, 7);
          const message = commit.comment.split('\n')[0];
          const isSelected = selectedCommitId === commit.commitId;

          return (
            <div
              key={commit.commitId}
              className={clsx(
                'group relative flex cursor-pointer items-start gap-3 rounded-md px-2 py-2 transition-colors',
                isSelected
                  ? 'bg-acc/10 ring-acc/30 ring-1'
                  : 'hover:bg-bg-1/60',
              )}
              style={isLast ? undefined : { marginBottom: '4px' }}
              onClick={() => {
                if (onSelectCommit) {
                  onSelectCommit(
                    isSelected ? null : commit.commitId,
                  );
                }
              }}
            >
              {/* Dot */}
              <div className="absolute top-[11px] left-[-16px] z-10 flex -translate-x-1/2 items-center justify-center">
                {isFirst ? (
                  /* HEAD indicator — larger dot with ring */
                  <div className="border-acc bg-acc/30 h-3.5 w-3.5 rounded-full border-2" />
                ) : (
                  /* Regular commit dot */
                  <div
                    className={clsx(
                      'h-2 w-2 rounded-full',
                      isSelected ? 'bg-acc' : 'bg-bg-2',
                    )}
                  />
                )}
              </div>

              {/* Clip the timeline line above and below the dots */}
              {isFirst && (
                <div className="bg-bg-0 absolute top-0 left-[3px] h-[11px] w-1.5" />
              )}
              {isLast && (
                <div className="bg-bg-0 absolute bottom-0 left-[3px] h-[calc(100%-15px)] w-1.5" />
              )}

              {/* Commit info */}
              <div className="min-w-0 flex-1">
                <p className="text-ink-1 truncate text-sm">{message}</p>
                <div className="text-ink-3 mt-0.5 flex items-center gap-1.5 text-xs">
                  {commit.url ? (
                    <a
                      href={commit.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-ink-2 hover:text-acc-ink font-mono transition-colors hover:underline"
                      onClick={(e) => {
                        e.stopPropagation();
                        window.open(commit.url, '_blank');
                        e.preventDefault();
                      }}
                    >
                      {shortHash}
                    </a>
                  ) : (
                    <span className="text-ink-2 font-mono">{shortHash}</span>
                  )}
                  <span className="text-ink-4">·</span>
                  <span>{commit.author.name}</span>
                  <span className="text-ink-4">·</span>
                  <span>{formatRelativeTime(commit.author.date)}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

Key changes from original:
- Added `selectedCommitId` and `onSelectCommit` props
- Added `cursor-pointer` and click handler on commit rows
- Added selected state visual: `bg-acc/10 ring-acc/30 ring-1`
- Clicking selected commit deselects it (toggle)
- Dot turns accent color when selected
- Added `clsx` import

**Step 2: Commit**

```bash
git add src/features/pull-request/ui-pr-commits/index.tsx
git commit -m "feat(pr-commits): make commit rows selectable with visual highlight"
```

---

### Task 6: Create `PrCommitDiffView` component

**Files:**
- Create: `src/features/pull-request/ui-pr-commit-diff-view/index.tsx`

This component shows the file tree + diff for a selected commit. Reuses `DiffFileTree` and `FileDiffContent`.

**Step 1: Create the component**

```tsx
import clsx from 'clsx';
import { Loader2 } from 'lucide-react';
import { useMemo } from 'react';

import {
  DiffFileTree,
  FileDiffContent,
  normalizeAzureChangeType,
} from '@/features/common/ui-file-diff';
import type { DiffFile } from '@/features/common/ui-file-diff';
import { useHorizontalResize } from '@/hooks/use-horizontal-resize';
import {
  useCommitChanges,
  useCommitFileContent,
} from '@/hooks/use-pull-requests';

export function PrCommitDiffView({
  projectId,
  commitId,
  selectedFile,
  onSelectFile,
  bottomPadding = 0,
}: {
  projectId: string;
  commitId: string;
  selectedFile: string | null;
  onSelectFile: (filePath: string | null) => void;
  bottomPadding?: number;
}) {
  const { data: files = [], isLoading: isFilesLoading } = useCommitChanges(
    projectId,
    commitId,
  );

  const selectedFileData = files.find((f) => f.path === selectedFile);

  const { data: parentContent = '', isLoading: isParentLoading } =
    useCommitFileContent(projectId, commitId, selectedFile, 'parent');
  const { data: currentContent = '', isLoading: isCurrentLoading } =
    useCommitFileContent(projectId, commitId, selectedFile, 'current');

  const diffFiles: DiffFile[] = useMemo(
    () =>
      files.map((f) => ({
        path: f.path,
        status: normalizeAzureChangeType(f.changeType),
        originalPath: f.originalPath,
      })),
    [files],
  );

  const [fileTreeWidth, setFileTreeWidth] = useState(220);
  const { containerRef, isDragging, handleMouseDown } = useHorizontalResize({
    initialWidth: fileTreeWidth,
    minWidth: 160,
    maxWidthFraction: 0.4,
    onWidthChange: setFileTreeWidth,
  });

  if (isFilesLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="text-ink-3 h-5 w-5 animate-spin" />
      </div>
    );
  }

  if (files.length === 0) {
    return (
      <div className="text-ink-3 flex h-full items-center justify-center text-sm">
        No changes in this commit
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={clsx('flex h-full', isDragging && 'select-none')}
      style={bottomPadding > 0 ? { paddingBottom: bottomPadding } : undefined}
    >
      {/* File tree */}
      <div
        className="panel-edge-shadow-r relative flex shrink-0 flex-col"
        style={{ width: fileTreeWidth }}
      >
        <DiffFileTree
          files={diffFiles}
          selectedPath={selectedFile}
          onSelectFile={onSelectFile}
        />
        {/* Resize handle */}
        <div
          onMouseDown={handleMouseDown}
          className={clsx(
            'hover:bg-acc/50 absolute top-0 right-0 h-full w-1 cursor-col-resize transition-colors',
            isDragging && 'bg-acc/50',
          )}
        />
      </div>

      {/* Diff view */}
      <div className="min-w-0 flex-1 overflow-hidden">
        {selectedFile && selectedFileData ? (
          <FileDiffContent
            file={{
              path: selectedFileData.path,
              status: normalizeAzureChangeType(selectedFileData.changeType),
              originalPath: selectedFileData.originalPath,
            }}
            oldContent={parentContent}
            newContent={currentContent}
            isLoading={isParentLoading || isCurrentLoading}
            headerClassName="h-[40px] shrink-0"
          />
        ) : (
          <div className="text-ink-3 flex h-full items-center justify-center">
            Select a file to view changes
          </div>
        )}
      </div>
    </div>
  );
}
```

**Important:** Add `useState` to the import from React:

```typescript
import { useMemo, useState } from 'react';
```

**Step 2: Commit**

```bash
git add src/features/pull-request/ui-pr-commit-diff-view/index.tsx
git commit -m "feat(pr): add PrCommitDiffView component for commit-scoped file diffs"
```

---

### Task 7: Wire commits tab split layout in `PrDetail`

**Files:**
- Modify: `src/features/pull-request/ui-pr-detail/index.tsx`

**Step 1: Add import for new component** (~line 38)

```typescript
import { PrCommitDiffView } from '../ui-pr-commit-diff-view';
```

**Step 2: Destructure new state from hook** (~line 55)

Change:

```typescript
  const { selectedFile, activeTab, setSelectedFile, setActiveTab } =
    usePrDetailState(projectId, prId);
```

To:

```typescript
  const {
    selectedFile,
    activeTab,
    selectedCommitId,
    selectedCommitFile,
    setSelectedFile,
    setActiveTab,
    setSelectedCommit,
    setSelectedCommitFile,
  } = usePrDetailState(projectId, prId);
```

**Step 3: Replace commits tab content** (~line 402-409)

Replace:

```tsx
        {activeTab === 'commits' &&
          (isCommitsLoading ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="text-ink-3 h-5 w-5 animate-spin" />
            </div>
          ) : (
            <PrCommits commits={commits} bottomPadding={bottomPadding} />
          ))}
```

With:

```tsx
        {activeTab === 'commits' &&
          (isCommitsLoading ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="text-ink-3 h-5 w-5 animate-spin" />
            </div>
          ) : (
            <div
              className="flex h-full"
              style={
                bottomPadding > 0
                  ? { paddingBottom: bottomPadding }
                  : undefined
              }
            >
              {/* Commit list — fixed width left panel */}
              <div
                className={clsx(
                  'shrink-0 overflow-hidden',
                  selectedCommitId
                    ? 'panel-edge-shadow-r w-[320px]'
                    : 'w-full',
                )}
              >
                <PrCommits
                  commits={commits}
                  selectedCommitId={selectedCommitId}
                  onSelectCommit={setSelectedCommit}
                />
              </div>

              {/* Commit diff view — fills remaining space */}
              {selectedCommitId && (
                <div className="min-w-0 flex-1 overflow-hidden">
                  <PrCommitDiffView
                    projectId={projectId}
                    commitId={selectedCommitId}
                    selectedFile={selectedCommitFile}
                    onSelectFile={setSelectedCommitFile}
                  />
                </div>
              )}
            </div>
          ))}
```

**Step 4: Run checks**

```bash
pnpm install
pnpm test
pnpm lint --fix
pnpm ts-check
pnpm lint
```

**Step 5: Commit**

```bash
git add src/features/pull-request/ui-pr-detail/index.tsx
git commit -m "feat(pr): wire commit selection to split layout with file tree and diff"
```

---

### Summary of layout behavior

```
┌─────────────────────────────────────────────────────────────┐
│ PR Header                                                   │
├─────────┬──────────┬────────────┬───────────────────────────┤
│ Overview │  Files   │  Commits ●│                           │
├─────────┴──────────┴────────────┴───────────────────────────┤
│                                                             │
│  No commit selected:                                        │
│  ┌─────────────── full width ───────────────────┐           │
│  │ Commit timeline list                         │           │
│  └──────────────────────────────────────────────┘           │
│                                                             │
│  Commit selected:                                           │
│  ┌──── 320px ────┬── file tree ──┬──── diff ────┐           │
│  │ ● feat: xyz   │ /src/foo.ts   │ unified diff │           │
│  │   fix: abc    │ /src/bar.ts   │ view         │           │
│  │   chore: 123  │               │              │           │
│  └───────────────┴───────────────┴──────────────┘           │
└─────────────────────────────────────────────────────────────┘
```

- No commit selected → commit list fills full width (same as before)
- Commit selected → list narrows to 320px, file tree + diff appear right
- Click selected commit again → deselects, returns to full-width list
- Switching tabs clears commit selection (handled by existing tab switch logic)
- File tree + diff reuse existing `DiffFileTree` and `FileDiffContent`
- Commit changes cached 5min (immutable data)
