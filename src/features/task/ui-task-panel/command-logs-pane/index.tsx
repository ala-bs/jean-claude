import { type MouseEvent, useCallback, useRef } from 'react';
import clsx from 'clsx';
import { X } from 'lucide-react';

import { CommandLogsSection } from './command-logs-section';
import { focusOnNonInteractiveMouseDown } from './utils-log-pane-focus';
import { IconButton } from '@/common/ui/icon-button';
import { Separator } from '@/common/ui/separator';
import { TASK_PANEL_HEADER_HEIGHT_CLS } from '../constants';
import { useCommandLogsPaneWidth } from '@/stores/navigation';
import { useHorizontalResize } from '@/hooks/use-horizontal-resize';
import { useProjectCommandAvailability } from '@/hooks/use-project-command-availability';
import { useRunCommands } from '@/hooks/use-run-commands';

export function CommandLogsPane({
  taskId,
  projectId,
  workingDir,
  selectedCommandId,
  onSelectCommand,
  onClose,
}: {
  taskId: string;
  projectId: string;
  workingDir: string;
  selectedCommandId: string | null;
  onSelectCommand: (commandId: string | null) => void;
  onClose: () => void;
}) {
  const paneRef = useRef<HTMLDivElement>(null);
  const commandAvailability = useProjectCommandAvailability(projectId);
  const runCommands = useRunCommands({ taskId, projectId, workingDir });

  const focusPane = useCallback((event: MouseEvent) => {
    focusOnNonInteractiveMouseDown(paneRef)(event);
  }, []);

  const { width, setWidth, minWidth, maxWidth } = useCommandLogsPaneWidth();
  const { isDragging, handleMouseDown } = useHorizontalResize({
    initialWidth: width,
    minWidth,
    maxWidth,
    maxWidthFraction: 0.7,
    direction: 'left',
    onWidthChange: setWidth,
  });

  return (
    <div
      ref={paneRef}
      tabIndex={-1}
      onMouseDown={focusPane}
      style={{ width }}
      // Marks the pane so hosts that bind the same keys at panel scope (the
      // project panel binds ⌘F to commit search) can decline while focus is in
      // here and let the pane's own handler run.
      data-command-logs-pane
      className="panel-edge-shadow bg-bg-0 relative flex h-full flex-col"
    >
      <div
        onMouseDown={handleMouseDown}
        className={clsx(
          'hover:bg-acc/50 absolute top-0 left-0 z-10 h-full w-1 cursor-col-resize transition-colors',
          isDragging && 'bg-acc/50',
        )}
      />

      <div
        className={clsx(
          'flex shrink-0 items-center justify-between px-4 py-2',
          TASK_PANEL_HEADER_HEIGHT_CLS,
        )}
      >
        <h3 className="text-ink-1 text-sm font-medium">Command Logs</h3>
        <IconButton onClick={onClose} size="sm" icon={<X />} tooltip="Close" />
      </div>
      <Separator />

      <CommandLogsSection
        taskId={taskId}
        projectId={projectId}
        workingDir={workingDir}
        runCommands={runCommands}
        commandAvailability={commandAvailability}
        selectedCommandId={selectedCommandId}
        onSelectCommand={onSelectCommand}
        keyScopeRef={paneRef}
      />
    </div>
  );
}
