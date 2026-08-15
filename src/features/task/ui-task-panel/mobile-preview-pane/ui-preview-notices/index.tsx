import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import clsx from 'clsx';

export type PreviewNoticeTone = 'error' | 'warn' | 'info';

const toneClasses: Record<PreviewNoticeTone, string> = {
  error: 'border-status-fail/30 bg-status-fail/10 text-status-fail',
  warn: 'border-status-warn/30 bg-status-warn/10 text-status-warn',
  info: 'border-line-soft bg-bg-1 text-ink-3',
};

/**
 * Floating container for preview notices.
 *
 * Notices overlay the pane instead of sitting in the flex column: as in-flow
 * siblings they stole height from the `flex-1` content, so every appearance
 * resized the preview surface and shifted the rail and inspector.
 *
 * Anchored to the bottom rather than the top on purpose — the top of the pane
 * holds the action tray (deeplink input and its buttons), which is exactly what
 * `setInputNotice` reports errors about. Covering it would hide the control the
 * user needs to correct.
 *
 * The container itself is click-through; each notice re-enables pointer events
 * so its dismiss/retry controls still work.
 */
export function PreviewNoticeStack({
  children,
  insetLeft = false,
}: {
  children: ReactNode;
  /** Keep clear of the pane's drag-to-resize handle on the left edge. */
  insetLeft?: boolean;
}) {
  return (
    <div
      className={clsx(
        'pointer-events-none absolute right-0 bottom-0 z-20 flex flex-col gap-1 p-1.5',
        insetLeft ? 'left-1.5' : 'left-0',
      )}
    >
      {children}
    </div>
  );
}

export function PreviewNotice({
  tone,
  role = 'status',
  icon,
  children,
  action,
  onDismiss,
}: {
  tone: PreviewNoticeTone;
  role?: 'alert' | 'status';
  icon?: ReactNode;
  children: ReactNode;
  action?: ReactNode;
  onDismiss?: () => void;
}) {
  return (
    <div
      role={role}
      className={clsx(
        'pointer-events-auto flex items-center gap-2 rounded-md border px-3 py-1.5 font-mono text-[10.5px] shadow-lg backdrop-blur-sm',
        toneClasses[tone],
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 break-words">{children}</span>
      {action}
      {onDismiss ? (
        <button
          type="button"
          className="shrink-0 opacity-70 transition-opacity hover:opacity-100"
          aria-label="Dismiss notice"
          onClick={onDismiss}
        >
          <X className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}
