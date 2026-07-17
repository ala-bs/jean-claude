import {
  Check,
  Copy,
  ExternalLink,
  File,
  FileText,
  FolderCode,
} from 'lucide-react';
import type {
  DiffFile,
  DiffFileStatus,
} from '@/features/common/ui-file-diff/types';
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useMemo,
  useState,
} from 'react';
import type {
  NormalizedEntry,
  ToolUseByName,
} from '@shared/normalized-message-v2';
import {
  type ReviewPresetId,
  useReviewCommentsForFile,
  useReviewCommentsStore,
} from '@/stores/review-comments';
import clsx from 'clsx';
import { DiffFileTree } from '@/features/common/ui-file-diff/file-tree';
import { FileDiffContent } from '@/features/common/ui-file-diff';
import { FileDiffHeader } from '@/features/common/ui-file-diff/file-diff-header';
import { getSelectedTextForRange } from '@/stores/utils-comment-prompt';
import { Modal } from '@/common/ui/modal';
import { parseUnifiedPatchToStrings } from '@/features/agent/ui-diff-view/diff-utils';
import type { PromptImagePart } from '@shared/agent-backend-types';
import { useDiffFileTreeWidth } from '@/stores/navigation';
import { useHorizontalResize } from '@/hooks/use-horizontal-resize';



interface FileChange {
  path: string;
  /** Display path (relative or full for external) */
  displayPath: string;
  status: DiffFileStatus;
  /** Whether this file is outside rootPath */
  external: boolean;
  /** Concatenated old strings (edit) or empty (write) */
  oldContent: string;
  /** Concatenated new strings (edit) or full content (write) */
  newContent: string;
  rawPatch?: string;
  hasStructuredDiff: boolean;
}

const MAX_MODAL_FILE_TREE_WIDTH = 640;

function normalizeFilePath(filePath: string): string {
  const slashPath = filePath.replaceAll('\\', '/');
  const prefix = slashPath.startsWith('/') ? '/' : '';
  const segments: string[] = [];

  for (const segment of slashPath.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..' && segments.length > 0 && segments.at(-1) !== '..') {
      segments.pop();
    } else {
      segments.push(segment);
    }
  }

  return prefix + segments.join('/');
}

function isAbsoluteFilePath(filePath: string): boolean {
  return (
    filePath.startsWith('/') ||
    filePath.startsWith('\\') ||
    /^[A-Za-z]:/.test(filePath)
  );
}

