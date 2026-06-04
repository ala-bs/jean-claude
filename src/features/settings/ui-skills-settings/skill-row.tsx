import clsx from 'clsx';
import { Wand2 } from 'lucide-react';
import type { ReactNode } from 'react';

import {
  ListGroupHeader,
  ListItemButton,
} from '@/common/ui/list-detail-layout';

export function SkillRow({
  label,
  isActive,
  isEnabled = true,
  suffix,
  onClick,
}: {
  label: string;
  isActive: boolean;
  isEnabled?: boolean;
  suffix?: ReactNode;
  onClick: () => void;
}) {
  return (
    <ListItemButton
      label={label}
      isActive={isActive}
      isDimmed={!isEnabled}
      size="compact"
      onClick={onClick}
      renderIcon={({ isActive: active, isDimmed }) => (
        <Wand2
          size={14}
          className={clsx(
            'shrink-0',
            isDimmed
              ? 'text-ink-4 opacity-60'
              : active
                ? 'text-acc'
                : 'text-acc-ink',
          )}
        />
      )}
      suffix={suffix}
    />
  );
}

export function GroupHeader({
  label,
  accent,
}: {
  label: string;
  accent?: boolean;
}) {
  return <ListGroupHeader label={label} accent={accent} />;
}
