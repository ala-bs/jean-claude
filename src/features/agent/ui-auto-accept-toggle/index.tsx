import clsx from 'clsx';
import { Zap } from 'lucide-react';

import type { ComponentSize } from '@/common/ui/styles';
import { IconButton } from '@/common/ui/icon-button';

/**
 * Toggles auto-accept for a step. The flag stays on across turns until the user
 * turns it off; it is not persisted, so it is also dropped when the app
 * restarts.
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
          ? 'Auto-accepting all permissions — click to stop'
          : 'Auto-accept all permissions until you turn it off'
      }
      className={clsx(
        enabled && 'text-status-run',
        !enabled && 'text-muted-foreground',
      )}
    />
  );
}
