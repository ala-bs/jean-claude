# File Explorer Diff Integration — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rework the task-details file explorer pane to show diff status per file, add a "hide unchanged" filter, display a summary strip with change counts, and replace the plain code viewer with a Code/Diff toggle that can show unified diffs for changed files.

**Architecture:** The existing `FileExplorerPane` currently browses the live filesystem and shows syntax-highlighted file content. We'll enrich it by overlaying worktree diff data (from `useWorktreeDiff`) onto the existing directory tree. Changed files get status badges (M/A/D) and +N/−N counts. The content viewer gains a Code/Diff segmented control — "Code" keeps current shiki viewer, "Diff" uses the existing `FileDiffContent` component. A summary strip and "changed only" filter button are added to the tree panel header. The file explorer pane width defaults increase to accommodate the richer content (the pane now takes 65% of the viewport width when open, matching the design's 88% overlay feel).

**Tech Stack:** React, Zustand (navigation store), TanStack Query, existing `DiffView`/`FileDiffContent` components, Lucide icons, Tailwind CSS.

**Design reference:** `/tmp/jean-claude/project/task-details file explorer.html` + `explorer-views.jsx` + `explorer-data.jsx`

---

## Summary of Changes

From the design, the key improvements to implement:

1. **Tree: Status badges** — Each changed file shows a single-letter badge (M/A/D) color-coded (blue-Modified, green-Added, red-Deleted) + optional `+N/−N` line counts
2. **Tree: Folder change counts** — Collapsed folders show a pill badge with number of changed files inside
3. **Tree: Summary strip** — Below tree header: `N changed · +X · −Y`
4. **Tree: Hide unchanged filter** — Toggle button in tree header to show only changed files (and their parent dirs)
5. **Tree: Visual dimming** — Unchanged files appear dimmer than changed files
6. **Content: Code/Diff toggle** — Segmented control in content header to switch between Code view and Diff view
7. **Content: File path + status in header** — Show relative path, status badge, and +/- counts
8. **Pane: Larger default width** — File explorer pane default increases to ~65% viewport since it now serves as a richer diff-aware browser
9. **Bottom status bar** — Branch name, total changed/adds/dels, file type, encoding

---

## Task 1: Add Diff Stats to Backend API

**Files:**
- Modify: `electron/services/worktree-service.ts` (WorktreeDiffFile interface + getWorktreeDiff function)
- Modify: `electron/preload.ts` (pass-through, if needed)
- Modify: `src/lib/api.ts` (WorktreeDiffFile type)

The design shows `+N/−N` per file. Currently `WorktreeDiffFile` only has `path` and `status`. We need to add `additions` and `deletions` counts.

**Step 1: Add `additions`/`deletions` to `WorktreeDiffFile` in the backend**

In `electron/services/worktree-service.ts`, update the interface:

```typescript
export interface WorktreeDiffFile {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  additions: number;
  deletions: number;
}
```

In `getWorktreeDiff`, after collecting all files, run `git diff --numstat <baseCommit>` to get per-file line counts and merge them into the files map. For untracked files (from `git status`), count lines with `wc -l` or read the file content.

Specifically, after the existing `git diff --name-status` call, add:

```typescript
// Get per-file line counts
const { stdout: numstatOutput } = await execAsync(
  `git diff --numstat ${baseCommit}`,
  { cwd: worktreePath, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 },
);

const numstatMap = new Map<string, { additions: number; deletions: number }>();
for (const line of numstatOutput.split('\n')) {
  if (!line.trim()) continue;
  const [adds, dels, filePath] = line.split('\t');
  // Binary files show '-' for adds/dels
  numstatMap.set(filePath, {
    additions: adds === '-' ? 0 : parseInt(adds, 10),
    deletions: dels === '-' ? 0 : parseInt(dels, 10),
  });
}
```

Then when building `filesMap`, attach the counts:

```typescript
const stats = numstatMap.get(filePath) ?? { additions: 0, deletions: 0 };
filesMap.set(filePath, { path: filePath, status, additions: stats.additions, deletions: stats.deletions });
```

For untracked files (from porcelain), set `additions` to the line count and `deletions` to 0. We can count lines by reading the file:

