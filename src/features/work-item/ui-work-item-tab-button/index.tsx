import type { ReactNode } from 'react';

/**
 * Underlined tab button with an optional count pill, shared by the feed detail
 * modal and the work item preview. `count` is optional (the preview passes
 * nothing for count-less tabs); `dense` keeps the preview's tighter padding.
 */
export function WorkItemTabButton({
  active,
  onClick,
  icon,
  label,
  count,
  dense = false,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
  count?: number;
  dense?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1.5 border-b-2 px-3 text-xs font-medium transition-colors ${
        dense ? 'py-1.5' : 'py-2'
      } ${
        active
          ? 'border-accent-1 text-ink-1'
          : 'text-ink-3 hover:text-ink-2 border-transparent'
      }`}
    >
      {icon}
      {label}
      {count != null && count > 0 && (
        <span
          className={`ml-0.5 rounded-full px-1.5 py-0.5 text-[10px] ${
            active ? 'bg-accent-1/10 text-accent-1' : 'bg-ink-4/20 text-ink-3'
          }`}
        >
          {count}
        </span>
      )}
    </button>
  );
}
