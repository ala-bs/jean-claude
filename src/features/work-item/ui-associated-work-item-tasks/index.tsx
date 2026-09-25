import { Link } from '@tanstack/react-router';
import clsx from 'clsx';
import { useMemo } from 'react';

import type { FeedItem } from '@shared/feed-types';
import { useTaskFeedItems } from '@/hooks/use-feed';

export function selectAssociatedWorkItemTasks(
  items: FeedItem[],
  workItemId: number,
): FeedItem[] {
  const flattenedItems = items.flatMap((item) => [
    item,
    ...(item.children ?? []),
  ]);
  return flattenedItems.filter(
    (item) =>
      item.source === 'task' &&
      item.taskId &&
      item.isCompleted !== true &&
      item.workItemIds?.some(
        (associatedWorkItemId) =>
          String(associatedWorkItemId) === String(workItemId),
      ),
  );
}

export function useAssociatedWorkItemTasks(workItemId: number) {
  const query = useTaskFeedItems();
  const tasks = useMemo(
    () => selectAssociatedWorkItemTasks(query.data ?? [], workItemId),
    [query.data, workItemId],
  );

  return { ...query, tasks };
}

export function AssociatedWorkItemTasks({
  tasks,
  isLoading,
  error,
  variant = 'links',
}: {
  tasks: FeedItem[];
  isLoading: boolean;
  error: Error | null;
  variant?: 'links' | 'editorial';
}) {
  const isEditorial = variant === 'editorial';

  return (
    <section
      className={clsx(
        isEditorial
          ? 'border-glass-border border-l-acc-line bg-glass-light mt-4 rounded-lg border border-l-2 p-3 shadow-sm'
          : undefined,
      )}
    >
      <div
        className={clsx(
          'text-ink-1 flex items-center gap-2 text-xs font-medium',
          isEditorial ? 'mb-3' : 'mb-1 text-[10px] uppercase tracking-wide',
        )}
      >
        <span>Tasks</span>
        {tasks.length > 0 && (
          <span className="text-ink-3">({tasks.length})</span>
        )}
      </div>

      {error ? (
        <p role="alert" className="text-status-fail py-1 text-xs">
          Failed to load active tasks: {error.message}
        </p>
      ) : isLoading ? (
        <p className="text-ink-3 py-1 text-xs italic">Loading active tasks...</p>
      ) : tasks.length > 0 ? (
        <div className={isEditorial ? 'space-y-1' : 'flex flex-wrap gap-2'}>
          {tasks.map((task) => (
            <Link
              key={task.taskId}
              to="/all/$taskId"
              params={{ taskId: task.taskId! }}
              className={clsx(
                'border-glass-border hover:border-acc/50 hover:bg-glass-light flex min-w-0 items-center gap-1.5 rounded-md border text-xs transition-colors',
                isEditorial
                  ? 'bg-bg-1/60 w-full px-2.5 py-2'
                  : 'bg-bg-2/50 max-w-full px-2 py-1',
              )}
              title={task.title}
            >
              <span
                className={clsx(
                  'h-2 w-2 shrink-0 rounded-full',
                  task.attention === 'running'
                    ? 'bg-acc animate-pulse'
                    : task.attention === 'interrupted'
                      ? 'bg-orange-500'
                      : task.attention === 'errored'
                        ? 'bg-red-500'
                        : task.attention === 'waiting' ||
                            task.attention === 'has-question' ||
                            task.attention === 'needs-permission'
                          ? 'bg-yellow-500'
                          : 'bg-ink-3',
                )}
                title={task.attention}
              />
              <span className="min-w-0 truncate">{task.title}</span>
            </Link>
          ))}
        </div>
      ) : (
        <p className="text-ink-3 py-1 text-xs italic">
          No active tasks associated
        </p>
      )}
    </section>
  );
}
