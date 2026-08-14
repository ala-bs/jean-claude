import {
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  File,
  Folder,
  MessageCircle,
  PenLine,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';

import type { DiffFile, DiffFileStatus } from './types';
import { getStatusIndicator } from './status-badge';
import { ReviewCheck } from './review-check';
import type { ReviewedTreatment } from '@/stores/diff-review';
import { selectionAfterClick } from './utils-selection';

type TreeNode = {
  name: string;
  path: string;
  type: 'folder' | 'file';
  status?: DiffFileStatus;
  originalPath?: string;
  children?: TreeNode[];
  folderPaths?: string[];
};

function collectFolderPaths(nodes: TreeNode[], folders = new Set<string>()) {
  for (const node of nodes) {
    if (node.type === 'folder') {
      folders.add(node.path);
      collectFolderPaths(node.children ?? [], folders);
    }
  }
  return folders;
}

function compressTree(nodes: TreeNode[]): TreeNode[] {
  return nodes.map((node) => {
    if (node.type === 'file') return node;

    let current = node;
    const folderPaths = [node.path];
    const names = [node.name];

    while (
      current.children?.length === 1 &&
      current.children[0]?.type === 'folder'
    ) {
      current = current.children[0];
      names.push(current.name);
      folderPaths.push(current.path);
    }

    return {
      ...current,
      name: names.join('/'),
      folderPaths,
      children: compressTree(current.children ?? []),
    };
  });
}

function getFileName(path: string) {
  return path.split('/').pop() || path;
}

/** File paths in the order they are rendered, skipping collapsed folders. */
function visibleFilePaths(
  nodes: TreeNode[],
  expandedFolders: Set<string>,
  out: string[] = [],
) {
  for (const node of nodes) {
    if (node.type === 'file') {
      out.push(node.path);
      continue;
    }
    const folderPaths = node.folderPaths ?? [node.path];
    if (folderPaths.every((path) => expandedFolders.has(path))) {
      visibleFilePaths(node.children ?? [], expandedFolders, out);
    }
  }
  return out;
}

function getStatusIndicatorOrEmpty(status?: DiffFileStatus) {
  if (!status) return { label: '', color: '' };
  return getStatusIndicator(status);
}

export function DiffFileTree({
  files,
  selectedPath,
  onSelectFile,
  filesWithAnnotations,
  commentCountByFile,
  commentStatusCountByFile,
  draftCountByFile,
  llmThreadCountByFile,
  collapsedFolders: externalCollapsedFolders,
  onToggleFolder: externalOnToggleFolder,
  stickyFolders = false,
  reviewedPaths,
  stalePaths,
  onToggleReviewed,
  reviewedTreatment = 'dim',
}: {
  files: DiffFile[];
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
  filesWithAnnotations?: Set<string>;
  commentCountByFile?: Record<string, number>;
  commentStatusCountByFile?: Record<
    string,
    { active: number; resolved: number }
  >;
  draftCountByFile?: Record<string, number>;
  llmThreadCountByFile?: Record<string, number>;
  collapsedFolders?: Set<string>;
  onToggleFolder?: (path: string) => void;
  stickyFolders?: boolean;
  /** Paths the user has marked as reviewed. Enables the review checkboxes. */
  reviewedPaths?: Set<string>;
  /** Reviewed files that changed since — they stay in place, flagged. */
  stalePaths?: Set<string>;
  onToggleReviewed?: (paths: string[], reviewed: boolean) => void;
  reviewedTreatment?: ReviewedTreatment;
}) {
  const showReview = Boolean(reviewedPaths && onToggleReviewed);
  const hiddenFiles = useMemo(() => {
    if (!showReview || reviewedTreatment === 'dim') return [];
    return files.filter(
      (file) =>
        reviewedPaths?.has(file.path) &&
        !stalePaths?.has(file.path) &&
        file.path !== selectedPath,
    );
  }, [
    files,
    reviewedPaths,
    stalePaths,
    reviewedTreatment,
    selectedPath,
    showReview,
  ]);
  const visibleFiles = useMemo(() => {
    if (hiddenFiles.length === 0) return files;
    const hidden = new Set(hiddenFiles.map((file) => file.path));
    return files.filter((file) => !hidden.has(file.path));
  }, [files, hiddenFiles]);

  const tree = useMemo(
    () => compressTree(buildTree(visibleFiles)),
    [visibleFiles],
  );
  const allFolderPaths = useMemo(
    () => collectFolderPaths(buildTree(visibleFiles)),
    [visibleFiles],
  );
  const stickyFolderBaseZIndex = Math.max(allFolderPaths.size + 1, 1);
  const [localExpandedFolders, setLocalExpandedFolders] = useState<Set<string>>(
    () => new Set(allFolderPaths),
  );
  const expandedFolders = useMemo(() => {
    if (!externalCollapsedFolders) return localExpandedFolders;
    return new Set(
      [...allFolderPaths].filter((path) => !externalCollapsedFolders.has(path)),
    );
  }, [allFolderPaths, externalCollapsedFolders, localExpandedFolders]);
  const treeRef = useRef<HTMLDivElement>(null);
  // Multi-select is view-local: ⇧/⌘-click a row, then one checkbox click (or
  // the context menu) applies to every selected file at once.
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const anchorRef = useRef<string | null>(null);
  const rowOrder = useMemo(
    () => visibleFilePaths(tree, expandedFolders),
    [tree, expandedFolders],
  );
  const selection = useMemo(() => {
    const known = new Set(rowOrder);
    return selectedPaths.filter((path) => known.has(path));
  }, [selectedPaths, rowOrder]);
  const selectionSet = useMemo(() => new Set(selection), [selection]);

  // Opening a file elsewhere (tab strip, J/K) abandons the tree's selection.
  // Adjusted during render rather than in an effect so there is no extra pass.
  const [lastOpenedPath, setLastOpenedPath] = useState(selectedPath);
  if (lastOpenedPath !== selectedPath) {
    setLastOpenedPath(selectedPath);
    if (
      selectedPath &&
      selectedPaths.length > 1 &&
      !selectedPaths.includes(selectedPath)
    ) {
      setSelectedPaths([]);
    }
  }

  const handleRowClick = useCallback(
    (path: string, event: React.MouseEvent) => {
      const next = selectionAfterClick({
        rowPaths: rowOrder,
        path,
        anchor: anchorRef.current ?? selectedPath,
        selection,
        shiftKey: event.shiftKey,
        toggleKey: event.metaKey || event.ctrlKey,
      });
      anchorRef.current = next.anchor;
      setSelectedPaths(next.selection);
      if (next.activate) onSelectFile(path);
    },
    [rowOrder, selection, selectedPath, onSelectFile],
  );

  /**
   * Every file under a folder — including ones the current treatment hides, so
   * folder counters and their tri-state stay truthful.
   */
  const filePathsUnder = useCallback(
    (folderPath: string) => {
      const prefix = `${folderPath}/`;
      return files
        .filter((file) => file.path.startsWith(prefix))
        .map((file) => file.path);
    },
    [files],
  );

  /** A file checkbox applies to the whole selection when its row is in it. */
  const handleToggleRowReviewed = useCallback(
    (path: string, reviewed: boolean) => {
      onToggleReviewed?.(selectionSet.has(path) ? selection : [path], reviewed);
    },
    [selection, selectionSet, onToggleReviewed],
  );

  // Escape drops a multi-selection without touching the opened file.
  useEffect(() => {
    if (selection.length < 2) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelectedPaths([]);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selection.length]);

  useEffect(() => {
    if (!selectedPath) return;
    const selectedRow = Array.from(
      treeRef.current?.querySelectorAll<HTMLElement>('[data-file-path]') ?? [],
    ).find((element) => element.dataset.filePath === selectedPath);
    selectedRow?.scrollIntoView({ block: 'nearest' });
  }, [selectedPath, tree]);

  const toggleFolder = useCallback(
    (path: string) => {
      if (externalOnToggleFolder) {
        externalOnToggleFolder(path);
        return;
      }
      setLocalExpandedFolders((previous) => {
        const next = new Set(previous);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      });
    },
    [externalOnToggleFolder],
  );

  const hasAnnotation = useCallback(
    (path: string) => filesWithAnnotations?.has(path) ?? false,
    [filesWithAnnotations],
  );
  const getCommentCount = useCallback(
    (path: string) => commentCountByFile?.[path] ?? 0,
    [commentCountByFile],
  );
  const getCommentStatusCount = useCallback(
    (path: string) => commentStatusCountByFile?.[path],
    [commentStatusCountByFile],
  );
  const getDraftCount = useCallback(
    (path: string) => draftCountByFile?.[path] ?? 0,
    [draftCountByFile],
  );
  const getLlmThreadCount = useCallback(
    (path: string) => llmThreadCountByFile?.[path] ?? 0,
    [llmThreadCountByFile],
  );

  return (
    <div
      ref={treeRef}
      className={clsx(
        'flex flex-col py-1',
        stickyFolders && 'isolate',
        !stickyFolders && 'min-h-0 flex-1 overflow-auto',
      )}
    >
      {tree.map((node) => (
        <TreeNodeRow
          key={node.path}
          node={node}
          depth={0}
          selectedPath={selectedPath}
          expandedFolders={expandedFolders}
          onSelectFile={onSelectFile}
          onToggleFolder={toggleFolder}
          hasAnnotation={hasAnnotation}
          getCommentCount={getCommentCount}
          getCommentStatusCount={getCommentStatusCount}
          getDraftCount={getDraftCount}
          getLlmThreadCount={getLlmThreadCount}
          stickyFolders={stickyFolders}
          stickyFolderBaseZIndex={stickyFolderBaseZIndex}
          reviewedPaths={reviewedPaths}
          stalePaths={stalePaths}
          onToggleReviewed={onToggleReviewed}
          onToggleRowReviewed={handleToggleRowReviewed}
          filePathsUnder={filePathsUnder}
          selectedPaths={selectionSet}
          onRowClick={handleRowClick}
        />
      ))}
      {reviewedTreatment === 'bottom' && hiddenFiles.length > 0 && (
        <ReviewedGroup
          files={hiddenFiles}
          onSelectFile={onSelectFile}
          onToggleReviewed={onToggleReviewed}
        />
      )}
      {reviewedTreatment === 'hide' && hiddenFiles.length > 0 && (
        <p className="text-ink-4 px-2 pt-2 text-[11px]">
          {hiddenFiles.length} reviewed file
          {hiddenFiles.length > 1 ? 's' : ''} hidden
        </p>
      )}
    </div>
  );
}

function ReviewedGroup({
  files,
  onSelectFile,
  onToggleReviewed,
}: {
  files: DiffFile[];
  onSelectFile: (path: string) => void;
  onToggleReviewed?: (paths: string[], reviewed: boolean) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <div className="border-glass-border mt-2 border-t pt-1.5">
      <button
        onClick={() => setIsOpen((previous) => !previous)}
        className="text-status-done flex h-[26px] w-full items-center gap-1.5 px-2 text-left text-xs"
      >
        {isOpen ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden />
        )}
        <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="flex-1">Reviewed</span>
        <span className="text-ink-4 font-mono text-[9.5px]">{files.length}</span>
      </button>
      {isOpen &&
        files.map((file) => (
          <button
            key={file.path}
            onClick={() => onSelectFile(file.path)}
            className="text-ink-2 hover:bg-glass-medium/50 flex h-[24px] w-full items-center gap-1.5 pr-2 pl-6 text-left text-xs opacity-60"
          >
            <ReviewCheck
              checked
              size={13}
              onToggle={(next) => onToggleReviewed?.([file.path], next)}
            />
            <span className="min-w-0 truncate" title={file.path}>
              <span className="text-ink-4">
                {file.path.slice(0, file.path.lastIndexOf('/') + 1)}
              </span>
              {getFileName(file.path)}
            </span>
          </button>
        ))}
    </div>
  );
}

