import type { MouseEvent, ReactNode } from 'react';
import clsx from 'clsx';


type ChipSize = 'xs' | 'sm';
type ChipColor =
  | 'neutral'
  | 'green'
  | 'blue'
  | 'orange'
  | 'red'
  | 'purple'
  | 'yellow'
  | 'amber';

const sizeClasses = {
  xs: 'px-1.5 py-0.5 text-[10px]',
  sm: 'px-2 py-0.5 text-xs',
} as const;

const colorClasses: Record<
  ChipColor,
  { bg: string; text: string; hover: string }
> = {
  neutral: {
    bg: 'bg-bg-2 border border-glass-border',
    text: 'text-ink-1',
    hover: 'hover:bg-bg-3 hover:text-ink-0',
  },
  green: {
    bg: 'bg-status-done-soft border border-status-done/25',
    text: 'text-status-done',
    hover: 'hover:bg-status-done/15 hover:text-status-done',
  },
  blue: {
    bg: 'bg-status-pr-soft border border-status-pr/25',
    text: 'text-status-pr',
    hover: 'hover:bg-status-pr/15 hover:text-status-pr',
  },
  orange: {
    bg: 'bg-status-run-soft border border-status-run/25',
    text: 'text-status-run',
    hover: 'hover:bg-status-run/15 hover:text-status-run',
  },
  red: {
    bg: 'bg-status-fail-soft border border-status-fail/25',
    text: 'text-status-fail',
    hover: 'hover:bg-status-fail/15 hover:text-status-fail',
  },
  purple: {
    bg: 'bg-acc-soft border border-acc-line',
    text: 'text-acc-ink',
    hover: 'hover:bg-acc/20 hover:text-acc-ink',
  },
  yellow: {
    bg: 'bg-status-run-soft border border-status-run/25',
    text: 'text-status-run',
    hover: 'hover:bg-status-run/15 hover:text-status-run',
  },
  amber: {
    bg: 'bg-status-run-soft border border-status-run/25',
    text: 'text-status-run',
    hover: 'hover:bg-status-run/15 hover:text-status-run',
  },
} as const;

const iconSizeClasses = {
  xs: 'h-2.5 w-2.5',
  sm: 'h-3 w-3',
} as const;

export function Chip({
  size = 'sm',
  color = 'neutral',
  pill = false,
  icon,
  onClick,
  disabled,
  title,
  className,
  children,
}: {
  size?: ChipSize;
  color?: ChipColor;
  pill?: boolean;
  icon?: ReactNode;
  onClick?: (e: MouseEvent) => void;
  disabled?: boolean;
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  const c = colorClasses[color];
  const classes = clsx(
    'inline-flex max-w-full items-center gap-1 font-medium',
    sizeClasses[size],
    c.bg,
    c.text,
    pill ? 'rounded-full' : 'rounded',
    onClick && !disabled && c.hover,
    onClick && 'transition-colors',
    disabled && 'cursor-default opacity-50',
    className,
  );

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        title={title}
        className={classes}
      >
        {icon && (
          <span
            className={clsx(
              iconSizeClasses[size],
              'shrink-0 [&>svg]:h-full [&>svg]:w-full',
            )}
            aria-hidden
          >
            {icon}
          </span>
        )}
        <span className="min-w-0 truncate">{children}</span>
      </button>
    );
  }

  return (
    <span title={title} className={classes}>
      {icon && (
        <span
          className={clsx(
            iconSizeClasses[size],
            'shrink-0 [&>svg]:h-full [&>svg]:w-full',
          )}
          aria-hidden
        >
          {icon}
        </span>
      )}
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}
