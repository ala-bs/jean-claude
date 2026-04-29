import clsx from 'clsx';
import { Trash2, X } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';

import { Button } from '@/common/ui/button';
import { IconButton } from '@/common/ui/icon-button';
import { Separator } from '@/common/ui/separator';
import { useHorizontalResize } from '@/hooks/use-horizontal-resize';
import { useProjectCommands } from '@/hooks/use-project-commands';
import { api } from '@/lib/api';
import { useCommandLogsPaneWidth } from '@/stores/navigation';
import { useTaskMessagesStore } from '@/stores/task-messages';
import type { RunStatus } from '@shared/run-command-types';

import { TASK_PANEL_HEADER_HEIGHT_CLS } from '../constants';

import { AnsiLine } from './ansi-line';

/**
 * Convert a keyboard event to the terminal escape sequence the PTY expects.
 * Returns null for keys that should not be forwarded (e.g. modifier-only,
 * browser shortcuts like Cmd+C for copy, Cmd+V for paste).
 */
function keyEventToTerminalInput(e: KeyboardEvent): string | null {
  const { key, ctrlKey, metaKey, altKey } = e;

  // Let browser handle Cmd+key shortcuts (copy, paste, etc.)
  if (metaKey) return null;

  // Ctrl+<letter> → control character (0x01–0x1A)
  if (ctrlKey && key.length === 1 && /[a-zA-Z]/.test(key)) {
    const code = key.toLowerCase().charCodeAt(0) - 96; // a=1, b=2, c=3...
    return String.fromCharCode(code);
  }

  // Special keys → terminal escape sequences
  switch (key) {
    case 'Enter':
      return '\r';
    case 'Backspace':
      return '\x7f';
    case 'Tab':
      return '\t';
    case 'Escape':
      return '\x1b';
    case 'ArrowUp':
      return '\x1b[A';
    case 'ArrowDown':
      return '\x1b[B';
    case 'ArrowRight':
      return '\x1b[C';
    case 'ArrowLeft':
      return '\x1b[D';
    case 'Home':
      return '\x1b[H';
    case 'End':
      return '\x1b[F';
    case 'Delete':
      return '\x1b[3~';
    case 'PageUp':
      return '\x1b[5~';
    case 'PageDown':
      return '\x1b[6~';

    // Modifier-only or unhandled special keys — don't send
    case 'Shift':
    case 'Control':
    case 'Alt':
    case 'Meta':
    case 'CapsLock':
    case 'NumLock':
    case 'ScrollLock':
      return null;

    // Function keys
    case 'F1':
      return '\x1bOP';
    case 'F2':
      return '\x1bOQ';
    case 'F3':
      return '\x1bOR';
    case 'F4':
      return '\x1bOS';
    case 'F5':
      return '\x1b[15~';
    case 'F6':
      return '\x1b[17~';
    case 'F7':
      return '\x1b[18~';
    case 'F8':
      return '\x1b[19~';
    case 'F9':
      return '\x1b[20~';
    case 'F10':
      return '\x1b[21~';
    case 'F11':
      return '\x1b[23~';
    case 'F12':
      return '\x1b[24~';

    default:
      break;
  }

  // Alt+<char> → ESC prefix
  if (altKey && key.length === 1) {
    return `\x1b${key}`;
  }

  // Printable character (single char keys like "i", "a", "1", " ", etc.)
  if (key.length === 1) {
    return key;
  }

  // Unhandled special key — don't send
  return null;
}