function relativizePath(
  filePath: string,
  rootPath: string | null | undefined,
): { displayPath: string; external: boolean } {
  if (!rootPath) return { displayPath: filePath, external: false };
  const normalizedPath = normalizeFilePath(filePath);
  const normalizedRoot = normalizeFilePath(rootPath).replace(/\/$/, '');
  const isAbsolute = isAbsoluteFilePath(filePath);
  if (!isAbsolute) {
    const external =
      normalizedPath === '..' || normalizedPath.startsWith('../');
    return {
      displayPath: external ? filePath : normalizedPath,
      external,
    };
  }
  const normalizedRootPrefix = `${normalizedRoot}/`;
  const isWindowsPath =
    (/^[A-Za-z]:\//.test(normalizedPath) &&
      /^[A-Za-z]:\//.test(normalizedRoot)) ||
    rootPath.startsWith('\\');
  const comparablePath = isWindowsPath
    ? normalizedPath.toLowerCase()
    : normalizedPath;
  const comparableRootPrefix = isWindowsPath
    ? normalizedRootPrefix.toLowerCase()
    : normalizedRootPrefix;
  if (comparablePath.startsWith(comparableRootPrefix)) {
    return {
      displayPath: normalizedPath.slice(normalizedRootPrefix.length),
      external: false,
    };
  }
  return { displayPath: filePath, external: true };
}

function extractFileChanges(
  fileChangeEntries: NormalizedEntry[],
  rootPath: string | null | undefined,
): FileChange[] {
  const fileMap = new Map<
    string,
    {
      path: string;
      edits: Array<{ old: string; new: string }>;
      status: DiffFileStatus;
      rawPatches: string[];
      hasStructuredDiff: boolean;
    }
  >();

  function processEntries(entries: NormalizedEntry[]) {
    for (const entry of entries) {
      if (entry.type !== 'tool-use') continue;

      if (entry.name === 'edit') {
        const e = entry as ToolUseByName<'edit'>;
        const files = e.input.files ?? [
          {
            filePath: e.input.filePath,
            type: 'update' as const,
            before: e.input.oldString,
            after: e.input.newString,
          },
        ];
        for (const file of files) {
          const pathInfo = relativizePath(file.filePath, rootPath);
          const mapKey = `${pathInfo.external ? 'external' : 'project'}:${normalizeFilePath(pathInfo.displayPath)}`;
          const existing = fileMap.get(mapKey);
          const status: DiffFileStatus =
            file.type === 'add'
              ? 'added'
              : file.type === 'delete'
                ? 'deleted'
                : 'modified';
          const hasStructuredDiff =
            file.before !== undefined || file.after !== undefined;
          const oldContent = file.before ?? '';
          const newContent = file.after ?? '';
          if (existing) {
            if (hasStructuredDiff) {
              existing.edits.push({ old: oldContent, new: newContent });
            }
            existing.status = status;
            if (file.patch) existing.rawPatches.push(file.patch);
            existing.hasStructuredDiff =
              existing.hasStructuredDiff || hasStructuredDiff;
          } else {
            fileMap.set(mapKey, {
              path: file.filePath,
              edits: hasStructuredDiff
                ? [{ old: oldContent, new: newContent }]
                : [],
              status,
              rawPatches: file.patch ? [file.patch] : [],
              hasStructuredDiff,
            });
          }
        }
      } else if (entry.name === 'write') {
        const w = entry as ToolUseByName<'write'>;
        const files = w.input.files ?? [
          {
            filePath: w.input.filePath,
            type: 'add' as const,
            after: w.input.value,
          },
        ];
        for (const file of files) {
          const pathInfo = relativizePath(file.filePath, rootPath);
          const mapKey = `${pathInfo.external ? 'external' : 'project'}:${normalizeFilePath(pathInfo.displayPath)}`;
          const existing = fileMap.get(mapKey);
          const status: DiffFileStatus =
            file.type === 'delete'
              ? 'deleted'
              : file.type === 'update'
                ? 'modified'
                : 'added';
          const hasStructuredDiff =
            file.before !== undefined || file.after !== undefined;
          const oldContent = file.before ?? '';
          const newContent = file.after ?? '';
          if (existing) {
            if (hasStructuredDiff) {
              existing.edits = [{ old: oldContent, new: newContent }];
            }
            existing.status = status;
            if (file.patch) existing.rawPatches.push(file.patch);
            existing.hasStructuredDiff =
              existing.hasStructuredDiff || hasStructuredDiff;
          } else {
            fileMap.set(mapKey, {
              path: file.filePath,
              edits: hasStructuredDiff
                ? [{ old: oldContent, new: newContent }]
                : [],
              status,
              rawPatches: file.patch ? [file.patch] : [],
              hasStructuredDiff,
            });
          }
        }
      }
    }
  }

  processEntries(fileChangeEntries);

  const changes: FileChange[] = [];
  for (const data of fileMap.values()) {
    const separator = '\n⋯\n';
    const oldContent = data.edits.map((e) => e.old).join(separator);
    const newContent = data.edits.map((e) => e.new).join(separator);
    const rawPatch = data.rawPatches.join(`\n${separator}\n`);
    const { displayPath, external } = relativizePath(data.path, rootPath);
    changes.push({
      path: data.path,
      displayPath,
      status: data.status,
      external,
      oldContent,
      newContent,
      rawPatch: rawPatch || undefined,
      hasStructuredDiff: data.hasStructuredDiff,
    });
  }

  // Sort: project files first, then external; alphabetical within each group
  changes.sort((a, b) => {
    if (a.external !== b.external) return a.external ? 1 : -1;
    return a.displayPath.localeCompare(b.displayPath);
  });
  return changes;
}

export function PromptGroupDiffModal({
  isOpen,
  onClose,
  fileChangeEntries,
  rootPath,
  taskId,
  onOpenFileInReview,
  onOpenFileInEditor,
}: {
  isOpen: boolean;
  onClose: () => void;
  fileChangeEntries: NormalizedEntry[];
  rootPath?: string | null;
  taskId?: string;
  onOpenFileInReview?: (filePath: string) => void;
  onOpenFileInEditor?: (filePath: string) => void | Promise<void>;
}) {
  const fileChanges = useMemo(
    () => extractFileChanges(fileChangeEntries, rootPath),
    [fileChangeEntries, rootPath],
  );

  const { projectFiles, externalFiles } = useMemo(() => {
    const project: FileChange[] = [];
    const external: FileChange[] = [];
    for (const fc of fileChanges) {
      if (fc.external) external.push(fc);
      else project.push(fc);
    }
    return { projectFiles: project, externalFiles: external };
  }, [fileChanges]);

  const projectDiffFiles: DiffFile[] = useMemo(
    () =>
      projectFiles.map((fc) => ({ path: fc.displayPath, status: fc.status })),
    [projectFiles],
  );

  const [selectedPath, setSelectedPath] = useState<string | null>(
    () => fileChanges[0]?.path ?? null,
  );
  const [rawDiffOpen, setRawDiffOpen] = useState(false);
  const [rawDiffCopied, setRawDiffCopied] = useState(false);
  const {
    width: fileTreeWidth,
    setWidth: setFileTreeWidth,
    minWidth,
  } = useDiffFileTreeWidth();
  const { containerRef, isDragging, handleMouseDown } = useHorizontalResize({
    initialWidth: fileTreeWidth,
    minWidth,
    maxWidthFraction: 0.5,
    onWidthChange: setFileTreeWidth,
  });

  const selectedChange = useMemo(
    () => fileChanges.find((fc) => fc.path === selectedPath) ?? null,
    [fileChanges, selectedPath],
  );

  const selectedPatchDiff = useMemo(
    () =>
      selectedChange?.rawPatch
        ? parseUnifiedPatchToStrings(selectedChange.rawPatch)
        : null,
    [selectedChange],
  );

  const handleSelectFile = (displayPath: string) => {
    // Find original path from displayPath
    const found = fileChanges.find((fc) => fc.displayPath === displayPath);
    if (found) setSelectedPath(found.path);
  };

  const handleCopyRawDiff = useCallback(async () => {
    if (!selectedChange?.rawPatch) return;
    await navigator.clipboard.writeText(selectedChange.rawPatch);
    setRawDiffCopied(true);
    window.setTimeout(() => setRawDiffCopied(false), 1200);
  }, [selectedChange]);

  const selectedDisplayPath = selectedChange?.displayPath ?? null;
  const canOpenInReview =
    !!selectedChange && !selectedChange.external && !!onOpenFileInReview;
  const selectedEditorPath = selectedChange
    ? !rootPath || isAbsoluteFilePath(selectedChange.path)
      ? selectedChange.path
      : normalizeFilePath(`${rootPath}/${selectedChange.path}`)
    : null;
  const headerActions = selectedChange ? (
    <div className="flex items-center gap-1">
      {onOpenFileInEditor && selectedEditorPath && (
        <button
          type="button"
          onClick={() => void onOpenFileInEditor(selectedEditorPath)}
          className="text-ink-3 hover:bg-glass-medium hover:text-ink-1 flex items-center gap-1.5 rounded px-2 py-1 text-[10px] transition-colors"
          title="Open file in editor"
        >
          <FolderCode className="h-3 w-3" aria-hidden />
          Open in editor
        </button>
      )}
      <button
        type="button"
        disabled={!canOpenInReview}
        onClick={() => {
          if (!canOpenInReview) return;
          onClose();
          onOpenFileInReview(selectedChange.displayPath);
        }}
        className="text-ink-3 hover:bg-glass-medium hover:text-ink-1 flex items-center gap-1.5 rounded px-2 py-1 text-[10px] transition-colors disabled:cursor-not-allowed disabled:opacity-40"
        title={
          selectedChange.external
            ? 'External files are unavailable in task diff'
            : 'Open in task diff'
        }
      >
        <ExternalLink className="h-3 w-3" aria-hidden />
        Open in task diff
      </button>
    </div>
  ) : undefined;
  const handleResizeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const maxWidth = Math.max(
      minWidth,
      (containerRef.current?.offsetWidth ?? fileTreeWidth * 2) * 0.5,
    );
    const delta = event.key === 'ArrowRight' ? 10 : -10;
    setFileTreeWidth(
      Math.min(Math.max(fileTreeWidth + delta, minWidth), maxWidth),
    );
  };

  return (
    <>
      <Modal isOpen={isOpen} onClose={onClose} title="Changes" size="xl">
        <div
          ref={containerRef}
          className={clsx(
            'flex h-[70vh] min-h-0 gap-0',
            isDragging && 'select-none',
          )}
        >
          {/* File tree sidebar */}
          <div
            className="border-glass-border relative shrink-0 overflow-y-auto border-r"
            style={{ width: fileTreeWidth, maxWidth: '50%' }}
          >
            {/* Project files tree */}
            <DiffFileTree
              files={projectDiffFiles}
              selectedPath={selectedDisplayPath}
              onSelectFile={handleSelectFile}
            />

            {/* External files section */}
            {externalFiles.length > 0 && (
              <div className="mt-2 border-t border-white/[0.06] pt-2">
                <div className="text-ink-4 px-3 pb-1 font-mono text-[10px] tracking-wider uppercase">
                  External files
                </div>
                {externalFiles.map((fc) => (
                  <button
                    key={fc.path}
                    type="button"
                    onClick={() => setSelectedPath(fc.path)}
                    className={`flex w-full items-center gap-1.5 px-3 py-1 text-left text-sm transition-colors ${
                      selectedPath === fc.path
                        ? 'text-ink-0 bg-glass-medium'
                        : 'text-ink-1 hover:bg-glass-medium/50'
                    }`}
                  >
                    <File className="text-ink-3 h-4 w-4 shrink-0" />
                    <span className="min-w-0 truncate" title={fc.path}>
                      {fc.displayPath.split('/').pop()}
                    </span>
                  </button>
                ))}
              </div>
            )}
            <div
              onMouseDown={handleMouseDown}
              onKeyDown={handleResizeKeyDown}
              role="separator"
              aria-label="Resize file tree"
              aria-orientation="vertical"
              aria-valuemax={MAX_MODAL_FILE_TREE_WIDTH}
              aria-valuemin={minWidth}
              aria-valuenow={Math.min(
                Math.round(fileTreeWidth),
                MAX_MODAL_FILE_TREE_WIDTH,
              )}
              tabIndex={0}
              className={clsx(
                'hover:bg-acc/50 focus:bg-acc/50 absolute top-0 right-0 h-full w-1 cursor-col-resize transition-colors outline-none',
                isDragging && 'bg-acc/50',
              )}
            />
          </div>

          {/* Diff content */}
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            {selectedChange?.rawPatch && (
              <div className="border-glass-border flex shrink-0 items-center justify-between border-b px-3 py-2">
                <span className="text-ink-4 truncate font-mono text-[10px]">
                  Raw patch available for {selectedChange.displayPath}
                </span>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setRawDiffOpen(true)}
                    className="text-ink-3 hover:bg-glass-medium hover:text-ink-1 flex items-center gap-1.5 rounded px-2 py-1 text-[10px] transition-colors"
                  >
                    <FileText className="h-3 w-3" aria-hidden />
                    Raw diff
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleCopyRawDiff()}
                    className="text-ink-3 hover:bg-glass-medium hover:text-ink-1 flex items-center gap-1.5 rounded px-2 py-1 text-[10px] transition-colors"
                  >
                    {rawDiffCopied ? (
                      <Check className="h-3 w-3" aria-hidden />
                    ) : (
                      <Copy className="h-3 w-3" aria-hidden />
                    )}
                    {rawDiffCopied ? 'Copied' : 'Copy raw'}
                  </button>
                </div>
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-hidden">
              {selectedChange ? (
                selectedChange.hasStructuredDiff ? (
                  <PromptGroupFileDiffContent
                    taskId={taskId}
                    change={selectedChange}
                    headerActions={headerActions}
                  />
                ) : selectedPatchDiff ? (
                  <PromptGroupFileDiffContent
                    taskId={taskId}
                    change={selectedChange}
                    oldContent={selectedPatchDiff.oldString}
                    newContent={selectedPatchDiff.newString}
                    headerActions={headerActions}
                  />
                ) : selectedChange.rawPatch ? (
                  <div className="flex h-full flex-col overflow-hidden">
                    <FileDiffHeader
                      file={{
                        path: selectedChange.displayPath,
                        status: selectedChange.status,
                      }}
                      actions={headerActions}
                    />
                    <div className="min-h-0 flex-1 overflow-auto p-4">
                      <pre className="text-ink-1 overflow-auto rounded bg-black/30 p-3 font-mono text-xs whitespace-pre-wrap">
                        {selectedChange.rawPatch}
                      </pre>
                    </div>
                  </div>
                ) : (
                  <div className="flex h-full flex-col overflow-hidden">
                    <FileDiffHeader
                      file={{
                        path: selectedChange.displayPath,
                        status: selectedChange.status,
                      }}
                      actions={headerActions}
                    />
                    <div className="text-ink-3 flex min-h-0 flex-1 items-center justify-center text-sm">
                      No structured diff available for this file
                    </div>
                  </div>
                )
              ) : (
                <div className="text-ink-3 flex h-full items-center justify-center text-sm">
                  Select a file to view changes
                </div>
              )}
            </div>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={rawDiffOpen && !!selectedChange?.rawPatch}
        onClose={() => setRawDiffOpen(false)}
        title="Raw Diff"
        size="xl"
        contentClassName="min-h-0 p-0"
      >
        <div className="flex h-[70vh] min-h-0 flex-col">
          <div className="border-glass-border flex shrink-0 items-center justify-between border-b px-3 py-2">
            <span className="text-ink-3 truncate font-mono text-xs">
              {selectedChange?.displayPath}
            </span>
            <button
              type="button"
              onClick={() => void handleCopyRawDiff()}
              className="text-ink-3 hover:bg-glass-medium hover:text-ink-1 flex items-center gap-1.5 rounded px-2 py-1 text-[10px] transition-colors"
            >
              {rawDiffCopied ? (
                <Check className="h-3 w-3" aria-hidden />
              ) : (
                <Copy className="h-3 w-3" aria-hidden />
              )}
              {rawDiffCopied ? 'Copied' : 'Copy raw'}
            </button>
          </div>
          <pre className="text-ink-1 min-h-0 flex-1 overflow-auto bg-black/40 p-4 font-mono text-xs leading-5 whitespace-pre-wrap">
            {selectedChange?.rawPatch}
          </pre>
        </div>
      </Modal>
    </>
  );
}

