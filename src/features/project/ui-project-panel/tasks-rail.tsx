import clsx from 'clsx';
import { GitBranch } from 'lucide-react';
import { Link } from '@tanstack/react-router';
import { useMemo } from 'react';

import { formatRelativeTime } from '@/lib/time';
import { getTaskPromptPreview } from '@/lib/task-prompt-preview';
import type { Task } from '@shared/types';
import { useHorizontalResize } from '@/hooks/use-horizontal-resize';
import { useProjectTasks } from '@/hooks/use-tasks';
import { useTasksRailWidth } from '@/stores/navigation';

const ACTIVE_TASK_STATUSES = new Set<Task['status']>([
  'running',
  'waiting',
  'interrupted',
]);

/** Task branches are namespaced by project; the prefix is noise in this list. */
function shortBranch(branchName: string): string {
  const slash = branchName.indexOf('/');
  return slash === -1 ? branchName : branchName.slice(slash + 1);
}

function TaskRow({ task }: { task: Task }) {
  return (
    <Link
      to="/all/$taskId"
      params={{ taskId: task.id }}
      className="hover:bg-glass-light grid grid-cols-[10px_1fr] items-start gap-2.5 rounded px-2.5 py-2 transition-colors"
    >
      <span
        className={clsx(
          'mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full',
          task.status === 'running'
            ? 'bg-emerald-400'
            : task.status === 'interrupted'
              ? 'bg-amber-400'
              : 'bg-ink-3',
        )}
      />
      <div className="min-w-0">
        <div className="flex items-baseline gap-2">
          <div className="text-ink-1 min-w-0 flex-1 truncate text-[13px]">
            {task.name || getTaskPromptPreview(task.prompt)}
          </div>
          <div className="text-ink-4 shrink-0 font-mono text-[11px]">
            {formatRelativeTime(task.updatedAt)}
          </div>
        </div>
        {task.branchName && (
          <div className="text-ink-4 mt-0.5 flex min-w-0 items-center gap-1.5 font-mono text-[11px]">
            <GitBranch size={10} className="shrink-0" />
            <span className="truncate" title={task.branchName}>
              {shortBranch(task.branchName)}
            </span>
          </div>
        )}
      </div>
    </Link>
  );
}

export function TasksRail({ projectId }: { projectId: string }) {
  const { data: tasks } = useProjectTasks(projectId);

  const activeTasks = useMemo(
    () =>
      (tasks ?? []).filter(
        (task) => !task.userCompleted && ACTIVE_TASK_STATUSES.has(task.status),
      ),
    [tasks],
  );

  // `waiting` is the queue: the agent is not working, it needs the user.
  const runningCount = activeTasks.filter(
    (task) => task.status === 'running',
  ).length;

  // Tracked separately from the commit diff pane: the two occupy the same slot
  // but are read very differently, so a width that suits a diff is not the one
  // that suits a task list.
  const { width, setWidth, minWidth, maxWidth } = useTasksRailWidth();
  const { isDragging, handleMouseDown } = useHorizontalResize({
    initialWidth: width,
    minWidth,
    maxWidth,
    maxWidthFraction: 0.7,
    // The handle sits on the rail's left edge, so dragging left grows it.
    direction: 'left',
    onWidthChange: setWidth,
  });

  return (
    <aside
      style={{ width }}
      className="border-line-soft bg-bg-0 relative flex shrink-0 flex-col border-l"
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

      <div className="flex items-center gap-2 px-4 pt-3.5 pb-2">
        <h3 className="text-ink-2 text-[11px] font-semibold tracking-wide uppercase">
          Active tasks
        </h3>
        {activeTasks.length > 0 && (
          <span className="text-ink-4 font-mono text-[11px] whitespace-nowrap">
            {runningCount} running · {activeTasks.length - runningCount} waiting
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3.5">
        {activeTasks.length === 0 ? (
          <p className="text-ink-3 px-2.5 py-2 text-xs">No active tasks.</p>
        ) : (
          activeTasks.map((task) => <TaskRow key={task.id} task={task} />)
        )}
      </div>
    </aside>
  );
}
