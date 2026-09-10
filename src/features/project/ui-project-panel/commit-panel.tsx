import { Check, ChevronDown, ChevronRight, Copy, GitPullRequest, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import clsx from 'clsx';

import {
  useProjectCommitDetail,
  useProjectCommitFileContent,
} from '@/hooks/use-project-git';
import { FileDiffContent } from '@/features/common/ui-file-diff';
import { formatRelativeTime } from '@/lib/time';
import type { ProjectCommitDiffFile } from '@shared/types';
import { useCommitDiffPaneWidth } from '@/stores/navigation';
import { useHorizontalResize } from '@/hooks/use-horizontal-resize';

/** Proportional add/delete bar, so file sizes are comparable at a glance. */
function StatBar({
  additions,
  deletions,
  width = 46,
}: {
  additions: number;
  deletions: number;
  width?: number;
}) {
  const total = Math.max(1, additions + deletions);
  return (
    <span
      className="inline-flex h-1.5 shrink-0 gap-px"
      style={{ width }}
      aria-hidden
    >
      <span
        className="bg-status-done/80 rounded-sm"
        style={{ width: `${(additions / total) * 100}%` }}
      />
      <span
        className="bg-status-fail/80 rounded-sm"
        style={{ width: `${(deletions / total) * 100}%` }}
      />
    </span>
  );
}

const STATUS_LETTER: Record<ProjectCommitDiffFile['status'], string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
};

/**
 * One file in the commit.
 *
 * Content is fetched only once the row is expanded — a commit touching fifty
 * files would otherwise pull every blob to render the handful the user opens.
 */
