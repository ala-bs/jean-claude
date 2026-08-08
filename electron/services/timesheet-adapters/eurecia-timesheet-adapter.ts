import type {
  TimesheetBuildDraftInput,
  TimesheetDraftItem,
  TimesheetDraftResult,
  TimesheetEntryDraft,
  TimesheetSyncParams,
  TimesheetSyncResult,
} from '@shared/timesheet-types';
import type { WorkActivityEvent } from '@shared/work-activity-types';

import type { TimesheetAdapter } from './types';

function getDateKey(iso: string) {
  return new Date(iso).toISOString().slice(0, 10);
}

function formatEventType(type: WorkActivityEvent['type']) {
  if (type === 'task_prompted') return 'task prompt';
  if (type === 'pr_comment_added') return 'PR comment';
  return 'PR approval';
}

function getEventLabel(event: WorkActivityEvent) {
  if (event.taskTitle) return event.taskTitle;
  if (event.pullRequest?.title) return event.pullRequest.title;
  if (event.promptSnippet) return event.promptSnippet;
  return formatEventType(event.type);
}

function getPrimaryWorkItem(event: WorkActivityEvent) {
  const workItem = event.workItems[0];
  if (workItem) {
    return {
      id: workItem.id,
      title: workItem.title ?? null,
      type: workItem.workItemType ?? null,
    };
  }

  const workItemId = event.workItemIds[0];
  if (workItemId) {
    return {
      id: workItemId,
      title: null,
      type: null,
    };
  }

  return null;
}

function groupKey(event: WorkActivityEvent) {
  const workItem = getPrimaryWorkItem(event);
  return [
    getDateKey(event.occurredAt),
    event.projectId ?? 'unknown-project',
    workItem?.id ?? 'no-work-item',
  ].join(':');
}

function buildDescription(events: WorkActivityEvent[]) {
  const counts = new Map<WorkActivityEvent['type'], number>();
  for (const event of events) {
    counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
  }

  const summary = [...counts.entries()]
    .map(([type, count]) => `${count} ${formatEventType(type)}`)
    .join(', ');
  const labels = [...new Set(events.map(getEventLabel))].slice(0, 4);

  return [summary, ...labels].filter(Boolean).join('\n');
}

function toItem(events: WorkActivityEvent[]): TimesheetDraftItem {
  const first = events[0];
  const workItem = getPrimaryWorkItem(first);

  return {
    project: {
      id: first.projectId,
      name: first.projectName,
    },
    role: null,
    workItem,
    description: buildDescription(events),
    sourceEventIds: events.map((event) => event.id),
    metadata: {
      eventCount: events.length,
      azureProjectId: first.azureProjectId,
      azureOrgId: first.azureOrgId,
    },
  };
}

export const eureciaTimesheetAdapter: TimesheetAdapter = {
  provider: 'eurecia',
  displayName: 'Eurecia',

  getCapabilities() {
    return {
      provider: 'eurecia',
      displayName: 'Eurecia',
      supportsDraftEntries: true,
      supportsSync: false,
      requiresManualDuration: true,
    };
  },

  buildDraft({ events }: TimesheetBuildDraftInput): TimesheetDraftResult {
    const groups = new Map<string, WorkActivityEvent[]>();
    for (const event of events) {
      const key = groupKey(event);
      groups.set(key, [...(groups.get(key) ?? []), event]);
    }

    const itemsByDate = new Map<string, TimesheetDraftItem[]>();
    for (const group of groups.values()) {
      const sortedGroup = [...group].sort((left, right) =>
        left.occurredAt.localeCompare(right.occurredAt),
      );
      const date = getDateKey(sortedGroup[0].occurredAt);
      const items = itemsByDate.get(date) ?? [];
      items.push(toItem(sortedGroup));
      itemsByDate.set(date, items);
    }

    const entries = [...itemsByDate.entries()]
      .map(([date, items]) => {
        const first = items[0];
        return {
          id: `eurecia:${date}`,
          provider: 'eurecia' as const,
          date,
          project: first.project,
          role: first.role,
          workItem: first.workItem,
          durationMinutes: null,
          description: items.map(({ description }) => description).join('\n\n'),
          sourceEventIds: items.flatMap(({ sourceEventIds }) => sourceEventIds),
          metadata: {
            eventCount: items.reduce(
              (count, item) => count + item.sourceEventIds.length,
              0,
            ),
            childItemCount: items.length,
          },
          items,
        } satisfies TimesheetEntryDraft;
      })
      .sort(
        (left, right) => left.date.localeCompare(right.date),
      );

    return {
      provider: 'eurecia',
      displayName: 'Eurecia',
      entries,
      warnings: [
        'Eurecia API sync is not configured yet; durations and roles are manual draft fields.',
      ],
    };
  },

  async sync(_params: TimesheetSyncParams): Promise<TimesheetSyncResult> {
    return {
      provider: 'eurecia',
      status: 'not_configured',
      externalIds: [],
      message: 'Eurecia API details are not configured yet.',
    };
  },
};
