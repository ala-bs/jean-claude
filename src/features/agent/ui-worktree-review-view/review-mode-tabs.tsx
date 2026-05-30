import { Select, type SelectOption } from '@/common/ui/select';
import type { ReviewMode } from '@/stores/navigation';

const formatCount = (count: number | undefined, singular: string) => {
  if (count == null) return undefined;
  return `${count} ${singular}${count === 1 ? '' : 's'}`;
};

export function ReviewModeTabs({
  activeMode,
  onModeChange,
  changedFilesCount,
  commitsCount,
  showGitModes = true,
}: {
  activeMode: ReviewMode;
  onModeChange: (mode: ReviewMode) => void;
  changedFilesCount?: number;
  commitsCount?: number;
  showGitModes?: boolean;
}) {
  const options: SelectOption<ReviewMode>[] = [
    ...(showGitModes
      ? [
          {
            value: 'changes' as const,
            label: 'Changes',
            description: formatCount(changedFilesCount, 'changed file'),
          },
        ]
      : []),
    {
      value: 'files',
      label: 'Files',
      description: showGitModes ? 'Browse worktree files' : 'Browse files',
    },
    ...(showGitModes
      ? [
          {
            value: 'commits' as const,
            label: 'Commits',
            description: formatCount(commitsCount, 'commit'),
          },
        ]
      : []),
  ];

  return (
    <Select
      value={activeMode}
      options={options}
      onChange={onModeChange}
      label="Review mode"
      size="xs"
      className="max-w-full min-w-0 justify-between"
    />
  );
}
