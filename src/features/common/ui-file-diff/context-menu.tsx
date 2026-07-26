import { useEffect, useRef } from 'react';
import clsx from 'clsx';
import { createPortal } from 'react-dom';

export type ContextMenuItem =
  | { separator: true }
  | {
      separator?: false;
      label: string;
      hint?: string;
      danger?: boolean;
      disabled?: boolean;
      onSelect: () => void;
    };

const MENU_WIDTH = 220;
const ITEM_HEIGHT = 26;

/** Lightweight right-click menu anchored at a viewport position. */
export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    // Deferred so the click that opened the menu doesn't immediately close it.
    const timer = window.setTimeout(
      () => window.addEventListener('mousedown', onPointerDown),
      0,
    );
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  const height = items.length * ITEM_HEIGHT + 8;
  const left = Math.max(8, Math.min(x, window.innerWidth - MENU_WIDTH - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - height - 8));

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      className="bg-bg-2 border-glass-border fixed z-[70] rounded-md border p-1 shadow-[0_14px_36px_rgba(0,0,0,0.5)]"
      style={{ left, top, width: MENU_WIDTH }}
    >
      {items.map((item, index) =>
        item.separator ? (
          <div
            key={`sep-${index}`}
            className="bg-glass-border mx-0.5 my-1 h-px"
          />
        ) : (
          <button
            key={`${index}-${item.label}`}
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              item.onSelect();
              onClose();
            }}
            className={clsx(
              'flex h-[26px] w-full items-center gap-2 rounded px-2 text-left text-xs transition-colors',
              item.disabled
                ? 'text-ink-4 cursor-default opacity-50'
                : item.danger
                  ? 'text-status-fail hover:bg-glass-medium'
                  : 'text-ink-1 hover:bg-glass-medium',
            )}
          >
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            {item.hint && (
              <span className="text-ink-4 shrink-0 font-mono text-[9.5px]">
                {item.hint}
              </span>
            )}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
