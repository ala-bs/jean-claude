import { AlertTriangle, Check, FileDiff, FilePlus, FileUp } from 'lucide-react';
import clsx from 'clsx';

import type { ProjectGitStatus } from '@shared/types';

function Count({
  label,
  value,
  icon,
  tone,
  hint,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
  tone: 'neutral' | 'danger';
  hint?: string;
}) {
  return (
    <div
      title={hint}
      className={clsx(
        'border-line-soft flex items-center gap-2 rounded-lg border px-3 py-2',
        tone === 'danger' && value > 0 && 'border-red-500/40 bg-red-500/5',
      )}
    >
      <span
        className={clsx(
          'h-3.5 w-3.5 shrink-0',
          tone === 'danger' && value > 0 ? 'text-red-400' : 'text-ink-3',
          '[&>svg]:h-full [&>svg]:w-full',
        )}
      >
        {icon}
      </span>
      <span className="text-ink-0 text-sm font-medium tabular-nums">
        {value}
      </span>
      <span className="text-ink-2 truncate text-xs">{label}</span>
    </div>
  );
}

export function WorkingTreeSummary({ status }: { status: ProjectGitStatus }) {
  const isClean =
    status.staged === 0 &&
    status.unstaged === 0 &&
    status.untracked === 0 &&
    status.conflicted === 0;

  if (isClean) {
    return (
      <div className="border-line-soft text-ink-2 flex items-center gap-2 rounded-lg border px-3 py-2 text-xs">
        <Check className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
        Working tree clean
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <Count
        label="staged"
        value={status.staged}
        icon={<FileUp />}
        tone="neutral"
      />
      <Count
        label="unstaged"
        value={status.unstaged}
        icon={<FileDiff />}
        tone="neutral"
      />
      <Count
        // git collapses an untracked directory into a single entry, so this
        // counts paths rather than files — a new folder of 40 files reads as 1.
        label="untracked paths"
        hint="Untracked paths. An untracked directory counts once, however many files it contains."
        value={status.untracked}
        icon={<FilePlus />}
        tone="neutral"
      />
      <Count
        label="conflicted"
        value={status.conflicted}
        icon={<AlertTriangle />}
        tone="danger"
      />
    </div>
  );
}
