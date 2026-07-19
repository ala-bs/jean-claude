import { useCurrentVisibleProject, useSidebarWidth } from '@/stores/navigation';
import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { createRafScheduler } from '@/lib/raf-scheduler';
import { FeedList } from '@/features/feed/ui-feed-list';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { TaskList } from '@/features/task/ui-task-list';

export const MAIN_SIDEBAR_HEADER_HEIGHT = 48;

export function MainSidebar() {
  const { projectId } = useCurrentVisibleProject();
  const { width, setWidth, minWidth, maxWidth } = useSidebarWidth();
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => () => dragCleanupRef.current?.(), []);

  const handleMouseDown = (e: ReactMouseEvent<HTMLDivElement>) => {
    e.preventDefault();
      setIsDragging(true);

      const startX = e.clientX;
      const startWidth = width;
      const target = e.currentTarget.parentElement;
      let latestWidth: number | null = null;
      const updateWidth = createRafScheduler((newWidth: number) => {
        latestWidth = newWidth;
        if (target) target.style.width = `${newWidth}px`;
      });

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const delta = moveEvent.clientX - startX;
        const newWidth = Math.min(
          Math.max(startWidth + delta, minWidth),
          maxWidth,
        );
        updateWidth.schedule(newWidth);
      };

      const handleMouseUp = () => {
        updateWidth.flush();
        if (latestWidth !== null) setWidth(latestWidth);
        setIsDragging(false);
        dragCleanupRef.current?.();
      };
      const handleWindowBlur = () => handleMouseUp();

      dragCleanupRef.current = () => {
        updateWidth.cancel();
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
        window.removeEventListener('blur', handleWindowBlur);
        dragCleanupRef.current = null;
      };
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      window.addEventListener('blur', handleWindowBlur);
  };

  return (
    <aside
      className={clsx(
        'bg-glass-subtle border-glass-border relative flex h-full shrink-0 flex-col border-r backdrop-blur-xl backdrop-saturate-[130%]',
        isDragging && 'select-none',
      )}
      style={{ width }}
    >
      {/* Feed list for "all" view, task list for project view */}
      {projectId === 'all' ? <FeedList /> : <TaskList />}

      {/* Resize handle */}
      <div
        onMouseDown={handleMouseDown}
        className={clsx(
          'hover:bg-acc/50 absolute top-0 right-0 h-full w-0.5 cursor-col-resize transition-all duration-150 hover:w-1',
          isDragging && 'bg-acc/50 w-1',
        )}
      />
    </aside>
  );
}