function TreeNodeRow({
  node,
  depth,
  selectedPath,
  expandedFolders,
  onSelectFile,
  onToggleFolder,
  hasAnnotation,
  getCommentCount,
  getCommentStatusCount,
  getDraftCount,
  getLlmThreadCount,
  stickyFolders,
  stickyFolderBaseZIndex,
  reviewedPaths,
  stalePaths,
  onToggleReviewed,
  onToggleRowReviewed,
  filePathsUnder,
  selectedPaths,
  onRowClick,
}: {
  node: TreeNode;
  depth: number;
  selectedPath: string | null;
  expandedFolders: Set<string>;
  onSelectFile: (path: string) => void;
  onToggleFolder: (path: string) => void;
  hasAnnotation: (path: string) => boolean;
  getCommentCount: (path: string) => number;
  getCommentStatusCount: (
    path: string,
  ) => { active: number; resolved: number } | undefined;
  getDraftCount: (path: string) => number;
  getLlmThreadCount: (path: string) => number;
  stickyFolders: boolean;
  stickyFolderBaseZIndex: number;
  reviewedPaths?: Set<string>;
  stalePaths?: Set<string>;
  onToggleReviewed?: (paths: string[], reviewed: boolean) => void;
  onToggleRowReviewed: (path: string, reviewed: boolean) => void;
  filePathsUnder: (folderPath: string) => string[];
  selectedPaths: Set<string>;
  onRowClick: (path: string, event: React.MouseEvent) => void;
}) {
  const indent = 10;
  const paddingLeft = 8 + depth * indent;
  const guides = Array.from({ length: depth }, (_, index) => (
    <span
      key={index}
      className="bg-glass-border absolute top-0 bottom-0 w-px"
      style={{ left: 8 + index * indent + indent / 2 }}
    />
  ));

  if (node.type === 'folder') {
    const folderPaths = node.folderPaths ?? [node.path];
    const isExpanded = folderPaths.every((path) => expandedFolders.has(path));
    const togglePath = folderPaths[folderPaths.length - 1] ?? node.path;
    const descendantPaths = reviewedPaths ? filePathsUnder(node.path) : [];
    const isFolderFullyReviewed =
      Boolean(reviewedPaths) &&
      descendantPaths.length > 0 &&
      descendantPaths.every((path) => reviewedPaths?.has(path) && !stalePaths?.has(path));
    return (
      <div>
        <button
          onClick={() => {
            if (isExpanded) {
              onToggleFolder(togglePath);
              return;
            }
            for (const path of folderPaths) {
              if (!expandedFolders.has(path)) onToggleFolder(path);
            }
          }}
          aria-expanded={isExpanded}
          className={clsx(
            'relative flex h-[26px] w-full items-center gap-1.5 px-2 text-left text-[13px] transition-colors hover:bg-glass-medium/50',
            isFolderFullyReviewed ? 'text-status-done' : 'text-ink-2',
            isFolderFullyReviewed && !stickyFolders && 'bg-status-done-soft',
            stickyFolders && 'bg-bg-0 sticky z-10',
          )}
          style={
            stickyFolders
              ? {
                  paddingLeft,
                  top: depth * 26,
                  zIndex: stickyFolderBaseZIndex - depth,
                }
              : { paddingLeft }
          }
        >
          {isFolderFullyReviewed && stickyFolders && (
            <span className="bg-status-done-soft pointer-events-none absolute inset-0" aria-hidden />
          )}
          {guides}
          {isExpanded ? (
            <ChevronDown className="text-ink-3 h-3.5 w-3.5 shrink-0" aria-hidden />
          ) : (
            <ChevronRight className="text-ink-3 h-3.5 w-3.5 shrink-0" aria-hidden />
          )}
          <Folder className="text-ink-3 h-[15px] w-[15px] shrink-0" aria-hidden />
          <span className="min-w-0 truncate" title={node.name}>
            <PathName name={node.name} />
          </span>
          {reviewedPaths && onToggleReviewed && (
            <FolderReviewCheck
              paths={filePathsUnder(node.path)}
              reviewedPaths={reviewedPaths}
              stalePaths={stalePaths}
              onToggleReviewed={onToggleReviewed}
            />
          )}
        </button>
        {isExpanded &&
          node.children?.map((child) => (
            <TreeNodeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              expandedFolders={expandedFolders}
              onSelectFile={onSelectFile}
              onToggleFolder={onToggleFolder}
              hasAnnotation={hasAnnotation}
              getCommentCount={getCommentCount}
              getCommentStatusCount={getCommentStatusCount}
              getDraftCount={getDraftCount}
              getLlmThreadCount={getLlmThreadCount}
              stickyFolders={stickyFolders}
              stickyFolderBaseZIndex={stickyFolderBaseZIndex}
              reviewedPaths={reviewedPaths}
              stalePaths={stalePaths}
              onToggleReviewed={onToggleReviewed}
              onToggleRowReviewed={onToggleRowReviewed}
              filePathsUnder={filePathsUnder}
              selectedPaths={selectedPaths}
              onRowClick={onRowClick}
            />
          ))}
      </div>
    );
  }

  const statusIndicator = getStatusIndicatorOrEmpty(node.status);
  const commentStatusCount = getCommentStatusCount(node.path);
  const commentStatusTotal = commentStatusCount
    ? commentStatusCount.active + commentStatusCount.resolved
    : 0;
  const commentCount = getCommentCount(node.path);
  const draftCount = getDraftCount(node.path);
  const llmThreadCount = getLlmThreadCount(node.path);
  const isSelected = node.path === selectedPath;
  const showReview = Boolean(reviewedPaths && onToggleReviewed);
  const isReviewed = reviewedPaths?.has(node.path) ?? false;
  const isStale = stalePaths?.has(node.path) ?? false;
  const isMultiSelected = selectedPaths.size > 1 && selectedPaths.has(node.path);

  return (
    <button
      onClick={(event) => onRowClick(node.path, event)}
      aria-current={isSelected ? 'true' : undefined}
      aria-selected={isMultiSelected || undefined}
      data-file-path={node.path}
      className={clsx(
        'relative flex h-[26px] w-full items-center gap-1.5 px-2 text-left text-[13px] transition-colors',
        isSelected
          ? 'text-ink-0 bg-glass-medium shadow-[inset_2px_0_0_var(--acc)]'
          : isMultiSelected
            ? 'bg-acc-soft text-ink-0'
            : isReviewed && !isStale
              ? 'text-status-done bg-status-done-soft hover:bg-status-done-soft'
              : 'text-ink-1 hover:bg-glass-medium/50',
      )}
      style={{ paddingLeft: 8 + depth * indent + (showReview ? 6 : 21) }}
    >
      {guides}
      {showReview ? (
        <ReviewCheck
          checked={isReviewed}
          stale={isStale}
          size={14}
          title={
            isMultiSelected
              ? `${isReviewed ? 'Unmark' : 'Mark'} ${selectedPaths.size} selected files`
              : undefined
          }
          onToggle={(next) => onToggleRowReviewed(node.path, next)}
        />
      ) : (
        <File className="text-ink-3 h-[15px] w-[15px] shrink-0" aria-hidden />
      )}
      <span className={clsx('min-w-0 truncate', node.status === 'deleted' && 'line-through')}>
        {node.name}
      </span>
      {node.status === 'renamed' && node.originalPath && (
        <span className="text-ink-3 min-w-0 truncate text-xs">
          ← {getFileName(node.originalPath)}
        </span>
      )}
      {hasAnnotation(node.path) && (
        <MessageCircle className="text-status-run/70 h-3 w-3 shrink-0" aria-label="Has AI annotations" />
      )}
      {commentStatusCount && commentStatusTotal > 0 ? (
        <>
          <span
            className="bg-acc-soft text-acc-ink inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 font-mono text-[9.5px]"
            aria-label={`${commentStatusCount.active} active review comment${commentStatusCount.active !== 1 ? 's' : ''}`}
            title="Active comments"
          >
            {commentStatusCount.active > 0 && <MessageCircle className="h-2.5 w-2.5" />}
            {commentStatusCount.active}
          </span>
          <span
            className="text-ink-3 bg-glass-medium inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 font-mono text-[9.5px]"
            aria-label={`${commentStatusCount.resolved} resolved review comment${commentStatusCount.resolved !== 1 ? 's' : ''}`}
            title="Resolved comments"
          >
            {commentStatusCount.resolved > 0 && <CheckCircle2 className="h-2.5 w-2.5" />}
            {commentStatusCount.resolved}
          </span>
        </>
      ) : commentCount > 0 ? (
        <span
          className="bg-acc-soft text-acc-ink inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 font-mono text-[9.5px]"
          aria-label={`${commentCount} review comment${commentCount !== 1 ? 's' : ''}`}
        >
          <MessageCircle className="h-2.5 w-2.5" />
          {commentCount}
        </span>
      ) : null}
      {draftCount > 0 && (
        <span
          className="inline-flex shrink-0 items-center gap-1 rounded-full bg-yellow-900/40 px-1.5 font-mono text-[9.5px] text-yellow-300"
          aria-label={`${draftCount} draft comment${draftCount !== 1 ? 's' : ''}`}
        >
          <PenLine className="h-2.5 w-2.5" />
          {draftCount}
        </span>
      )}
      {llmThreadCount > 0 && (
        <span
          className="border-acc/20 bg-acc/10 text-acc-ink inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 font-mono text-[9.5px]"
          aria-label={`${llmThreadCount} LLM thread${llmThreadCount !== 1 ? 's' : ''}`}
          title="LLM threads"
        >
          <Bot className="h-2.5 w-2.5" />
          {llmThreadCount}
        </span>
      )}
      <span className={clsx('ml-auto shrink-0 font-mono text-[13px] font-semibold', statusIndicator.color)}>
        {statusIndicator.label}
      </span>
    </button>
  );
}

