import { Bug, Clipboard, Shield } from 'lucide-react';
import type { MouseEvent, ReactNode } from 'react';
import { startTransition, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';



import type {
  NormalizedEntry,
  NormalizedToolUse,
  ToolUseByName,
} from '@shared/normalized-message-v2';
import { useRegisterKeyboardBindings } from '@/common/context/keyboard-bindings';
import { useRegisterOverlay } from '@/common/context/overlay';


export interface ContextMenuItem {
  label: string;
  icon: ReactNode;
  onClick: () => void;
}

interface ContextMenuState {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

export function useMessageContextMenu(
  options: { overlayId?: string } = {},
) {
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const overlayId = options.overlayId ?? 'message-context-menu';

  const close = useCallback(() => setMenu(null), []);

  const openMenu = useCallback((e: MouseEvent, items: ContextMenuItem[]) => {
    if (items.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, items });
  }, []);

  useRegisterOverlay({
    id: overlayId,
    refs: [menuRef],
    onClose: close,
    enabled: !!menu,
  });

  useRegisterKeyboardBindings(
    overlayId,
    {
      escape: () => {
        close();
        return true;
      },
    },
    { enabled: !!menu },
  );

  // Adjust position so menu doesn't overflow viewport
  const [adjustedPos, setAdjustedPos] = useState<{
    x: number;
    y: number;
  } | null>(null);

  useEffect(() => {
    if (!menu) {
      startTransition(() => setAdjustedPos(null));
      return;
    }
    const frame = requestAnimationFrame(() => {
      const el = menuRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      let { x, y } = menu;
      if (x + rect.width > window.innerWidth) {
        x = window.innerWidth - rect.width - 4;
      }
      if (y + rect.height > window.innerHeight) {
        y = window.innerHeight - rect.height - 4;
      }
      setAdjustedPos({ x, y });
    });
    return () => cancelAnimationFrame(frame);
  }, [menu]);

  const portal =
    menu &&
    createPortal(
      <div
        ref={menuRef}
        role="menu"
        className="bg-bg-1 border-glass-border fixed z-50 min-w-48 overflow-y-auto rounded-xl border py-1 shadow-lg"
        style={{
          left: adjustedPos?.x ?? menu.x,
          top: adjustedPos?.y ?? menu.y,
          visibility: adjustedPos ? 'visible' : 'hidden',
        }}
      >
        {menu.items.map((item) => (
          <button
            key={item.label}
            role="menuitem"
            tabIndex={-1}
            onClick={() => {
              item.onClick();
              close();
            }}
            className="text-ink-1 hover:bg-glass-medium focus:bg-glass-medium flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors focus:outline-none"
          >
            <span className="h-3.5 w-3.5 shrink-0 [&>svg]:h-full [&>svg]:w-full">
              {item.icon}
            </span>
            <span className="flex-1">{item.label}</span>
          </button>
        ))}
      </div>,
      document.body,
    );

  return { openMenu, portal };
}

// Pre-built item factories

export function showRawMessageItem(
  onShowRawMessage: (entryId: string) => void,
  entryId: string,
): ContextMenuItem {
  return {
    label: 'Show in Raw Messages',
    icon: <Bug />,
    onClick: () => onShowRawMessage(entryId),
  };
}

export function addBashToPermissionsItem(
  onAdd: (command: string) => void,
  command: string,
): ContextMenuItem {
  return {
    label: 'Add to permissions\u2026',
    icon: <Shield />,
    onClick: () => onAdd(command),
  };
}

/**
 * Extract copyable text from a normalized entry.
 * Currently scoped to user prompts and assistant messages only.
 */
function getEntryText(entry: NormalizedEntry): string | null {
  switch (entry.type) {
    case 'user-prompt':
      return entry.value;
    case 'assistant-message':
      return entry.value;
    case 'todo-update':
      return entry.newTodos
        .map((todo) => `[${todo.status}] ${todo.content}`)
        .join('\n');
    case 'file-edited':
      return entry.filePath;
    case 'session-summary':
      return `${entry.title ?? 'Session'}: ${entry.summary.files} files, +${entry.summary.additions}, -${entry.summary.deletions}`;
    default:
      return null;
  }
}

export function copyToClipboardItem(
  entry: NormalizedEntry,
): ContextMenuItem | null {
  const text = getEntryText(entry)?.trim();
  if (!text) return null;
  return {
    label: 'Copy to clipboard',
    icon: <Clipboard />,
    onClick: () => {
      navigator.clipboard.writeText(text).catch(() => {});
    },
  };
}

function formatToolInput(toolUse: NormalizedToolUse): string {
  switch (toolUse.name) {
    case 'bash':
      return (toolUse as ToolUseByName<'bash'>).input.command;
    case 'read':
      return (toolUse as ToolUseByName<'read'>).input.filePath;
    case 'write': {
      const input = toolUse as ToolUseByName<'write'>;
      return input.input.files && input.input.files.length > 1
        ? input.input.files.map((file) => file.filePath).join('\n')
        : `${input.input.filePath}\n${input.input.value}`;
    }
    case 'edit': {
      const input = toolUse as ToolUseByName<'edit'>;
      return input.input.files && input.input.files.length > 1
        ? input.input.files.map((file) => file.filePath).join('\n')
        : `${input.input.filePath}\n-${input.input.oldString}\n+${input.input.newString}`;
    }
    case 'grep':
      return (toolUse as ToolUseByName<'grep'>).input.pattern;
    case 'glob':
      return (toolUse as ToolUseByName<'glob'>).input.pattern;
    case 'web-search':
      return (toolUse as ToolUseByName<'web-search'>).input.query;
    case 'web-fetch':
      return (toolUse as ToolUseByName<'web-fetch'>).input.url;
    case 'skill':
      return (toolUse as ToolUseByName<'skill'>).skillName;
    default:
      return JSON.stringify(toolUse.input, null, 2) ?? '';
  }
}

function formatToolResult(toolUse: NormalizedToolUse): string {
  const result = toolUse.result;
  if (result === undefined || result === null) return '';
  if (
    toolUse.name === 'bash' &&
    typeof result === 'object' &&
    'content' in result &&
    typeof result.content === 'string'
  ) {
    return result.content;
  }
  return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
}

function copyTextItem(label: string, text: string): ContextMenuItem | null {
  const trimmedText = text.trim();
  if (!trimmedText) return null;
  return {
    label,
    icon: <Clipboard />,
    onClick: () => navigator.clipboard.writeText(trimmedText).catch(() => {}),
  };
}

export function copyToolInputItem(
  toolUse: NormalizedToolUse,
): ContextMenuItem | null {
  return copyTextItem('Copy input', formatToolInput(toolUse));
}

export function copyToolResultItem(
  toolUse: NormalizedToolUse,
): ContextMenuItem | null {
  return copyTextItem('Copy result', formatToolResult(toolUse));
}