function CommitFile({
  projectId,
  commitHash,
  file,
  isOpen,
  onToggle,
}: {
  projectId: string;
  commitHash: string;
  file: ProjectCommitDiffFile;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const { data: content, isLoading } = useProjectCommitFileContent(
    projectId,
    isOpen ? commitHash : null,
    isOpen ? file.path : null,
  );

  const lastSlash = file.path.lastIndexOf('/');
  const directory = file.path.slice(0, lastSlash + 1);
  const base = file.path.slice(lastSlash + 1);

  return (
    <div className="border-line-soft border-b">
      <button
        type="button"
        onClick={onToggle}
        className="hover:bg-glass-light bg-bg-1 sticky top-0 z-10 flex w-full items-center gap-2 py-[7px] pr-3 pl-2 text-left transition-colors"
      >
        {isOpen ? (
          <ChevronDown size={11} className="text-ink-4 shrink-0" />
        ) : (
          <ChevronRight size={11} className="text-ink-4 shrink-0" />
        )}
        <span
          title={file.status}
          className={clsx(
            'w-3 shrink-0 text-center font-mono text-[10.5px]',
            file.status === 'added' && 'text-status-done',
            file.status === 'deleted' && 'text-status-fail',
            file.status === 'modified' && 'text-status-review',
          )}
        >
          {STATUS_LETTER[file.status]}
        </span>
        <span
          title={file.path}
          className="min-w-0 truncate font-mono text-[11.5px]"
        >
          <span className="text-ink-4">{directory}</span>
          <span className="text-ink-1">{base}</span>
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-[7px] font-mono text-[10.5px] tabular-nums">
          <span className="text-status-done">+{file.additions}</span>
          <span className="text-status-fail">−{file.deletions}</span>
          <StatBar additions={file.additions} deletions={file.deletions} />
        </span>
      </button>

      {isOpen && (
        <div className="bg-bg-0 border-line-soft border-t">
          <FileDiffContent
            file={{
              path: file.path,
              status: file.status,
              additions: file.additions,
              deletions: file.deletions,
            }}
            oldContent={content?.oldContent ?? ''}
            newContent={content?.newContent ?? ''}
            isBinary={content?.isBinary ?? false}
            isLoading={isLoading}
          />
        </div>
      )}
    </div>
  );
}

/**
 * Diff pane for a selected commit.
 *
 * Occupies the same slot as the tasks rail rather than sitting beside it, so
 * the history list keeps its full width while a commit is open.
 */
export function CommitPanel({
  projectId,
  commitHash,
  onClose,
}: {
  projectId: string;
  commitHash: string;
  onClose: () => void;
}) {
  const { data: detail, isLoading } = useProjectCommitDetail(
    projectId,
    commitHash,
  );

  // Width is app-level rather than per-project: it expresses how much room the
  // user wants for reading diffs, which does not change between repositories.
  const { width, setWidth, minWidth, maxWidth } = useCommitDiffPaneWidth();
  const { isDragging, handleMouseDown } = useHorizontalResize({
    initialWidth: width,
    minWidth,
    maxWidth,
    maxWidthFraction: 0.7,
    // The handle sits on the pane's left edge, so dragging left grows it.
    direction: 'left',
    onWidthChange: setWidth,
  });
  // Both pieces of state are tagged with the commit they describe rather than
  // being reset in an effect when the selection changes. Selecting a new commit
  // must not inherit the previous one's expanded paths, and deriving that from
  // the hash avoids a render pass that shows the stale state before clearing it.
  const [expanded, setExpanded] = useState<{
    hash: string;
    files: Record<string, boolean>;
  }>({ hash: commitHash, files: {} });
  const [copiedHash, setCopiedHash] = useState<string | null>(null);

  const openFiles = expanded.hash === commitHash ? expanded.files : {};
  const didCopy = copiedHash === commitHash;

  useEffect(() => {
    if (!didCopy) return;
    const timer = setTimeout(() => setCopiedHash(null), 1_500);
    return () => clearTimeout(timer);
  }, [didCopy]);

  const files = detail?.files ?? [];
  const isFileOpen = (path: string, index: number) =>
    openFiles[path] ?? index === 0;
  const areAllOpen =
    files.length > 0 && files.every((file, i) => isFileOpen(file.path, i));

  const setOpenFiles = (next: Record<string, boolean>) => {
    setExpanded({ hash: commitHash, files: next });
  };

  const toggleAll = () => {
    setOpenFiles(
      Object.fromEntries(files.map((file) => [file.path, !areAllOpen])),
    );
  };

  return (
    <aside
      style={{ width }}
      className="border-line-soft bg-bg-1 relative flex min-h-0 shrink-0 flex-col overflow-hidden border-l"
    >
      {/* Direct child of the width-bearing element: the hook resizes the
          handle's parent unless given an explicit target. */}
      <div
        onMouseDown={handleMouseDown}
        className={clsx(
          'hover:bg-acc/50 absolute top-0 left-0 z-10 h-full w-1 cursor-col-resize transition-colors',
          isDragging && 'bg-acc/50',
        )}
      />

      <div className="border-line-soft flex shrink-0 flex-col gap-2 border-b py-3 pr-3 pl-3.5">
        <div className="flex items-center gap-2">
          <span className="border-line bg-bg-2 text-ink-1 rounded border px-1.5 py-px font-mono text-[11px]">
            {detail?.shortHash ?? commitHash.slice(0, 7)}
          </span>
          {(detail?.parents.length ?? 0) > 1 && (
            <span className="text-ink-3 inline-flex items-center gap-1 font-mono text-[10.5px]">
              <GitPullRequest size={9} />
              merge
            </span>
          )}
          <div className="flex-1" />
          <button
            type="button"
            title="Copy full hash"
            onClick={() => {
              void navigator.clipboard.writeText(detail?.hash ?? commitHash);
              setCopiedHash(commitHash);
            }}
            className="border-line bg-bg-2 text-ink-3 hover:text-ink-0 flex h-6 w-6 shrink-0 items-center justify-center rounded border transition-colors"
          >
            {didCopy ? (
              <Check size={12} className="text-status-done" />
            ) : (
              <Copy size={12} />
            )}
          </button>
          <button
            type="button"
            onClick={onClose}
            title="Close diff (Esc)"
            className="border-line bg-bg-2 text-ink-2 hover:text-ink-0 inline-flex h-6 shrink-0 items-center gap-1.5 rounded border px-2 text-[11.5px] transition-colors"
          >
            <X size={11} />
            Close
          </button>
        </div>

        <div className="text-ink-0 text-sm leading-[1.35] text-pretty">
          {detail?.subject ?? (isLoading ? 'Loading commit…' : 'Commit not found')}
        </div>

        {detail && (
          <div className="flex min-w-0 items-center gap-2">
            <span className="text-ink-2 truncate text-xs">{detail.author}</span>
            <span className="text-ink-4 font-mono text-[11px]">
              {formatRelativeTime(detail.date)}
            </span>
            <div className="flex-1" />
            <span
              title={detail.parents.join('\n')}
              className="text-ink-4 font-mono text-[10.5px] whitespace-nowrap"
            >
              {detail.parents.length > 1 ? 'parents' : 'parent'}{' '}
              {detail.parents.map((parent) => parent.slice(0, 7)).join(' ')}
            </span>
          </div>
        )}
      </div>

      {detail && (
        <div className="border-line-soft bg-bg-0 flex shrink-0 items-center gap-2.5 border-b py-[7px] pr-3 pl-3.5">
          <span className="text-ink-2 font-mono text-[11px]">
            {detail.files.length} {detail.files.length === 1 ? 'file' : 'files'}
          </span>
          <span className="text-status-done font-mono text-[11px]">
            +{detail.additions}
          </span>
          <span className="text-status-fail font-mono text-[11px]">
            −{detail.deletions}
          </span>
          <StatBar
            additions={detail.additions}
            deletions={detail.deletions}
            width={60}
          />
          <div className="flex-1" />
          {detail.files.length > 0 && (
            <button
              type="button"
              onClick={toggleAll}
              className="border-line bg-bg-2 text-ink-2 hover:text-ink-0 rounded border px-2 py-0.5 text-[11.5px] whitespace-nowrap transition-colors"
            >
              {areAllOpen ? 'Collapse all' : 'Expand all'}
            </button>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {detail?.truncated && (
          <p className="text-ink-4 border-line-soft border-b px-3.5 py-2 text-[11.5px]">
            Showing the first {detail.files.length} files of this commit.
          </p>
        )}

        {files.map((file, index) => (
          <CommitFile
            key={file.path}
            projectId={projectId}
            commitHash={commitHash}
            file={file}
            isOpen={isFileOpen(file.path, index)}
            onToggle={() =>
              setOpenFiles({
                ...openFiles,
                [file.path]: !isFileOpen(file.path, index),
              })
            }
          />
        ))}

        {detail && files.length === 0 && (
          <p className="text-ink-4 px-3.5 py-4 text-xs">
            This commit does not change any files.
          </p>
        )}
      </div>
    </aside>
  );
}