function PromptGroupFileDiffContent({
  taskId,
  change,
  oldContent = change.oldContent,
  newContent = change.newContent,
  headerActions,
}: {
  taskId?: string;
  change: FileChange;
  oldContent?: string;
  newContent?: string;
  headerActions?: ReactNode;
}) {
  const reviewComments = useReviewCommentsForFile(
    taskId ?? '',
    change.displayPath,
  );
  const addComment = useReviewCommentsStore((s) => s.addComment);
  const removeComment = useReviewCommentsStore((s) => s.removeComment);
  const updateComment = useReviewCommentsStore((s) => s.updateComment);
  const resolveComment = useReviewCommentsStore((s) => s.resolveComment);

  const handleAddReviewComment = useCallback(
    (params: {
      filePath: string;
      lineStart: number;
      lineEnd?: number;
      selectedText?: string;
      body: string;
      presets: ReviewPresetId[];
      images?: PromptImagePart[];
    }) => {
      if (!taskId) return;
      const contentForSelection =
        change.status === 'deleted' ? oldContent : newContent;
      addComment(taskId, {
        commentKind: 'diff',
        anchor: {
          filePath: params.filePath,
          lineStart: params.lineStart,
          lineEnd: params.lineEnd,
          omitLineRangeFromPrompt: true,
          selectedText:
            params.selectedText ??
            getSelectedTextForRange(
              contentForSelection,
              params.lineStart,
              params.lineEnd,
            ),
        },
        body: params.body,
        images: params.images,
        presets: params.presets,
        status: 'open',
        resolved: false,
      });
    },
    [taskId, change.status, oldContent, newContent, addComment],
  );

  const handleDeleteReviewComment = useCallback(
    (commentId: string) => {
      if (!taskId) return;
      removeComment(taskId, commentId);
    },
    [taskId, removeComment],
  );

  const handleEditReviewComment = useCallback(
    (commentId: string, newBody: string, newImages: PromptImagePart[]) => {
      if (!taskId) return;
      updateComment(taskId, commentId, {
        body: newBody,
        images: newImages.length > 0 ? newImages : undefined,
      });
    },
    [taskId, updateComment],
  );

  const handleResolveReviewComment = useCallback(
    (commentId: string) => {
      if (!taskId) return;
      resolveComment(taskId, commentId);
    },
    [taskId, resolveComment],
  );

  return (
    <FileDiffContent
      file={{ path: change.displayPath, status: change.status }}
      oldContent={oldContent}
      newContent={newContent}
      headerActions={headerActions}
      reviewComments={taskId ? reviewComments : undefined}
      onAddReviewComment={taskId ? handleAddReviewComment : undefined}
      onDeleteReviewComment={handleDeleteReviewComment}
      onEditReviewComment={handleEditReviewComment}
      onResolveReviewComment={handleResolveReviewComment}
    />
  );
}
