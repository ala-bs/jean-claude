import type { ReactElement } from 'react';

import { Tooltip } from '@/common/ui/tooltip';
import type { UpcomingMeeting } from '@shared/calendar-types';

export function OrganizerTooltip({
  meeting,
  children,
}: {
  meeting: UpcomingMeeting;
  children: ReactElement;
}) {
  if (!meeting.organizer) return children;

  return (
    <Tooltip
      side="top"
      align="left"
      minWidth={220}
      content={
        <div className="space-y-1">
          <div className="text-ink-4 text-[10px] font-semibold tracking-widest uppercase">
            Invite sender
          </div>
          <div className="text-ink-0 font-medium">{meeting.organizer}</div>
          {meeting.organizerEmail && (
            <div className="text-ink-3 font-mono text-[11px]">
              {meeting.organizerEmail}
            </div>
          )}
        </div>
      }
    >
      {children}
    </Tooltip>
  );
}
