import clsx from 'clsx';
import type { MouseEvent } from 'react';

function workItemChipColorClass(type?: string | null): string {
  switch (type) {
    case 'Bug':
      return 'bg-status-fail/10 text-status-fail ring-status-fail/25 hover:bg-status-fail/20 hover:ring-status-fail/40';
    case 'User Story':
    case 'Feature':
      return 'bg-status-azure/10 text-status-azure ring-status-azure/25 hover:bg-status-azure/20 hover:ring-status-azure/40';
    case 'Task':
      return 'bg-status-run/10 text-status-run ring-status-run/25 hover:bg-status-run/20 hover:ring-status-run/40';
    default:
      return 'bg-status-azure/10 text-status-azure ring-status-azure/25 hover:bg-status-azure/20 hover:ring-status-azure/40';
  }
}

const sizeClasses = {
  xs: 'gap-0.5 px-1.5 py-0 font-mono text-[9.5px]',
  sm: 'gap-1 px-2 py-0.5 text-xs',
} as const;

export function WorkItemChip({
  label,
  type,
  size = 'xs',
  isFocused,
  onClick,
  disabled,
  title,
}: {
  label: string;
  type?: string | null;
  size?: keyof typeof sizeClasses;
  isFocused?: boolean;
  onClick?: (e: MouseEvent) => void;
  disabled?: boolean;
  title?: string;
}) {
  const className = clsx(
    'inline-flex max-w-full items-center rounded ring-1 transition-colors',
    sizeClasses[size],
    onClick && !disabled && 'cursor-pointer',
    disabled && 'cursor-default opacity-50',
    isFocused
      ? 'bg-acc/20 text-acc-ink ring-acc/50 shadow-[0_0_12px_color-mix(in_srgb,var(--color-acc)_40%,transparent),0_0_4px_color-mix(in_srgb,var(--color-acc)_25%,transparent)]'
      : workItemChipColorClass(type),
  );
  const content = (
    <>
      <span className="shrink-0 opacity-70">◈</span>
      <span className="min-w-0 truncate">{label}</span>
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        title={title}
        className={className}
      >
        {content}
      </button>
    );
  }

  return (
    <span title={title} className={className}>
      {content}
    </span>
  );
}
