import clsx from 'clsx';
import { Zap } from 'lucide-react';

import type { ComponentSize } from '@/common/ui/styles';
import { IconButton } from '@/common/ui/icon-button';

/**
 * Toggles per-session auto-accept for a step. The flag is not persisted: it is
 * dropped when the app restarts, so it never silently outlives the session the
 * user turned it on for.
 */
export function AutoAcceptToggle({
  enabled,
  onToggle,
  disabled,
  size = 'sm',
}: {
  enabled: boolean;
  onToggle: () => void;
  disabled?: boolean;
  size?: ComponentSize;
}) {
  return (
    <IconButton
      icon={<Zap className={enabled ? 'fill-current' : undefined} />}
      size={size}
      disabled={disabled}
      onClick={onToggle}
      aria-pressed={enabled}
      tooltip={
        enabled
          ? 'Auto-accepting all permissions for this session — click to stop'
          : 'Auto-accept all permissions for this session'
      }
      className={clsx(
        enabled && 'text-amber-500 dark:text-amber-400',
        !enabled && 'text-muted-foreground',
      )}
    />
  );
}
