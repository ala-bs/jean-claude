import { useMemo, useState } from 'react';
import { Check } from 'lucide-react';
import clsx from 'clsx';

import type {
  ProjectGitStatus,
  ProjectWorkingTreeFileState,
} from '@shared/types';
import { Dropdown } from '@/common/ui/dropdown';
import { useProjectWorkingTreeFiles } from '@/hooks/use-project-git';

/**
 * Buckets in display order, with the dot colour the design assigns each one.
 *
 * `untracked` counts *paths*: git collapses an untracked directory into a
 * single entry, so a new folder of 40 files reads as 1. The tooltip says so
 * because the bare number is otherwise misleading.
 */
const BUCKETS: {
  state: ProjectWorkingTreeFileState;
  label: string;
  dot: string;
  hint?: string;
}[] = [
  { state: 'staged', label: 'staged', dot: 'bg-status-done' },
  { state: 'unstaged', label: 'unstaged', dot: 'bg-status-run' },
  {
    state: 'untracked',
    label: 'untracked',
    dot: 'bg-status-review',
    hint: 'Untracked paths. An untracked directory counts once, however many files it contains.',
  },
  { state: 'conflicted', label: 'conflicted', dot: 'bg-status-fail' },
];

function countFor(
  status: ProjectGitStatus,
  state: ProjectWorkingTreeFileState,
): number {
  return status[state];
}

function FileList({
  projectId,
  state,
}: {
  projectId: string;
  state: ProjectWorkingTreeFileState;
}) {
  const { data: files, isLoading } = useProjectWorkingTreeFiles(projectId);

  const paths = useMemo(
    () => (files ?? []).filter((file) => file.state === state),
    [files, state],
  );

  if (isLoading) {
    return <p className="text-ink-3 px-3 py-2 text-xs">Loading files…</p>;
  }

  if (paths.length === 0) {
    return <p className="text-ink-3 px-3 py-2 text-xs">No files.</p>;
  }

  return (
    <ul className="max-h-[320px] min-w-[280px] overflow-y-auto py-1">
      {paths.map((file) => (
        <li
          key={file.path}
          title={file.path}
          className="text-ink-1 truncate px-3 py-1 font-mono text-[11px]"
          // Long paths matter more at the end (filename) than the start.
          dir="rtl"
        >
          <bdi>{file.path}</bdi>
        </li>
      ))}
    </ul>
  );
}

function TreeChip({
  projectId,
  state,
  label,
  dot,
  hint,
  count,
}: {
  projectId: string;
  state: ProjectWorkingTreeFileState;
  label: string;
  dot: string;
  hint?: string;
  count: number;
}) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <Dropdown
      align="left"
      side="bottom"
      onOpen={() => setIsOpen(true)}
      trigger={
        <button
          type="button"
          title={hint}
          className="border-line bg-bg-2 text-ink-1 hover:border-glass-border-strong inline-flex items-center gap-1.5 rounded-full border py-0.5 pr-2 pl-1.5 text-xs whitespace-nowrap transition-colors"
        >
          <span className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', dot)} />
          <span className="font-semibold tabular-nums">{count}</span>
          <span className="text-ink-2">{label}</span>
        </button>
      }
    >
      <div className="border-line-soft border-b px-3 py-1.5">
        <span className="text-ink-2 text-[11px] font-semibold tracking-wide uppercase">
          {count} {label}
        </span>
      </div>
      {/* Mounting the list only once opened is what keeps the query lazy. */}
      {isOpen && <FileList projectId={projectId} state={state} />}
    </Dropdown>
  );
}

export function WorkingTreeChips({
  projectId,
  status,
}: {
  projectId: string;
  status: ProjectGitStatus;
}) {
  const dirtyBuckets = BUCKETS.filter(
    (bucket) => countFor(status, bucket.state) > 0,
  );

  if (dirtyBuckets.length === 0) {
    return (
      <span className="text-ink-3 inline-flex items-center gap-1.5 text-xs whitespace-nowrap">
        <Check className="h-3 w-3 shrink-0 text-emerald-400" />
        working tree clean
      </span>
    );
  }

  return (
    <div className="flex min-w-0 items-center gap-2">
      {dirtyBuckets.map((bucket) => (
        <TreeChip
          key={bucket.state}
          projectId={projectId}
          state={bucket.state}
          label={bucket.label}
          dot={bucket.dot}
          hint={bucket.hint}
          count={countFor(status, bucket.state)}
        />
      ))}
    </div>
  );
}