function FolderReviewCheck({
  paths,
  reviewedPaths,
  stalePaths,
  onToggleReviewed,
}: {
  paths: string[];
  reviewedPaths: Set<string>;
  stalePaths?: Set<string>;
  onToggleReviewed: (paths: string[], reviewed: boolean) => void;
}) {
  const reviewedCount = paths.filter(
    (path) => reviewedPaths.has(path) && !stalePaths?.has(path),
  ).length;
  const staleCount = paths.filter((path) => stalePaths?.has(path)).length;
  const isComplete = paths.length > 0 && reviewedCount === paths.length;
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1.5">
      <span className="text-ink-4 font-mono text-[9.5px] tabular-nums">
        {reviewedCount}/{paths.length}
      </span>
      <ReviewCheck
        checked={isComplete}
        stale={!isComplete && staleCount > 0}
        partial={reviewedCount > 0 && !isComplete}
        size={14}
        title={
          isComplete
            ? `Unmark ${paths.length} files`
            : `Mark all ${paths.length} files reviewed`
        }
        onToggle={(next) => onToggleReviewed(paths, next)}
      />
    </span>
  );
}

function PathName({ name }: { name: string }) {
  const parts = name.split('/');
  const leaf = parts.pop() ?? name;
  return (
    <>
      {parts.length > 0 && <span className="text-ink-3">{parts.join('/')}/</span>}
      <span className="text-ink-0">{leaf}</span>
    </>
  );
}

function buildTree(files: DiffFile[]): TreeNode[] {
  const root: TreeNode[] = [];
  const folderMap = new Map<string, TreeNode>();

  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const parts = file.path.split('/');
    let currentLevel = root;
    let currentPath = '';

    for (let index = 0; index < parts.length - 1; index++) {
      const part = parts[index];
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      let folder = folderMap.get(currentPath);
      if (!folder) {
        folder = { name: part, path: currentPath, type: 'folder', children: [] };
        folderMap.set(currentPath, folder);
        currentLevel.push(folder);
      }
      currentLevel = folder.children ?? [];
    }

    currentLevel.push({
      name: parts[parts.length - 1] ?? file.path,
      path: file.path,
      type: 'file',
      status: file.status,
      originalPath: file.originalPath,
    });
  }

  sortTree(root);
  return root;
}

function sortTree(nodes: TreeNode[]) {
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const node of nodes) {
    if (node.children) sortTree(node.children);
  }
}
