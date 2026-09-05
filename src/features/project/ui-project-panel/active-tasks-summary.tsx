import clsx from 'clsx';
import { GitBranch } from 'lucide-react';
import { Link } from '@tanstack/react-router';
import { useMemo } from 'react';

import { useProjectTasks } from '@/hooks/use-tasks';

const ACTIVE_TASK_STATUSES = new Set(['running', 'waiting', 'interrupted']);
const MAX_LISTED_TASKS = 8;

export function ActiveTasksSummary({ projectId }: { projectId: string }) {
  const { data: tasks } = useProjectTasks(projectId);

  const activeTasks = useMemo(
    () =>
      (tasks ?? []).filter(
        (task) => !task.userCompleted && ACTIVE_TASK_STATUSES.has(task.status),
      ),
    [tasks],
  );

  if (activeTasks.length === 0) {
    return (
      <p className="border-line-soft text-ink-3 rounded-lg border px-3 py-2 text-xs">
        No active tasks.
      </p>
    );
  }

  return (
    <ul className="border-line-soft divide-line-soft divide-y overflow-hidden rounded-lg border">
      {activeTasks.slice(0, MAX_LISTED_TASKS).map((task) => (
        <li key={task.id}>
          <Link
            to="/all/$taskId"
            params={{ taskId: task.id }}
            className="hover:bg-glass-light flex items-center gap-2 px-3 py-1.5 transition-colors"
          >
            <span
              className={clsx(
                'h-1.5 w-1.5 shrink-0 rounded-full',
                task.status === 'running'
                  ? 'bg-emerald-400'
                  : task.status === 'interrupted'
                    ? 'bg-amber-400'
                    : 'bg-ink-3',
              )}
            />
            <span className="text-ink-1 min-w-0 flex-1 truncate text-xs">
              {task.name || task.prompt}
            </span>
            {task.branchName && (
              <span className="text-ink-3 flex shrink-0 items-center gap-1 font-mono text-[11px]">
                <GitBranch className="h-3 w-3" />
                {task.branchName}
              </span>
            )}
          </Link>
        </li>
      ))}
      {activeTasks.length > MAX_LISTED_TASKS && (
        <li className="text-ink-3 px-3 py-1.5 text-[11px]">
          +{activeTasks.length - MAX_LISTED_TASKS} more
        </li>
      )}
    </ul>
  );
}