```typescript
try {
  const { stdout: content } = await execAsync(
    `wc -l < "${escapeForShell(filePath)}"`,
    { cwd: worktreePath, encoding: 'utf-8' },
  );
  const lineCount = parseInt(content.trim(), 10) || 0;
  filesMap.set(filePath, { path: filePath, status: 'added', additions: lineCount, deletions: 0 });
} catch {
  filesMap.set(filePath, { path: filePath, status: 'added', additions: 0, deletions: 0 });
}
```

**Step 2: Update the renderer-side type**

In `src/lib/api.ts`, update:

```typescript
export interface WorktreeDiffFile {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  additions: number;
  deletions: number;
}
```

**Step 3: Update the shared `DiffFile` type**

In `src/features/common/ui-file-diff/types.ts`, add optional counts:

```typescript
export interface DiffFile {
  path: string;
  status: DiffFileStatus;
  originalPath?: string;
  additions?: number;
  deletions?: number;
}
```

**Step 4: Run `pnpm ts-check` to verify types compile**

---

## Task 2: Add `viewMode` and `hideUnchanged` to File Explorer State

**Files:**
- Modify: `src/stores/navigation.ts`

**Step 1: Extend `FileExplorerState` interface**

```typescript
interface FileExplorerState {
  selectedFilePath: string | null;
  expandedDirs: Set<string>;
  viewMode: 'code' | 'diff';
  hideUnchanged: boolean;
}
```

Update the default:

```typescript
const defaultFileExplorerState: FileExplorerState = {
  selectedFilePath: null,
  expandedDirs: new Set<string>(),
  viewMode: 'code',
  hideUnchanged: false,
};
```

**Step 2: Add actions to `NavigationState`**

```typescript
setFileExplorerViewMode: (taskId: string, mode: 'code' | 'diff') => void;
setFileExplorerHideUnchanged: (taskId: string, hideUnchanged: boolean) => void;
```

Implement in the store's `set` calls (same pattern as `setFileExplorerSelectedFile`).

**Step 3: Extend `useTaskFileExplorerState` hook**

Add `viewMode`, `hideUnchanged`, `setViewMode`, `toggleHideUnchanged` to the returned object.

**Step 4: Run `pnpm ts-check`**

---

## Task 3: Rework the File Tree with Diff Awareness

**Files:**
- Modify: `src/features/task/ui-task-panel/file-explorer-pane/file-tree.tsx`

The existing `FileTree` loads directory listings lazily. We overlay diff data to show status indicators.

**Step 1: Add diff-related props to `FileTree`**

```typescript
export function FileTree({
  rootPath,
  projectRoot,
  selectedFilePath,
  onSelectFile,
  expandedDirs,
  onToggleDir,
  commentCountsByFile,
  filterPaths,
  // New props:
  diffFiles,
  hideUnchanged,
}: {
  // ... existing props ...
  /** Map of relative path -> diff info for changed files */
  diffFiles?: Map<string, { status: DiffFileStatus; additions: number; deletions: number }>;
  /** When true, only show files that have changes (and their ancestor dirs) */
  hideUnchanged?: boolean;
})
```

**Step 2: Update `FileTreeNode` to show status**

For file nodes, add after the file name:
- `+N/−N` counts (if available, compact mono text)
- Single-letter status badge (M/A/D) color-coded

Match the design's visual treatment:
- Changed files: `text-ink-1` (brighter)
- Unchanged files: `text-ink-3` (dimmer)
- Deleted files: strikethrough on the file name
- Status badge: small inline chip, styled like `getStatusIndicator` from `ui-file-diff/status-badge.tsx` but as a colored letter (M=blue/`text-blue-400`, A=green/`text-green-400`, D=red/`text-red-400`)

For directory nodes:
- When collapsed and has changed descendants, show a count pill (number of changed files)
- When expanded, bold the name if it has changed descendants

**Step 3: Implement `hideUnchanged` filtering**