export function CommandLogsPane({
  taskId,
  projectId,
  selectedCommandId,
  onSelectCommand,
  onClose,
}: {
  taskId: string;
  projectId: string;
  selectedCommandId: string | null;
  onSelectCommand: (commandId: string | null) => void;
  onClose: () => void;
}) {
  const { data: commands = [] } = useProjectCommands(projectId);
  const runCommandLogs =
    useTaskMessagesStore((state) => state.runCommandLogs[taskId]) ?? {};
  const clearRunCommandLogs = useTaskMessagesStore(
    (state) => state.clearRunCommandLogs,
  );
  const [status, setStatus] = useState<RunStatus | null>(null);

  useEffect(() => {
    api.runCommands.getStatus(taskId).then(setStatus);

    const unsubscribe = api.runCommands.onStatusChange(
      (changedTaskId, nextStatus) => {
        if (changedTaskId === taskId) {
          setStatus(nextStatus);
        }
      },
    );

    return unsubscribe;
  }, [taskId]);

  const runningCommandIds = useMemo(
    () =>
      new Set(
        (status?.commands ?? [])
          .filter((entry) => entry.status === 'running')
          .map((entry) => entry.id),
      ),
    [status],
  );

  const tabs = commands.filter(
    (command) =>
      (runCommandLogs[command.id]?.lines.length ?? 0) > 0 ||
      runningCommandIds.has(command.id),
  );

  const activeCommandId =
    selectedCommandId && tabs.some((tab) => tab.id === selectedCommandId)
      ? selectedCommandId
      : (tabs[0]?.id ?? null);
  const activeLog = activeCommandId ? runCommandLogs[activeCommandId] : null;
  const isActiveRunning = !!(
    activeCommandId && runningCommandIds.has(activeCommandId)
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Consider "at bottom" if within 32px of the bottom
    isAtBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 32;
  }, []);

  // Auto-scroll to bottom when new log lines arrive (if user was at bottom)
  const lineCount = activeLog?.lines.length ?? 0;
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && isAtBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [lineCount, activeCommandId]);

  // Forward raw keystrokes to the PTY when the log area is focused
  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (!activeCommandId || !isActiveRunning) return;

      const input = keyEventToTerminalInput(e);
      if (input === null) return;

      // Prevent browser defaults for forwarded keys (e.g. Tab, arrow keys, space scroll)
      e.preventDefault();

      api.runCommands.sendInput({
        taskId,
        runCommandId: activeCommandId,
        input,
      });
    },
    [taskId, activeCommandId, isActiveRunning],
  );

  // Auto-focus the log area when a running command becomes active
  useEffect(() => {
    if (isActiveRunning && scrollRef.current) {
      scrollRef.current.focus();
    }
  }, [activeCommandId, isActiveRunning]);

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
      style={{ width }}
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
        <div className="flex items-center gap-1">
          <IconButton
            onClick={() => {
              if (activeCommandId) clearRunCommandLogs(taskId, activeCommandId);
            }}
            size="sm"
            icon={<Trash2 />}
            tooltip="Clear logs"
          />
          <IconButton
            onClick={onClose}
            size="sm"
            icon={<X />}
            tooltip="Close"
          />
        </div>
      </div>
      <Separator />

      {tabs.length > 0 ? (
        <>
          <div className="flex shrink-0 gap-1 overflow-x-auto px-2 py-2">
            {tabs.map((tab) => (
              <Button
                key={tab.id}
                type="button"
                onClick={() => onSelectCommand(tab.id)}
                className={clsx(
                  'max-w-64 truncate rounded px-2.5 py-1 text-xs font-medium transition-colors',
                  activeCommandId === tab.id
                    ? 'bg-acc text-ink-0'
                    : 'text-ink-1 bg-bg-1 hover:bg-glass-medium',
                )}
                title={tab.command}
              >
                {tab.command}
              </Button>
            ))}
          </div>
          <Separator />

          <div
            ref={scrollRef}
            tabIndex={0}
            onScroll={handleScroll}
            onKeyDown={handleKeyDown}
            style={{
              fontFamily:
                'var(--font-mono), "Apple Symbols", "Segoe UI Symbol", "Noto Sans Symbols", "Noto Sans Symbols 2", sans-serif',
            }}
            className={clsx(
              'flex-1 overflow-auto px-3 py-2 text-xs leading-relaxed focus:outline-none',
              isActiveRunning && 'cursor-text',
            )}
          >
            {activeLog?.lines.map((entry, index) => (
              <div
                key={`${entry.timestamp}-${index}`}
                className="text-ink-1 break-words whitespace-pre-wrap"
              >
                <AnsiLine line={entry.line} />
              </div>
            ))}
          </div>

          {isActiveRunning && (
            <div className="border-glass-border text-ink-3 border-t px-3 py-1 text-center text-xs">
              Terminal input active — keystrokes are forwarded to the process
            </div>
          )}
        </>
      ) : (
        <div className="text-ink-3 flex flex-1 items-center justify-center px-4 text-sm">
          Run a command to see logs.
        </div>
      )}
    </div>
  );
}
