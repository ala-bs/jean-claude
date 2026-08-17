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
}) {
  const tree = useMemo(() => compressTree(buildTree(files)), [files]);
  const allFolderPaths = useMemo(() => collectFolderPaths(buildTree(files)), [files]);
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
        />
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
            'text-ink-2 relative flex h-[26px] w-full items-center gap-1.5 rounded-md px-2 text-left text-[13px] transition-colors hover:bg-glass-medium/50',
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

  return (
    <button
      onClick={() => onSelectFile(node.path)}
      aria-current={isSelected ? 'true' : undefined}
      data-file-path={node.path}
      className={clsx(
        'relative flex h-[26px] w-full items-center gap-1.5 rounded-md px-2 text-left text-[13px] transition-colors',
        isSelected
          ? 'text-ink-0 bg-glass-medium shadow-[inset_2px_0_0_var(--acc)]'
          : 'text-ink-1 hover:bg-glass-medium/50',
      )}
      style={{ paddingLeft: 8 + depth * indent + 21 }}
    >
      {guides}
      <File className="text-ink-3 h-[15px] w-[15px] shrink-0" aria-hidden />
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
          className="inline-flex shrink-0 items-center gap-1 bg-status-run/15 text-status-run rounded-full px-1.5 font-mono text-[9.5px]"
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