When `hideUnchanged` is true and `diffFiles` is provided:
- Only render file entries that exist in `diffFiles`
- Only render directory entries that have at least one changed descendant
- Force-expand directories that contain changed files (so they're always visible)

This needs to happen at both `FileTree` level (root entries) and `DirectoryChildren` level (child entries).

To count changed descendants per directory, build a helper:

```typescript
function countChangedDescendants(dirPath: string, diffFiles: Map<string, ...>): number {
  let count = 0;
  const prefix = dirPath + '/';
  for (const path of diffFiles.keys()) {
    if (path.startsWith(prefix)) count++;
  }
  return count;
}
```

Pass `diffFiles` through to `FileTreeNode` and `DirectoryChildren`.

**Step 4: Run `pnpm ts-check`**

---

## Task 4: Add Summary Strip and Filter Button to Tree Header

**Files:**
- Modify: `src/features/task/ui-task-panel/file-explorer-pane/index.tsx`

**Step 1: Fetch worktree diff data in `FileExplorerPane`**

```typescript
import { useWorktreeDiff } from '@/hooks/use-worktree-diff';

// Inside FileExplorerPane:
const { data: diffData } = useWorktreeDiff(taskId, true);
```

**Step 2: Build diff files map and summary**

```typescript
const { diffFilesMap, summary } = useMemo(() => {
  const map = new Map<string, { status: DiffFileStatus; additions: number; deletions: number }>();
  let totalAdds = 0, totalDels = 0;
  for (const f of diffData?.files ?? []) {
    map.set(f.path, {
      status: normalizeWorktreeStatus(f.status),
      additions: f.additions,
      deletions: f.deletions,
    });
    totalAdds += f.additions;
    totalDels += f.deletions;
  }
  return {
    diffFilesMap: map,
    summary: { changed: map.size, adds: totalAdds, dels: totalDels },
  };
}, [diffData?.files]);
```

Note: The diff file paths from worktree are relative to the worktree root. The file tree paths from `useDirectoryListing` are absolute. You'll need to convert — strip `rootPath + '/'` prefix from absolute paths to get relative paths for lookup, or prepend `rootPath + '/'` to diff paths.

**Step 3: Add "hide unchanged" filter button to tree header**

In the header `<div>` that contains the Refresh and Close buttons, add a filter toggle:

```tsx
<IconButton
  onClick={() => toggleHideUnchanged()}
  size="sm"
  icon={<Filter />}
  tooltip={hideUnchanged ? 'Show all files' : 'Show only changed'}
  className={hideUnchanged ? 'bg-acc/20 text-acc-ink' : ''}
/>
```

Import `Filter` from lucide-react.

**Step 4: Add summary strip below header**

After the `<Separator />`, add:

```tsx
{summary.changed > 0 && (
  <div className="bg-bg-1 flex shrink-0 items-center gap-2.5 border-b border-[var(--line-soft)] px-3 py-1.5 font-mono text-[11px] text-ink-3">
    <span><span className="text-ink-1">{summary.changed}</span> changed</span>
    <span className="text-green-400">+{summary.adds}</span>
    <span className="text-red-400">−{summary.dels}</span>
  </div>
)}
```

**Step 5: Pass diff data to `FileTree`**

```tsx
<FileTree
  rootPath={rootPath}
  projectRoot={rootPath}
  selectedFilePath={selectedFilePath}
  onSelectFile={handleSelectFile}
  expandedDirs={expandedDirs}
  onToggleDir={handleToggleDir}
  diffFiles={diffFilesMap}
  hideUnchanged={hideUnchanged}
/>
```

**Step 6: Run `pnpm ts-check`**

---

## Task 5: Add Code/Diff View Toggle to Content Viewer

**Files:**
- Modify: `src/features/task/ui-task-panel/file-explorer-pane/index.tsx`
- Modify: `src/features/task/ui-task-panel/file-explorer-pane/file-content-viewer.tsx`

**Step 1: Add content header with path, status, and view mode toggle**

Create a new sub-component inside `file-content-viewer.tsx` or in a new file `content-header.tsx` in the same folder. This header shows:
- File icon + relative path (mono font)
- Status badge (if file has changes)
- +N/−N counts (if file has changes)
- Segmented control: Code | Diff (right-aligned)

```tsx
function ContentHeader({
  relativePath,
  status,
  additions,
  deletions,
  viewMode,
  onViewModeChange,
}: {
  relativePath: string;
  status?: DiffFileStatus;
  additions?: number;
  deletions?: number;
  viewMode: 'code' | 'diff';
  onViewModeChange: (mode: 'code' | 'diff') => void;
}) {
  const isChanged = !!status;
  return (
    <div className="bg-bg-1 flex shrink-0 items-center gap-2.5 border-b border-[var(--line)] px-3.5 py-2 min-h-[40px]">
      <File className="h-3.5 w-3.5 text-ink-3 shrink-0" />
      <span className="font-mono text-xs text-ink-1 truncate">{relativePath}</span>
      {status && <DiffStatusBadge status={status} />}
      {(additions || deletions) && (
        <span className="font-mono text-[10px] flex gap-1">
          {additions > 0 && <span className="text-green-400">+{additions}</span>}
          {deletions > 0 && <span className="text-red-400">−{deletions}</span>}
        </span>
      )}
      <div className="flex-1" />
      {isChanged && (
        <div className="inline-flex bg-bg-0 border border-[var(--line)] rounded p-0.5 gap-0.5">
          {(['code', 'diff'] as const).map(m => (
            <button
              key={m}
              onClick={() => onViewModeChange(m)}
              className={clsx(
                'px-2 py-0.5 rounded text-[11px] font-medium capitalize',
                viewMode === m ? 'bg-bg-3 text-ink-0' : 'text-ink-3 hover:text-ink-1',
              )}
            >
              {m}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```

**Step 2: Add diff content viewer**

When `viewMode === 'diff'` and the file has changes, render `FileDiffContent` (from `ui-file-diff`) instead of the shiki code viewer.

In `FileExplorerPane`, when a file is selected and it has a diff status:
- Fetch worktree file content via `useWorktreeFileContent(taskId, filePath, status)`
- If `viewMode === 'diff'`, render `FileDiffContent`
- If `viewMode === 'code'`, render existing `FileContentViewer`
- If file has no changes, always show Code view (ignore diff toggle)

Create a wrapper component `FileExplorerContentPane`:

```tsx
function FileExplorerContentPane({
  taskId,
  filePath,
  rootPath,
  diffInfo,
  viewMode,
  onViewModeChange,
}: {
  taskId: string;
  filePath: string;
  rootPath: string;
  diffInfo?: { status: DiffFileStatus; additions: number; deletions: number };
  viewMode: 'code' | 'diff';
  onViewModeChange: (mode: 'code' | 'diff') => void;
}) {
  const relativePath = filePath.startsWith(rootPath)
    ? filePath.slice(rootPath.length + 1)
    : filePath;
  const effectiveMode = diffInfo ? viewMode : 'code';

  return (
    <div className="flex h-full flex-col">
      <ContentHeader
        relativePath={relativePath}
        status={diffInfo?.status}
        additions={diffInfo?.additions}
        deletions={diffInfo?.deletions}
        viewMode={effectiveMode}
        onViewModeChange={onViewModeChange}
      />
      {effectiveMode === 'code' ? (
        <FileContentViewer filePath={filePath} />
      ) : (
        <ExplorerDiffViewer
          taskId={taskId}
          filePath={relativePath}
          status={diffInfo!.status}
        />
      )}
    </div>
  );
}
```

**Step 3: Create `ExplorerDiffViewer`**

This wraps `useWorktreeFileContent` + `FileDiffContent`:

```tsx
function ExplorerDiffViewer({
  taskId,
  filePath,
  status,
}: {
  taskId: string;
  filePath: string;
  status: DiffFileStatus;
}) {
  const worktreeStatus = status === 'added' ? 'added'
    : status === 'deleted' ? 'deleted'
    : 'modified';
  const { data, isLoading } = useWorktreeFileContent(taskId, filePath, worktreeStatus);

  const diffFile: DiffFile = { path: filePath, status };

  return (
    <FileDiffContent
      file={diffFile}
      oldContent={data?.oldContent ?? ''}
      newContent={data?.newContent ?? ''}
      isLoading={isLoading}
      isBinary={data?.isBinary}
    />
  );
}
```

**Step 4: Wire into `FileExplorerPane`**

Replace the existing `<FileContentViewer filePath={selectedFilePath} />` with `<FileExplorerContentPane>`, passing `taskId`, diff info from the map, view mode state from the store.

**Step 5: Run `pnpm ts-check`**

---

## Task 6: Update Pane Width and Polish

**Files:**
- Modify: `src/stores/navigation.ts` — increase default pane width
- Modify: `src/features/task/ui-task-panel/file-explorer-pane/index.tsx` — final polish

**Step 1: Increase default file explorer pane width**

The design shows the explorer taking ~88% of the window. For the right pane, increase:

```typescript
const DEFAULT_FILE_EXPLORER_PANE_WIDTH = 700; // was 300
const MIN_FILE_EXPLORER_PANE_WIDTH = 400;     // was 250
```

**Step 2: Auto-select first changed file when opening**

In `FileExplorerPane`, if no file is selected and diff data has files, auto-select the first changed file:

```typescript
useEffect(() => {
  if (!selectedFilePath && diffData?.files?.length) {
    const firstChanged = diffData.files[0];
    if (firstChanged && rootPath) {
      selectFile(rootPath + '/' + firstChanged.path);
    }
  }
}, [diffData?.files, selectedFilePath, selectFile, rootPath]);
```

This is optional — only do if it feels right with the UX.

**Step 3: Add bottom status bar**

At the bottom of the pane, add a thin status bar showing branch name, file type metadata:

```tsx
<div className="flex shrink-0 items-center gap-3.5 border-t border-[var(--line)] bg-bg-1 px-3.5 py-1 font-mono text-[10.5px] text-ink-3">
  <span className="flex items-center gap-1.5">
    <GitBranch className="h-2.5 w-2.5" />
    {branchName}
  </span>
  <span>{summary.changed} changed</span>
  <span className="text-green-400">+{summary.adds}</span>
  <span className="text-red-400">−{summary.dels}</span>
</div>
```

This requires passing `branchName` into the pane. Get it from the task's `worktreePath` using `getBranchFromWorktreePath`.

**Step 4: Run `pnpm install && pnpm lint --fix && pnpm ts-check && pnpm lint`**

---

## Task 7: Handle Path Mapping Between Absolute and Relative

**Files:**
- Modify: `src/features/task/ui-task-panel/file-explorer-pane/index.tsx`
- Modify: `src/features/task/ui-task-panel/file-explorer-pane/file-tree.tsx`

**Important context:** The file tree uses absolute paths (from `api.fs.listDirectory`), while worktree diff uses relative paths (from `git diff`). We need consistent mapping.

**Step 1: In `FileExplorerPane`, create the diffFilesMap keyed by absolute paths**

```typescript
const diffFilesMap = useMemo(() => {
  const map = new Map<string, { status: DiffFileStatus; additions: number; deletions: number }>();
  if (!rootPath || !diffData?.files) return map;
  for (const f of diffData.files) {
    const absPath = rootPath + '/' + f.path;
    map.set(absPath, {
      status: normalizeWorktreeStatus(f.status),
      additions: f.additions,
      deletions: f.deletions,
    });
  }
  return map;
}, [rootPath, diffData?.files]);
```

This way `FileTree` can look up entries by the absolute paths it already uses.

**Step 2: When passing `filePath` to `ExplorerDiffViewer`, convert to relative**

The `useWorktreeFileContent` hook uses relative paths. Strip `rootPath + '/'` before passing.

**Step 3: Run `pnpm ts-check`**

---

## Implementation Notes

### What to reuse from existing code
- `DiffStatusBadge` / `getStatusIndicator` from `src/features/common/ui-file-diff/status-badge.tsx`
- `FileDiffContent` from `src/features/common/ui-file-diff/file-diff-content.tsx` — already has full diff rendering with inline comments
- `useWorktreeDiff` / `useWorktreeFileContent` from `src/hooks/use-worktree-diff.ts`
- `normalizeWorktreeStatus` from `src/features/common/ui-file-diff/types.ts`

### What NOT to copy from the design
- The design's custom syntax tinting (`tint()` function) — we already use shiki in `FileContentViewer`
- The design's `DiffLine`/`SplitDiffPair` components — we already have `DiffView` component
- The design's `TweaksPanel` — that's design-tool-only UI
- The design's `FakeTaskBody` — that's the mock background
- The design's `ExplorerOverlay` top-level — we already have `FileExplorerPane` as a right pane

### Design tokens to match
- Status colors: Modified=blue (`text-blue-400`), Added=green (`text-green-400`), Deleted=red (`text-red-400`)
- Summary strip: `bg-bg-1`, mono font, `text-[11px]`
- File tree density: match existing spacing with `py-0.5` per row
- Segmented control: `bg-bg-0` container, `bg-bg-3` active segment, rounded corners
